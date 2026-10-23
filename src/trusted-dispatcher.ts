import * as fs from "node:fs";
import * as tls from "node:tls";
import { Agent, type Dispatcher, ProxyAgent } from "undici";

export function combineCertificateAuthorities(defaultRoots: readonly string[], systemRoots: readonly string[]): string[] | undefined {
  if (!systemRoots.length) return undefined;
  return [...new Set([...defaultRoots, ...systemRoots])];
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * Read the PEM certificates of a channel's `caCertFile`.
 *
 * The file only adds trust anchors for that channel; verification itself is
 * never relaxed. Errors carry an `XIU_CA_CERT_*` marker so the user-facing
 * catalog can explain them without leaking anything but the path.
 */
export function readCertificateAuthorityFile(file: string): string[] {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(`XIU_CA_CERT_UNREADABLE: cannot read the certificate file ${file} (${code})`);
  }
  const certificates = text.match(PEM_CERTIFICATE) ?? [];
  if (!certificates.length) throw new Error(`XIU_CA_CERT_INVALID: ${file} contains no PEM certificate block (-----BEGIN CERTIFICATE-----)`);
  return certificates;
}

function readOptionalCertificates(file: string): string[] {
  try { return readCertificateAuthorityFile(file); } catch { return []; }
}

/**
 * Use the native Windows trust store and the channel's own certificate file in
 * addition to Node's bundled roots.
 *
 * Corporate TLS inspection certificates are commonly installed only in the
 * Windows trust store, or handed out as a PEM file. Keeping every set preserves
 * public CA support without weakening certificate verification.
 */
export function createTrustedDispatcher(proxy?: string, caCertFile?: string): Dispatcher | undefined {
  const certificateApiAvailable = typeof tls.getCACertificates === "function";
  const defaultRoots = certificateApiAvailable ? tls.getCACertificates("default") : tls.rootCertificates;
  const systemRoots = process.platform === "win32" && certificateApiAvailable
    ? tls.getCACertificates("system")
    : [];
  const channelRoots = caCertFile ? readCertificateAuthorityFile(caCertFile) : [];
  // Older Node versions expose only the bundled roots above, so an explicit `ca` list must carry NODE_EXTRA_CA_CERTS itself.
  const environmentRoots = channelRoots.length && !certificateApiAvailable && process.env.NODE_EXTRA_CA_CERTS?.trim()
    ? readOptionalCertificates(process.env.NODE_EXTRA_CA_CERTS.trim())
    : [];
  const ca = combineCertificateAuthorities(defaultRoots, [...systemRoots, ...environmentRoots, ...channelRoots]);

  if (proxy) {
    return new ProxyAgent({
      uri: proxy,
      ...(ca ? { requestTls: { ca }, proxyTls: { ca } } : {}),
    });
  }
  return ca ? new Agent({ connect: { ca } }) : undefined;
}
