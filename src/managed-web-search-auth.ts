import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { credentialRef, type CredentialRef } from "./credential-store.js";
import { createWindowsSystemCredentialStore, type WindowsSystemCredentialStore } from "./system-credential-store.js";

export interface SearchDeviceCredential {
  deviceId: string;
  deviceSecret: string;
}

interface SearchAuthState {
  version: 1;
  installationId: string;
  credentialRef?: CredentialRef<"web-search-device">;
  legacyCredential?: SearchDeviceCredential;
}

interface TokenResponse { accessToken: string; expiresAt: number }
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type SystemStoreFactory = () => Promise<WindowsSystemCredentialStore<SearchDeviceCredential, "web-search-device"> | undefined>;

const CREDENTIAL_ID = "search.jingran.vip:device";
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

function validCredential(value: unknown): value is SearchDeviceCredential {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SearchDeviceCredential>;
  return typeof item.deviceId === "string" && /^device_[a-f0-9]{32}$/.test(item.deviceId)
    && typeof item.deviceSecret === "string" && item.deviceSecret.length >= 32 && item.deviceSecret.length <= 256;
}

function validState(value: unknown): SearchAuthState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<SearchAuthState>;
  if (item.version !== 1 || typeof item.installationId !== "string" || !/^[a-f0-9-]{36}$/.test(item.installationId)) return undefined;
  const credentialRefValue = item.credentialRef;
  const ref = credentialRefValue?.backend === "system" && credentialRefValue.kind === "web-search-device" && credentialRefValue.id === CREDENTIAL_ID
    ? credentialRef("system", "web-search-device", CREDENTIAL_ID, credentialRefValue.revision)
    : undefined;
  return {
    version: 1,
    installationId: item.installationId,
    ...(ref ? { credentialRef: ref } : {}),
    ...(validCredential(item.legacyCredential) ? { legacyCredential: item.legacyCredential } : {}),
  };
}

async function atomicSave(filename: string, state: SearchAuthState): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await fs.rename(temporary, filename); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  try { await fs.chmod(filename, 0o600); } catch { /* Windows ACLs are managed by the user profile. */ }
}

export class ManagedWebSearchAuth {
  private state?: SearchAuthState;
  private systemStore?: WindowsSystemCredentialStore<SearchDeviceCredential, "web-search-device">;
  private token?: TokenResponse;
  private inflight?: Promise<string>;

  constructor(
    private readonly authBaseURL: string,
    private readonly filename = path.join(os.homedir(), ".xiu", "search-auth.json"),
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly createStore: SystemStoreFactory = async () => process.platform === "win32"
      ? createWindowsSystemCredentialStore("web-search-device", [CREDENTIAL_ID])
      : undefined,
  ) {}

  private async load(): Promise<SearchAuthState> {
    if (this.state) return this.state;
    try { this.state = validState(JSON.parse(await fs.readFile(this.filename, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read managed web search credentials."); }
    this.state ??= { version: 1, installationId: randomUUID() };
    return this.state;
  }

  private async store(): Promise<WindowsSystemCredentialStore<SearchDeviceCredential, "web-search-device"> | undefined> {
    if (this.systemStore) return this.systemStore;
    try { this.systemStore = await this.createStore(); }
    catch { return undefined; }
    return this.systemStore;
  }

  private async readCredential(): Promise<SearchDeviceCredential | undefined> {
    const state = await this.load();
    if (state.credentialRef) {
      const store = await this.store();
      if (store) {
        try {
          const value = store.get(state.credentialRef);
          if (validCredential(value)) return value;
        } catch { /* Fall through to a fresh registration. */ }
      }
    }
    return validCredential(state.legacyCredential) ? state.legacyCredential : undefined;
  }

  private async saveCredential(value: SearchDeviceCredential): Promise<void> {
    const state = await this.load();
    const store = await this.store();
    if (store) {
      try {
        const ref = store.set(store.ref(CREDENTIAL_ID), value);
        this.state = { version: 1, installationId: state.installationId, credentialRef: ref };
        await atomicSave(this.filename, this.state);
        return;
      } catch { /* A policy-blocked native helper uses the local compatibility store. */ }
    }
    this.state = { version: 1, installationId: state.installationId, legacyCredential: value };
    await atomicSave(this.filename, this.state);
  }

  private async clearCredential(): Promise<void> {
    const state = await this.load();
    if (state.credentialRef) {
      try { (await this.store())?.delete(state.credentialRef); } catch { /* Best effort after server revocation. */ }
    }
    this.state = { version: 1, installationId: state.installationId };
    await atomicSave(this.filename, this.state);
  }

  private async jsonRequest(endpoint: string, body: object, signal?: AbortSignal): Promise<{ status: number; value: unknown }> {
    const timeoutSignal = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS);
    const response = await this.fetchImpl(`${this.authBaseURL.replace(/\/$/, "")}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    let value: unknown;
    try { value = await response.json(); } catch { value = undefined; }
    return { status: response.status, value };
  }

  private async register(signal?: AbortSignal): Promise<SearchDeviceCredential> {
    const state = await this.load();
    const response = await this.jsonRequest("/v1/devices/register", { name: `xiu-${process.platform}-${state.installationId.slice(0, 8)}` }, signal);
    if (response.status !== 201 || !validCredential(response.value)) throw Object.assign(new Error(`Xiu Search device registration failed with HTTP ${response.status}.`), { status: response.status });
    await this.saveCredential(response.value);
    return response.value;
  }

  private async issue(credential: SearchDeviceCredential, signal?: AbortSignal): Promise<TokenResponse | undefined> {
    const response = await this.jsonRequest("/v1/tokens", credential, signal);
    if (response.status === 401) return undefined;
    const value = response.value as Partial<TokenResponse> | undefined;
    if (response.status !== 200 || typeof value?.accessToken !== "string" || !Number.isSafeInteger(value.expiresAt)) {
      throw Object.assign(new Error(`Xiu Search token request failed with HTTP ${response.status}.`), { status: response.status });
    }
    return { accessToken: value.accessToken, expiresAt: value.expiresAt! };
  }

  private async refresh(signal?: AbortSignal): Promise<string> {
    let credential = await this.readCredential() ?? await this.register(signal);
    let issued = await this.issue(credential, signal);
    if (!issued) {
      await this.clearCredential();
      credential = await this.register(signal);
      issued = await this.issue(credential, signal);
    }
    if (!issued) throw Object.assign(new Error("Xiu Search device credential was rejected."), { status: 401 });
    this.token = issued;
    return issued.accessToken;
  }

  async getBearerToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt * 1000 - this.now() > 60_000) return this.token.accessToken;
    this.inflight ??= this.refresh(signal).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
}
