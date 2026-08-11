import dns from "node:dns/promises";
import callbackDns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export interface OAuthUrlPolicyOptions {
  lookup?: typeof dns.lookup;
  allowLoopback?: boolean;
}

let sharedSafeDispatcher: Agent | undefined;

function safeDispatcher(): Agent {
  sharedSafeDispatcher ??= new Agent({
    connect: {
      lookup(hostname, lookupOptions, callback) {
        callbackDns.lookup(hostname, { ...lookupOptions, all: true, verbatim: true }, (error, addresses) => {
          if (error) return callback(error, "", 0);
          const loopback = isLoopbackHost(hostname);
          if (!loopback && addresses.some(({ address }) => isForbiddenOAuthAddress(address))) {
            return callback(new Error(`OAuth connection resolved to a forbidden address: ${hostname}`), "", 0);
          }
          if (lookupOptions.all) return callback(null, addresses as never, undefined as never);
          const selected = addresses[0];
          if (!selected) return callback(new Error(`OAuth connection could not resolve ${hostname}`), "", 0);
          callback(null, selected.address, selected.family);
        });
      },
    },
  });
  return sharedSafeDispatcher;
}

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : undefined;
}

export function isForbiddenOAuthAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isForbiddenOAuthAddress(mapped);
  if (net.isIP(address) === 4) {
    const [a, b, c] = ipv4Parts(address)!;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168))
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::" || normalized === "::1"
      || normalized.startsWith("fc") || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff")
      || normalized.startsWith("2001:db8:");
  }
  return true;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export async function validateOAuthUrl(value: string | URL, options: OAuthUrlPolicyOptions = {}): Promise<URL> {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  if (url.username || url.password || url.hash) throw new Error("OAuth URL must not contain credentials or a fragment");
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(options.allowLoopback !== false && url.protocol === "http:" && loopback)) {
    throw new Error("OAuth URL must use HTTPS; HTTP is allowed only for loopback callbacks");
  }
  if (loopback) {
    if (options.allowLoopback === false) throw new Error("OAuth URL must not target loopback");
    return url;
  }
  const literalType = net.isIP(url.hostname.replace(/^\[|\]$/g, ""));
  const addresses = literalType
    ? [{ address: url.hostname.replace(/^\[|\]$/g, ""), family: literalType }]
    : await (options.lookup ?? dns.lookup)(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isForbiddenOAuthAddress(address))) {
    throw new Error(`OAuth URL resolves to a private, reserved, or otherwise forbidden address: ${url.hostname}`);
  }
  return url;
}

export function createSafeOAuthFetch(options: OAuthUrlPolicyOptions & { fetchFn?: typeof fetch; maxRedirects?: number } = {}): typeof fetch {
  const dispatcher = options.fetchFn ? undefined : safeDispatcher();
  const fetchFn = options.fetchFn ?? ((input: string | URL | Request, init?: RequestInit) => undiciFetch(input as never, { ...init, dispatcher } as never) as unknown as Promise<Response>);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    let url = input instanceof Request ? new URL(input.url) : input instanceof URL ? new URL(input) : new URL(input);
    let requestInit: RequestInit = { ...init, redirect: "manual" };
    const method = String(requestInit.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    for (let redirects = 0; ; redirects += 1) {
      await validateOAuthUrl(url, options);
      const target = input instanceof Request && redirects === 0 ? new Request(url, input) : url;
      const response = await fetchFn(target, requestInit);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) throw new Error("OAuth redirect response omitted Location");
      if (redirects >= (options.maxRedirects ?? 5)) throw new Error("OAuth redirect limit exceeded");
      if (method !== "GET" && method !== "HEAD") throw new Error("OAuth token or registration requests must not redirect");
      url = await validateOAuthUrl(new URL(location, url), options);
      requestInit = { ...requestInit, redirect: "manual" };
    }
  }) as typeof fetch;
}
