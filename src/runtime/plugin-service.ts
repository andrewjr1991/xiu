import { permissionFingerprint, type ExtensionPermission } from "../extension-permissions.js";
import type { PluginContributionKind, PluginRegistry, PluginScope, PluginState } from "../plugins.js";
import type { PluginSignatureStatus } from "../plugin-signatures.js";

/**
 * Bounded, secret-free view of one discovered plugin for a management surface.
 * No directory, manifest or publisher key crosses the bridge; `fingerprint` is the
 * same approval fingerprint `/plugin approve` records, so a confirmation made on
 * this summary binds to exactly the manifest the user saw.
 */
export interface WorkspacePluginSummary {
  id: string;
  name: string;
  version: string;
  scope: PluginScope;
  state: PluginState;
  /** The current manifest fingerprint is approved and the plugin is loadable. */
  active: boolean;
  /** Approval fingerprint of the current manifest (version, package digest, publisher, contributions). */
  fingerprint: string;
  permissions: ExtensionPermission[];
  contributions: Array<{ kind: PluginContributionKind; count: number }>;
  integrity: "unmanaged" | "legacy" | "verified" | "mismatch";
  signature: PluginSignatureStatus;
  publisherName?: string;
  publisherFingerprint?: string;
  policy: "not-evaluated" | "allowed" | "blocked";
  policyProblems: string[];
  problems: string[];
}

export interface WorkspacePluginSnapshot {
  plugins: WorkspacePluginSummary[];
  /** Same-id declarations hidden by a project plugin. */
  shadowed: number;
  policy: { state: "not-configured" | "active" | "invalid" | "not-loaded"; fingerprint?: string; problem?: string };
  /** Contribution load failures of the running host (already redacted). */
  loadErrors: string[];
}

export type WorkspacePluginRequest =
  | { action: "approve"; id: string; fingerprint: string; confirmed: true }
  | { action: "revoke"; id: string; confirmed: true }
  | { action: "enable"; id: string }
  | { action: "disable"; id: string };

const FINGERPRINT = /^[a-f0-9]{64}$/;

/**
 * Plugin management for the shared workspace host. It wraps the same `PluginRegistry`
 * and grant store the CLI uses, so an approval made here is indistinguishable from
 * `/plugin approve`: same manifest fingerprint, same record, same fail-closed checks.
 * Callers (the desktop main process) still gate idleness, trust and confirmation.
 */
export class WorkspacePluginService {
  constructor(private readonly registry: PluginRegistry, private readonly loadErrors: () => string[] = () => []) {}

  private summarize(plugin: ReturnType<PluginRegistry["list"]>[number]): WorkspacePluginSummary {
    return {
      id: plugin.id, name: plugin.name, version: plugin.version, scope: plugin.scope, state: plugin.state, active: plugin.active,
      fingerprint: permissionFingerprint(this.registry.permissionManifest(plugin)),
      permissions: [...plugin.permissions],
      contributions: Object.entries(plugin.contributions)
        .filter(([, entries]) => entries?.length)
        .map(([kind, entries]) => ({ kind: kind as PluginContributionKind, count: entries?.length ?? 0 }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
      integrity: plugin.integrity, signature: plugin.signature,
      publisherName: plugin.publisherName, publisherFingerprint: plugin.publisherFingerprint,
      policy: plugin.policy, policyProblems: [...plugin.policyProblems], problems: [...plugin.problems],
    };
  }

  /** Rescans manifests (the host only exists for a trusted workspace) and reports every plugin without loading anything. */
  async snapshot(): Promise<WorkspacePluginSnapshot> {
    await this.registry.refresh(true);
    const policy = this.registry.policy();
    return {
      plugins: this.registry.list().map((plugin) => this.summarize(plugin)),
      shadowed: this.registry.shadowed().length,
      policy: { state: policy.state, fingerprint: policy.fingerprint, problem: policy.problem },
      loadErrors: [...this.loadErrors()].slice(0, 20),
    };
  }

  /**
   * Applies one change. `approve` requires the fingerprint of the manifest the user reviewed and
   * fails when the plugin changed since; the registry still enforces loadability and team policy.
   * The caller reloads the host afterwards so contributions follow the new grant state.
   */
  async change(request: WorkspacePluginRequest): Promise<void> {
    if (!request || typeof request.id !== "string" || !request.id) throw new Error("Plugin id required.");
    await this.registry.refresh(true);
    const plugin = this.registry.get(request.id);
    if (!plugin) throw new Error(`Plugin not found: ${request.id}`);
    switch (request.action) {
      case "approve": {
        if (request.confirmed !== true) throw new Error("Plugin approval requires confirmation.");
        if (typeof request.fingerprint !== "string" || !FINGERPRINT.test(request.fingerprint)) throw new Error("Plugin approval requires the reviewed manifest fingerprint.");
        const current = permissionFingerprint(this.registry.permissionManifest(plugin));
        if (current !== request.fingerprint) throw new Error(`Plugin ${plugin.id} changed since permission preview; review the current manifest again.`);
        await this.registry.approve(plugin.id);
        return;
      }
      case "revoke":
        if (request.confirmed !== true) throw new Error("Plugin revocation requires confirmation.");
        await this.registry.revoke(plugin.id);
        return;
      case "enable":
      case "disable":
        await this.registry.setEnabled(plugin.id, request.action === "enable");
        return;
      default:
        throw new Error("Unknown plugin action.");
    }
  }
}
