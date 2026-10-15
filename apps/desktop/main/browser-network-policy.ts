import { isPublicAddress, validatePublicWebUrl } from "../../../src/web-search.js";

/** Why a web-tab request was allowed or cancelled. Only `allow` lets the request through. */
export type BrowserRequestVerdict = "allow" | "method" | "unparseable" | "policy" | "private" | "tainted";

/**
 * Network gate for the desktop web tab (S3). Every request, including
 * subresources and redirects, is checked against the public-HTTPS policy with
 * the resolver the caller supplies. The controller passes Chromium's resolver
 * for the tab's own session, so the check and the connection that follows read
 * one DNS answer cache instead of two independent lookups (Node's and
 * Chromium's) that a rebinding server could answer differently. A host that
 * ever resolves to a local or private address stays blocked for the lifetime
 * of this policy, so flipping the answer back to a public address does not
 * reopen it. The remaining window is a cache entry expiring between the check
 * and the connection; TLS certificate validation for the host name still
 * applies to whatever address is reached.
 */
export class BrowserNetworkPolicy {
  private readonly tainted = new Set<string>();
  constructor(
    private readonly resolveHost: (hostname: string) => Promise<string[]>,
    private readonly validate: (url: string, resolveHostname: (hostname: string) => Promise<string[]>) => Promise<URL> = (url, resolveHostname) => validatePublicWebUrl(url, {}, resolveHostname),
  ) {}

  /** Host names this policy has seen resolve to a local or private address. */
  get taintedHosts(): ReadonlySet<string> { return this.tainted; }

  async check(url: string, method = "GET"): Promise<BrowserRequestVerdict> {
    if (!["GET", "HEAD"].includes(method.toUpperCase())) return "method";
    let hostname: string;
    try { hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { return "unparseable"; }
    if (this.tainted.has(hostname)) return "tainted";
    const resolve = async (name: string): Promise<string[]> => {
      const addresses = await this.resolveHost(name);
      if (addresses.some((address) => !isPublicAddress(address))) this.tainted.add(hostname);
      return addresses;
    };
    try { await this.validate(url, resolve); return "allow"; }
    catch { return this.tainted.has(hostname) ? "private" : "policy"; }
  }

  /** The message shown in the tab when a top-level navigation is cancelled. */
  static message(verdict: Exclude<BrowserRequestVerdict, "allow">): string {
    return verdict === "private" || verdict === "tainted"
      ? "该网址解析到了本机或内网地址，已停止加载；本次网页会话不再访问它。"
      : "仅支持公开 HTTPS 网页，不支持本地地址、凭据网址或其他协议。";
  }
}
