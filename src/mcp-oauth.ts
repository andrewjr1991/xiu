import { randomBytes } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  auth,
  resourceUrlFromServerUrl,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { McpAuthStore, type McpAuthRecord } from "./mcp-auth-store.js";
import type { McpOAuthConfig } from "./mcp.js";
import { createSafeOAuthFetch, validateOAuthUrl } from "./oauth-url-policy.js";

const DEFAULT_CALLBACK_PORT = 53_121;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface McpOAuthInteraction {
  confirmAuthorizationServer?(authorizationServer: URL, resource: URL, details: { scopes: string[]; callback: URL }): Promise<boolean>;
  openBrowser?(url: URL): Promise<void> | void;
  authorizationUrlReady?(url: URL, opened: boolean, error?: Error): Promise<void> | void;
  signal?: AbortSignal;
  timeoutMs?: number;
  interactive?: boolean;
}

function canonicalResource(serverUrl: string): string {
  return resourceUrlFromServerUrl(serverUrl).toString();
}

async function spawnDetached(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function defaultOpenBrowser(url: URL): Promise<void> {
  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const attempts: Array<[string, string[]]> = [
      [path.join(windowsRoot, "explorer.exe"), [url.toString()]],
      [path.join(windowsRoot, "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url.toString()]],
    ];
    let failure: Error | undefined;
    for (const [command, args] of attempts) {
      try { await spawnDetached(command, args); return; }
      catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    }
    throw failure ?? new Error("No Windows URL opener is available");
  }
  await spawnDetached(process.platform === "darwin" ? "open" : "xdg-open", [url.toString()]);
}

function mergeRecord(existing: McpAuthRecord | undefined, next: McpAuthRecord): McpAuthRecord {
  return {
    ...existing,
    ...next,
    tokens: next.tokens ?? existing?.tokens,
    clientInformation: next.clientInformation ?? existing?.clientInformation,
  };
}

export class XiuMcpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: URL;
  readonly clientMetadataUrl?: string;
  readonly clientMetadata: OAuthClientMetadata;
  private verifier?: string;
  private callbackState = randomBytes(32).toString("base64url");
  private discovery?: OAuthDiscoveryState;
  private recentIssuer?: string;
  private recentClient?: StoredOAuthClientInformation;

  constructor(
    readonly serverUrl: string,
    readonly config: McpOAuthConfig,
    readonly store: McpAuthStore,
    private interaction: McpOAuthInteraction = {},
  ) {
    const port = config.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.redirectUrl = new URL(`http://127.0.0.1:${port}/oauth/callback`);
    this.clientMetadataUrl = config.clientMetadataUrl;
    this.clientMetadata = {
      client_name: "Xiu",
      application_type: "native",
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(config.scopes?.length ? { scope: config.scopes.join(" ") } : {}),
    };
  }

  state(): string { return this.callbackState; }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const issuer = ctx?.issuer ?? this.recentIssuer;
    if (this.config.clientId) return { client_id: this.config.clientId, ...(issuer ? { issuer } : {}) } as StoredOAuthClientInformation;
    if (issuer && this.recentClient) return this.recentClient;
    const matches = await this.store.find(canonicalResource(this.serverUrl), issuer);
    const withClient = matches.filter((record) => record.clientInformation);
    if (withClient.length === 1) {
      this.recentIssuer = withClient[0]!.issuer;
      this.recentClient = withClient[0]!.clientInformation;
      return this.recentClient;
    }
    return undefined;
  }

  async saveClientInformation(clientInformation: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    const issuer = ctx?.issuer ?? clientInformation.issuer;
    if (!issuer) throw new Error("OAuth client registration was not bound to an issuer");
    this.recentIssuer = issuer;
    this.recentClient = clientInformation;
    const identity = { resource: canonicalResource(this.serverUrl), issuer, clientId: clientInformation.client_id };
    await this.store.save(mergeRecord(await this.store.get(identity), { ...identity, clientInformation }));
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const issuer = ctx?.issuer ?? this.recentIssuer;
    const client = await this.clientInformation(ctx);
    const matches = await this.store.find(canonicalResource(this.serverUrl), issuer, client?.client_id);
    return matches.length === 1 ? matches[0]!.tokens : undefined;
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const issuer = ctx?.issuer ?? tokens.issuer ?? this.recentIssuer;
    const client = await this.clientInformation(issuer ? { issuer } : undefined);
    if (!issuer || !client?.client_id) throw new Error("OAuth tokens were not bound to an issuer and client");
    this.recentIssuer = issuer;
    const identity = { resource: canonicalResource(this.serverUrl), issuer, clientId: client.client_id };
    await this.store.save(mergeRecord(await this.store.get(identity), { ...identity, tokens, clientInformation: client }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interaction.interactive) throw new Error("Interactive OAuth login is required; run /mcp login");
    const checked = await validateOAuthUrl(authorizationUrl);
    const resource = new URL(this.serverUrl);
    const confirmed = await this.interaction.confirmAuthorizationServer?.(checked, resource, {
      scopes: (checked.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean),
      callback: this.redirectUrl,
    });
    if (!confirmed) throw new Error(`Authorization server ${checked.origin} was not approved for ${resource.origin}`);
    try {
      await (this.interaction.openBrowser ?? defaultOpenBrowser)(checked);
      await this.interaction.authorizationUrlReady?.(checked, true);
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      if (this.interaction.authorizationUrlReady) await this.interaction.authorizationUrlReady(checked, false, reason);
      else console.error(`Could not open a browser (${reason.message}). Open this URL manually:\n${checked.toString()}`);
    }
  }

  saveCodeVerifier(codeVerifier: string): void { this.verifier = codeVerifier; }
  codeVerifier(): string {
    if (!this.verifier) throw new Error("OAuth PKCE verifier is missing or already consumed");
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState): void { this.discovery = structuredClone(state); }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery ? structuredClone(this.discovery) : undefined; }
  saveAuthorizationServerUrl(url: string): void { this.recentIssuer = url; }
  saveResourceUrl(): void {}
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier" || scope === "all") this.verifier = undefined;
    if (scope === "discovery" || scope === "all") this.discovery = undefined;
  }

  validateCallback(url: URL): { code: string; iss?: string } {
    if (url.origin !== this.redirectUrl.origin || url.pathname !== this.redirectUrl.pathname) throw new Error("OAuth callback target did not match the registered redirect URI");
    if (url.searchParams.get("state") !== this.callbackState) throw new Error("OAuth callback state did not match or was already consumed");
    this.callbackState = "consumed";
    const oauthError = url.searchParams.get("error");
    if (oauthError) throw new Error(`OAuth authorization failed: ${oauthError}${url.searchParams.get("error_description") ? ` - ${url.searchParams.get("error_description")}` : ""}`);
    const code = url.searchParams.get("code");
    if (!code) throw new Error("OAuth callback did not include an authorization code");
    return { code, ...(url.searchParams.get("iss") ? { iss: url.searchParams.get("iss")! } : {}) };
  }
}

export async function waitForOAuthCallback(redirectUrl: URL, signal?: AbortSignal, timeoutMs = LOGIN_TIMEOUT_MS): Promise<URL> {
  if (redirectUrl.hostname !== "127.0.0.1") throw new Error("OAuth callback listener must bind to 127.0.0.1");
  return await new Promise<URL>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: URL): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (server.listening) server.close();
      if (error) reject(error); else resolve(value!);
    };
    const server = http.createServer((request, response) => {
      try {
        const url = new URL(request.url ?? "/", redirectUrl.origin);
        if (request.method !== "GET" || url.pathname !== redirectUrl.pathname) {
          response.writeHead(404).end("Not found");
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end("<!doctype html><meta charset=utf-8><title>Xiu OAuth</title><p>Authorization received. You may close this window and return to Xiu.</p>");
        finish(undefined, url);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    server.once("error", (error) => finish(new Error(`OAuth callback listener failed on ${redirectUrl.origin}: ${error.message}`)));
    const abort = (): void => finish(new Error("OAuth login was cancelled"));
    const timer = setTimeout(() => finish(new Error(`OAuth login timed out after ${Math.ceil(timeoutMs / 60_000)} minute(s)`)), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    server.listen(Number(redirectUrl.port), "127.0.0.1");
    if (signal?.aborted) abort();
  });
}

export async function loginMcpOAuth(provider: XiuMcpOAuthProvider, interaction: McpOAuthInteraction = {}): Promise<void> {
  const safeFetch = createSafeOAuthFetch();
  const callbackController = new AbortController();
  const cancelCallback = (): void => callbackController.abort();
  interaction.signal?.addEventListener("abort", cancelCallback, { once: true });
  const callback = waitForOAuthCallback(provider.redirectUrl, callbackController.signal, interaction.timeoutMs);
  // Observe early listener failures immediately while retaining the original promise for the flow below.
  void callback.catch(() => undefined);
  try {
    const result = await auth(provider, {
      serverUrl: provider.serverUrl,
      scope: provider.config.scopes?.join(" "),
      fetchFn: safeFetch,
    });
    if (result === "AUTHORIZED") return;
    const callbackUrl = await callback;
    const { code, iss } = provider.validateCallback(callbackUrl);
    const exchanged = await auth(provider, {
      serverUrl: provider.serverUrl,
      authorizationCode: code,
      iss,
      scope: provider.config.scopes?.join(" "),
      fetchFn: safeFetch,
    });
    if (exchanged !== "AUTHORIZED") throw new Error("OAuth token exchange did not complete authorization");
  } finally {
    interaction.signal?.removeEventListener("abort", cancelCallback);
    callbackController.abort();
  }
}
