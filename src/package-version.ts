import { createRequire } from "node:module";

// The desktop bundle defines this at build time (apps/desktop/scripts/build-main.mjs);
// the CLI reads its own package.json. Shared modules that need the running Xiu
// version (plugin engine checks, MCP client identity) take it from here.
declare const __XIU_MCP_CLIENT_VERSION__: string | undefined;

export function xiuPackageVersion(): string {
  if (typeof __XIU_MCP_CLIENT_VERSION__ === "string") return __XIU_MCP_CLIENT_VERSION__;
  return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
}
