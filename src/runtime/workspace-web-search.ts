import { ManagedWebSearchAuth } from "../managed-web-search-auth.js";
import { createWebFetch, createWebSearchTools, type WebSearchConfig, type WebSearchDependencies } from "../web-search.js";

/** Same lazy device/token flow as the CLI; construction never enrolls a device. */
export function createWorkspaceWebSearchTools(config: WebSearchConfig | undefined, dependencies: WebSearchDependencies = {},
  createAuth = (baseURL: string, fetch: ReturnType<typeof createWebFetch>): Pick<ManagedWebSearchAuth, "getBearerToken"> =>
    new ManagedWebSearchAuth(baseURL, undefined, fetch)) {
  const auth = config?.enabled && config.managedAuth === "xiu-device" && config.authBaseURL
    ? createAuth(config.authBaseURL, dependencies.fetch ?? createWebFetch(config.proxy)) : undefined;
  return createWebSearchTools(config, config?.proxy, {
    ...dependencies,
    ...(auth ? { getBearerToken: (signal?: AbortSignal) => auth.getBearerToken(signal) } : {}),
  });
}
