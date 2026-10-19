/** One of the configuration files Xiu owns under `~/.xiu` (or a workspace's `.xiu`), named for the explanation catalog. */
export type ConfigFileKind = "settings" | "trust-store" | "extension-permissions" | "mcp";

/**
 * A configuration file Xiu owns could not be read or did not validate. Every owner keeps failing closed exactly as
 * before; this class only lets the CLI explain the failure (the cause, the next step and `xiu doctor`) instead of
 * printing the raw message. `message` stays the owner's own text, path included, so logs and existing callers are
 * unchanged, and `code` carries the system error code when the failure had one, for callers that classify by errno.
 */
export class ConfigFileError extends Error {
  readonly code?: string;

  constructor(readonly kind: ConfigFileKind, readonly file: string, message: string, options: { code?: unknown; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConfigFileError";
    if (typeof options.code === "string" && options.code) this.code = options.code;
  }
}
