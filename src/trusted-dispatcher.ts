import * as tls from "node:tls";
import { Agent, type Dispatcher, ProxyAgent } from "undici";

export function combineCertificateAuthorities(defaultRoots: readonly string[], systemRoots: readonly string[]): string[] | undefined {
  if (!systemRoots.length) return undefined;
  return [...new Set([...defaultRoots, ...systemRoots])];
}

/**
 * Use the native Windows trust store in addition to Node's bundled roots.
 *
 * Corporate TLS inspection certificates are commonly installed only in the
 * Windows trust store. Keeping both sets preserves public CA support without
 * weakening certificate verification.
 */
export function createTrustedDispatcher(proxy?: string): Dispatcher | undefined {
  const certificateApiAvailable = typeof tls.getCACertificates === "function";
  const defaultRoots = certificateApiAvailable ? tls.getCACertificates("default") : tls.rootCertificates;
  const systemRoots = process.platform === "win32" && certificateApiAvailable
    ? tls.getCACertificates("system")
    : [];
  const ca = combineCertificateAuthorities(defaultRoots, systemRoots);

  if (proxy) {
    return new ProxyAgent({
      uri: proxy,
      ...(ca ? { requestTls: { ca }, proxyTls: { ca } } : {}),
    });
  }
  return ca ? new Agent({ connect: { ca } }) : undefined;
}
