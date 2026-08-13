import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PermissionGrantStore, parseExtensionPermissions, permissionFingerprint, type ExtensionPermission, type ExtensionPermissionManifest } from "./extension-permissions.js";
import { validateProviderProfile, type ProviderProfile } from "./provider-registry.js";
import { validateMcpServerConfig, type McpServerConfig } from "./mcp.js";
import {
  PLUGIN_SIGNATURE_FILE,
  PluginPublisherTrustStore,
  verifyPluginSignature,
  type PluginSignatureStatus,
  type TrustedPluginPublisher,
} from "./plugin-signatures.js";
import {
  evaluatePluginPolicy,
  loadPluginTeamPolicy,
  pluginPolicyRevision,
  type PluginPolicySnapshot,
} from "./plugin-policy.js";

const MANIFEST_NAME = "xiu.plugin.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PLUGINS_PER_ROOT = 100;
const MAX_CONTRIBUTIONS = 128;
const MAX_CONTRIBUTION_BYTES = 512 * 1024;
const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const CONTRIBUTION_KINDS = ["providers", "tools", "skills", "workflows"] as const;
const DISABLED_MARKER = ".xiu-disabled";
const INSTALL_METADATA = ".xiu-install.json";
const MAX_PACKAGE_FILES = 2_000;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const PACKAGE_DIGEST = /^[a-f0-9]{64}$/;
const execFileAsync = promisify(execFile);

export type PluginScope = "project" | "global";
export type PluginState = "ready" | "disabled" | "incompatible" | "invalid";
export type PluginContributionKind = typeof CONTRIBUTION_KINDS[number];

export interface PluginContribution {
  id: string;
  path: string;
}

export interface PluginManifest {
  apiVersion: number;
  id: string;
  name: string;
  version: string;
  engines?: { xiu?: { min?: string; maxExclusive?: string } };
  permissions?: string[];
  contributes?: Partial<Record<PluginContributionKind, PluginContribution[]>>;
}

export interface DiscoveredPlugin {
  id: string;
  name: string;
  version: string;
  scope: PluginScope;
  directory: string;
  manifestPath: string;
  state: PluginState;
  active: boolean;
  permissions: ExtensionPermission[];
  contributions: Partial<Record<PluginContributionKind, PluginContribution[]>>;
  contributionDigests: string[];
  packageDigest?: string;
  expectedPackageDigest?: string;
  integrity: "unmanaged" | "legacy" | "verified" | "mismatch";
  installSource?: string;
  sourceRevision?: string;
  signature: PluginSignatureStatus;
  publisherName?: string;
  publisherFingerprint?: string;
  publisherPublicKey?: string;
  policy: "not-evaluated" | "allowed" | "blocked";
  policyProblems: string[];
  problems: string[];
  manifest?: PluginManifest;
}

export interface LoadedPluginContributions {
  providers: ProviderProfile[];
  mcpServers: Record<string, McpServerConfig>;
  skillFiles: Array<{ file: string; name: string }>;
  errors: Array<{ pluginId: string; message: string }>;
}

interface LegacyPluginInstallMetadata {
  version: 1;
  source: string;
  installedAt: string;
}

interface PluginInstallMetadata {
  version: 2;
  source: string;
  installedAt: string;
  packageDigest: string;
  sourceRevision?: string;
}

export interface PluginInstallPlan {
  source: string;
  scope: PluginScope;
  plugin: DiscoveredPlugin;
  previous?: DiscoveredPlugin;
  addedPermissions: ExtensionPermission[];
  removedPermissions: ExtensionPermission[];
  stagingDirectory: string;
  destination: string;
  packageDigest: string;
  sourceRevision?: string;
  policyRevision: string;
}

export interface PluginInstallResult {
  plugin: DiscoveredPlugin;
  backup?: string;
}

function canonical(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference) return difference;
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function installSource(value: string): { display: string; local?: string; git?: string } {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) throw new Error("plugin source cannot be empty");
  if (/^https:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) throw new Error("HTTPS plugin URLs cannot contain embedded credentials");
    parsed.hash = "";
    return { display: parsed.toString(), git: parsed.toString() };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) throw new Error("remote plugin sources must use HTTPS Git URLs");
  const local = path.resolve(trimmed);
  return { display: local, local };
}

async function safeCopyPackage(source: string, destination: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const copy = async (from: string, to: string): Promise<void> => {
    const stat = await fs.lstat(from);
    if (stat.isSymbolicLink()) throw new Error("plugin packages cannot contain symbolic links or junctions");
    if (stat.isDirectory()) {
      await fs.mkdir(to, { recursive: true });
      const entries = await fs.readdir(from, { withFileTypes: true });
      for (const entry of entries) {
        if ([".git", "node_modules", DISABLED_MARKER, INSTALL_METADATA].includes(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error("plugin packages cannot contain symbolic links or junctions");
        await copy(path.join(from, entry.name), path.join(to, entry.name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error("plugin packages can contain only regular files and directories");
    files += 1;
    bytes += stat.size;
    if (files > MAX_PACKAGE_FILES || bytes > MAX_PACKAGE_BYTES) throw new Error("plugin package exceeds the safe file or size limit");
    await fs.copyFile(from, to);
  };
  await copy(source, destination);
}

export async function pluginPackageDigest(directory: string): Promise<{ digest: string; files: number; bytes: number }> {
  const entries: Array<{ relative: string; size: number; digest: string }> = [];
  let files = 0;
  let bytes = 0;
  const walk = async (current: string, relativeRoot = ""): Promise<void> => {
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (!relativeRoot && [INSTALL_METADATA, DISABLED_MARKER, PLUGIN_SIGNATURE_FILE].includes(child.name)) continue;
      const relative = relativeRoot ? `${relativeRoot}/${child.name}` : child.name;
      const target = path.join(current, child.name);
      const targetStat = await fs.lstat(target);
      if (targetStat.isSymbolicLink()) throw new Error("plugin packages cannot contain symbolic links or junctions");
      if (targetStat.isDirectory()) {
        await walk(target, relative);
        continue;
      }
      if (!targetStat.isFile()) throw new Error("plugin packages can contain only regular files and directories");
      const stat = targetStat;
      files += 1;
      bytes += stat.size;
      if (files > MAX_PACKAGE_FILES || bytes > MAX_PACKAGE_BYTES) throw new Error("plugin package exceeds the safe file or size limit");
      entries.push({ relative, size: stat.size, digest: createHash("sha256").update(await fs.readFile(target)).digest("hex") });
    }
  };
  await walk(directory);
  const aggregate = createHash("sha256");
  for (const entry of entries) aggregate.update(`${entry.relative}\0${entry.size}\0${entry.digest}\n`, "utf8");
  return { digest: aggregate.digest("hex"), files, bytes };
}

async function materializeGitPackage(repository: string, destination: string): Promise<void> {
  const treeResult = await execFileAsync("git", ["-C", repository, "ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "buffer",
  });
  const entries = Buffer.from(treeResult.stdout).toString("utf8").split("\0").filter(Boolean);
  if (entries.length > MAX_PACKAGE_FILES) throw new Error("plugin package exceeds the safe file limit");
  let bytes = 0;
  for (const raw of entries) {
    const match = /^(\d{6}) blob ([a-f0-9]{40,64})\t(.+)$/.exec(raw);
    if (!match || !["100644", "100755"].includes(match[1]!)) throw new Error("Git plugin packages may contain only regular files; links and submodules are rejected");
    const relative = match[3]!;
    if (relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some((segment) => !segment || segment === "..")) {
      throw new Error("Git plugin package contains an unsafe path");
    }
    const sizeResult = await execFileAsync("git", ["-C", repository, "cat-file", "-s", match[2]!], { timeout: 10_000, windowsHide: true, maxBuffer: 128 * 1024 });
    const size = Number(String(sizeResult.stdout).trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Git plugin package contains an invalid object size");
    bytes += size;
    if (bytes > MAX_PACKAGE_BYTES) throw new Error("plugin package exceeds the safe size limit");
    const blob = await execFileAsync("git", ["-C", repository, "cat-file", "blob", match[2]!], {
      timeout: 30_000, windowsHide: true, maxBuffer: Math.max(size + 1024, 128 * 1024), encoding: "buffer",
    });
    const target = path.resolve(destination, ...relative.split("/"));
    if (!isInside(canonical(destination), canonical(target))) throw new Error("Git plugin package path escapes the staging directory");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(blob.stdout));
  }
}

async function validateContributionPath(pluginRoot: string, requested: string): Promise<string | undefined> {
  if (!requested || requested.includes("\0") || path.isAbsolute(requested) || path.win32.isAbsolute(requested) || path.posix.isAbsolute(requested)) {
    return "path must be plugin-relative";
  }
  if (requested.split(/[\\/]+/).some((segment) => segment === "..")) return "path escapes the plugin directory";
  const target = path.resolve(pluginRoot, requested);
  if (!isInside(canonical(pluginRoot), canonical(target))) return "path escapes the plugin directory";
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(pluginRoot), fs.realpath(target)]);
    if (!isInside(canonical(realRoot), canonical(realTarget))) return "path resolves outside the plugin directory";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "referenced path does not exist" : "referenced path cannot be safely resolved";
  }
  return undefined;
}

async function readPlugin(directory: string, scope: PluginScope, currentVersion: string): Promise<DiscoveredPlugin> {
  const manifestPath = path.join(directory, MANIFEST_NAME);
  const fallbackId = path.basename(directory).toLowerCase();
  const base: DiscoveredPlugin = {
    id: fallbackId,
    name: path.basename(directory),
    version: "unknown",
    scope,
    directory,
    manifestPath,
    state: "invalid",
    active: false,
    permissions: [],
    contributions: {},
    contributionDigests: [],
    integrity: "unmanaged",
    signature: "unsigned",
    policy: "not-evaluated",
    policyProblems: [],
    problems: [],
  };
  try {
    const stat = await fs.stat(manifestPath);
    if (stat.size > MAX_MANIFEST_BYTES) throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    const raw = record(parsed);
    if (!raw) throw new Error("manifest must be a JSON object");
    const id = text(raw.id);
    const name = text(raw.name);
    const version = text(raw.version);
    base.id = id || fallbackId;
    base.name = name || id || base.name;
    base.version = version || base.version;
    if (raw.apiVersion !== 1) base.problems.push("unsupported apiVersion; expected 1");
    if (!PLUGIN_ID.test(id)) base.problems.push("id must be a lowercase stable identifier");
    if (!name) base.problems.push("name is required");
    if (!parseVersion(version)) base.problems.push("version must be semantic x.y.z");

    const permissionValues = Array.isArray(raw.permissions) ? raw.permissions : raw.permissions === undefined ? [] : [raw.permissions];
    const permissionResult = parseExtensionPermissions(permissionValues);
    base.permissions = permissionResult.permissions;
    if (permissionResult.unknown.length) base.problems.push(`unknown permissions: ${permissionResult.unknown.join(", ")}`);

    let contributionCount = 0;
    const contributes = record(raw.contributes);
    for (const kind of CONTRIBUTION_KINDS) {
      const values = contributes?.[kind];
      if (values === undefined) continue;
      if (!Array.isArray(values)) {
        base.problems.push(`${kind} contributions must be an array`);
        continue;
      }
      const accepted: PluginContribution[] = [];
      for (const value of values) {
        contributionCount += 1;
        const item = record(value);
        const contributionId = text(item?.id);
        const contributionPath = text(item?.path);
        if (!PLUGIN_ID.test(contributionId)) {
          base.problems.push(`${kind} contribution has an invalid id`);
          continue;
        }
        const pathProblem = await validateContributionPath(directory, contributionPath);
        if (pathProblem) {
          base.problems.push(`${kind}.${contributionId}: ${pathProblem}`);
          continue;
        }
        try {
          let digestTarget = path.resolve(directory, contributionPath);
          const targetStat = await fs.stat(digestTarget);
          if (targetStat.isDirectory()) {
            if (kind !== "skills") throw new Error(`${kind} contribution must reference a file`);
            digestTarget = path.join(digestTarget, "SKILL.md");
          }
          const digestStat = await fs.stat(digestTarget);
          if (!digestStat.isFile() || digestStat.size > MAX_CONTRIBUTION_BYTES) throw new Error(`contribution must be a file no larger than ${MAX_CONTRIBUTION_BYTES} bytes`);
          const [realRoot, realTarget] = await Promise.all([fs.realpath(directory), fs.realpath(digestTarget)]);
          if (!isInside(canonical(realRoot), canonical(realTarget))) throw new Error("contribution resolves outside the plugin directory");
          const contributionBytes = await fs.readFile(digestTarget);
          const digest = createHash("sha256").update(contributionBytes).digest("hex");
          base.contributionDigests.push(`${kind}:${contributionId}:${digest}`);
          if ((kind === "skills" || kind === "workflows") && !base.permissions.includes("instructions:load")) {
            throw new Error(`${kind} contributions require instructions:load permission`);
          }
          if (kind === "providers") {
            const profile = validateProviderProfile(JSON.parse(contributionBytes.toString("utf8")) as ProviderProfile);
            if (!base.permissions.includes("network:access")) throw new Error("provider contributions require network:access permission");
            if (profile.apiKeyEnv && !base.permissions.includes("credentials:access")) throw new Error("provider profiles with apiKeyEnv require credentials:access permission");
            if (profile.id !== contributionId) throw new Error(`provider profile id must equal contribution id ${contributionId}`);
            if (profile.apiKey !== undefined) throw new Error("plugin provider profiles cannot contain plaintext apiKey values; use apiKeyEnv");
          }
          if (kind === "tools") {
            const serverName = `plugin_${base.id}_${contributionId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
            const config = validateMcpServerConfig(serverName, JSON.parse(contributionBytes.toString("utf8")));
            const required = config.url ? "network:access" : "process:execute";
            if (!base.permissions.includes(required)) throw new Error(`tool contribution requires ${required} permission`);
            const undeclared = (config.permissions ?? []).filter((permission) => !base.permissions.includes(permission));
            if (undeclared.length) throw new Error(`tool contribution permissions are missing from plugin manifest: ${undeclared.join(", ")}`);
          }
        } catch (error) {
          base.problems.push(`${kind}.${contributionId}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        accepted.push({ id: contributionId, path: contributionPath });
      }
      if (accepted.length) base.contributions[kind] = accepted;
    }
    if (contributionCount > MAX_CONTRIBUTIONS) base.problems.push(`plugin declares more than ${MAX_CONTRIBUTIONS} contributions`);

    const integrity = await pluginPackageDigest(directory);
    base.packageDigest = integrity.digest;
    const signature = await verifyPluginSignature(directory, base.id, base.version, integrity.digest);
    base.signature = signature.status;
    base.publisherName = signature.publisherName;
    base.publisherFingerprint = signature.publisherFingerprint;
    base.publisherPublicKey = signature.publisherPublicKey;
    if (signature.status === "invalid") base.problems.push(signature.problem ?? "plugin signature is invalid");
    try {
      const metadataRaw = JSON.parse(await fs.readFile(path.join(directory, INSTALL_METADATA), "utf8")) as unknown;
      const metadata = record(metadataRaw);
      if (metadata?.version === 1 && text(metadata.source)) {
        base.integrity = "legacy";
        base.installSource = text(metadata.source);
      } else if (metadata?.version === 2 && text(metadata.source) && PACKAGE_DIGEST.test(text(metadata.packageDigest))) {
        base.expectedPackageDigest = text(metadata.packageDigest);
        base.installSource = text(metadata.source);
        base.sourceRevision = text(metadata.sourceRevision) || undefined;
        base.integrity = base.expectedPackageDigest === base.packageDigest ? "verified" : "mismatch";
        if (base.integrity === "mismatch") base.problems.push("installed plugin package does not match its locked digest");
      } else {
        base.problems.push("install metadata is invalid");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") base.problems.push("install metadata is not valid JSON");
    }

    const engines = record(raw.engines);
    const xiu = record(engines?.xiu);
    const minText = text(xiu?.min);
    const maxText = text(xiu?.maxExclusive);
    const current = parseVersion(currentVersion);
    const min = minText ? parseVersion(minText) : undefined;
    const max = maxText ? parseVersion(maxText) : undefined;
    if (minText && !min) base.problems.push("engines.xiu.min must be semantic x.y.z");
    if (maxText && !max) base.problems.push("engines.xiu.maxExclusive must be semantic x.y.z");

    base.manifest = raw as unknown as PluginManifest;
    if (!base.problems.length && current && ((min && compareVersion(current, min) < 0) || (max && compareVersion(current, max) >= 0))) {
      base.state = "incompatible";
      base.problems.push(`requires Xiu ${minText ? `>=${minText}` : ""}${minText && maxText ? " " : ""}${maxText ? `<${maxText}` : ""}`);
    } else if (!base.problems.length) {
      base.state = "ready";
    }
    if (base.state === "ready" && await fs.stat(path.join(directory, DISABLED_MARKER)).then(() => true, () => false)) {
      base.state = "disabled";
      base.problems.push("plugin is disabled locally");
    }
  } catch (error) {
    base.problems.push(error instanceof SyntaxError ? "manifest is not valid JSON" : error instanceof Error ? error.message : String(error));
  }
  return base;
}

async function scanRoot(root: string, scope: PluginScope, currentVersion: string): Promise<DiscoveredPlugin[]> {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true, encoding: "utf8" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_PLUGINS_PER_ROOT)
    .map((entry) => readPlugin(path.join(root, entry.name), scope, currentVersion)));
}

/** Safe v1 inventory. It validates declarations but never executes plugin code. */
export class PluginRegistry {
  private plugins: DiscoveredPlugin[] = [];
  private hidden: DiscoveredPlugin[] = [];
  private projectTrusted = false;
  private policySnapshot: PluginPolicySnapshot;

  constructor(
    private readonly cwd: string,
    private readonly globalRoot = path.join(os.homedir(), ".xiu", "plugins"),
    private readonly currentVersion = "0.14.3",
    private readonly permissionStore = new PermissionGrantStore(path.join(os.homedir(), ".xiu", "extension-permissions.json")),
    private readonly publisherStore = new PluginPublisherTrustStore(path.join(os.homedir(), ".xiu", "trusted-plugin-publishers.json")),
  ) {
    this.policySnapshot = { state: "not-loaded", file: path.join(this.cwd, "xiu.plugin-policy.json") };
  }

  policy(): PluginPolicySnapshot {
    return {
      ...this.policySnapshot,
      ...(this.policySnapshot.policy ? {
        policy: {
          ...this.policySnapshot.policy,
          allowedSources: this.policySnapshot.policy.allowedSources ? [...this.policySnapshot.policy.allowedSources] : undefined,
          allowedPublishers: this.policySnapshot.policy.allowedPublishers ? [...this.policySnapshot.policy.allowedPublishers] : undefined,
          deniedPermissions: [...this.policySnapshot.policy.deniedPermissions],
        },
      } : {}),
    };
  }

  private applyPolicy(plugin: DiscoveredPlugin): string[] {
    const problems = evaluatePluginPolicy(this.policySnapshot, plugin);
    plugin.policyProblems = problems;
    plugin.policy = problems.length ? "blocked" : this.policySnapshot.state === "active" ? "allowed" : "not-evaluated";
    return problems;
  }

  private assertPolicy(plugin: DiscoveredPlugin): void {
    const problems = this.applyPolicy(plugin);
    if (problems.length) throw new Error(`Plugin ${plugin.id} is blocked by team policy: ${problems.join("; ")}`);
  }

  private async reloadPolicy(): Promise<void> {
    this.policySnapshot = await loadPluginTeamPolicy(this.cwd, this.projectTrusted);
  }

  permissionManifest(plugin: DiscoveredPlugin): ExtensionPermissionManifest {
    const contributionDetails = Object.entries(plugin.contributions)
      .flatMap(([kind, entries]) => (entries ?? []).map((entry) => `${kind}:${entry.id}:${entry.path}`));
    return {
      kind: "plugin",
      name: plugin.id,
      origin: path.resolve(plugin.directory),
      permissions: [...plugin.permissions],
      details: [
        `version:${plugin.version}`,
        `package:${plugin.packageDigest ?? "unknown"}`,
        `publisher:${plugin.publisherFingerprint ?? "unsigned"}`,
        ...contributionDetails,
        ...plugin.contributionDigests,
      ],
      declared: true,
    };
  }

  async approve(id: string): Promise<void> {
    const plugin = this.get(id);
    if (!plugin) throw new Error(`Plugin not found: ${id}`);
    if (plugin.state !== "ready") throw new Error(`Plugin is not loadable: ${id}`);
    this.assertPolicy(plugin);
    await this.permissionStore.approve(this.permissionManifest(plugin));
    plugin.active = true;
  }

  async trustedPublishers(): Promise<TrustedPluginPublisher[]> {
    return this.publisherStore.list();
  }

  async trustPublisher(id: string): Promise<TrustedPluginPublisher> {
    const plugin = this.get(id);
    if (!plugin) throw new Error(`Plugin not found: ${id}`);
    if (!plugin.publisherPublicKey || !plugin.publisherFingerprint || !["valid-untrusted", "trusted"].includes(plugin.signature)) {
      throw new Error(`Plugin ${id} does not have a valid publisher signature`);
    }
    const publisher = await this.publisherStore.trust(plugin.publisherPublicKey, plugin.publisherName);
    await this.refresh(this.projectTrusted);
    return publisher;
  }

  async revokePublisher(fingerprint: string): Promise<boolean> {
    const revoked = await this.publisherStore.revoke(fingerprint);
    await this.refresh(this.projectTrusted);
    return revoked;
  }

  private root(scope: PluginScope): string {
    return scope === "global" ? this.globalRoot : path.join(this.cwd, ".xiu", "plugins");
  }

  private backupRoot(scope: PluginScope): string {
    return scope === "global" ? path.join(path.dirname(this.globalRoot), "plugin-backups") : path.join(this.cwd, ".xiu", "plugin-backups");
  }

  async prepareInstall(sourceValue: string, scope: PluginScope, expectedId?: string): Promise<PluginInstallPlan> {
    await this.reloadPolicy();
    const source = installSource(sourceValue);
    const targetRoot = this.root(scope);
    await fs.mkdir(targetRoot, { recursive: true });
    const stagingDirectory = path.join(targetRoot, `.stage-${process.pid}-${Date.now()}-${createHash("sha256").update(source.display).digest("hex").slice(0, 8)}`);
    let checkout: string | undefined;
    let sourceRevision: string | undefined;
    try {
      let packageRoot: string;
      if (source.git) {
        checkout = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-plugin-git-"));
        await execFileAsync("git", ["clone", "--bare", "--depth", "1", "--", source.git, checkout], { timeout: 120_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
        packageRoot = checkout;
        const revision = await execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"], { timeout: 10_000, windowsHide: true, maxBuffer: 128 * 1024 });
        sourceRevision = String(revision.stdout).trim();
        if (!/^[a-f0-9]{40,64}$/.test(sourceRevision)) throw new Error("Git plugin source did not resolve to a stable commit");
      } else {
        packageRoot = await fs.realpath(source.local!);
      }
      const sourceStat = await fs.stat(packageRoot);
      if (sourceStat.isFile()) {
        if (path.basename(packageRoot) !== MANIFEST_NAME) throw new Error(`plugin file source must be named ${MANIFEST_NAME}`);
        packageRoot = path.dirname(packageRoot);
      } else if (!sourceStat.isDirectory()) throw new Error("plugin source must be a directory or xiu.plugin.json");
      if (source.git) await materializeGitPackage(packageRoot, stagingDirectory);
      else await safeCopyPackage(packageRoot, stagingDirectory);
      const candidate = await readPlugin(stagingDirectory, scope, this.currentVersion);
      if (candidate.state !== "ready" || !candidate.manifest) throw new Error(`plugin package is not installable: ${candidate.problems.join("; ")}`);
      if (expectedId && candidate.id !== expectedId) throw new Error(`update source contains plugin ${candidate.id}, expected ${expectedId}`);
      const destination = path.join(targetRoot, candidate.id);
      const previous = await fs.stat(destination).then(() => readPlugin(destination, scope, this.currentVersion), () => undefined);
      const before = new Set(previous?.permissions ?? []);
      const after = new Set(candidate.permissions);
      const lockedDigest = await pluginPackageDigest(stagingDirectory);
      candidate.packageDigest = lockedDigest.digest;
      candidate.expectedPackageDigest = lockedDigest.digest;
      candidate.integrity = "verified";
      candidate.installSource = source.display;
      candidate.sourceRevision = sourceRevision;
      this.assertPolicy(candidate);
      await fs.writeFile(path.join(stagingDirectory, INSTALL_METADATA), `${JSON.stringify({
        version: 2,
        source: source.display,
        installedAt: new Date().toISOString(),
        packageDigest: lockedDigest.digest,
        ...(sourceRevision ? { sourceRevision } : {}),
      } satisfies PluginInstallMetadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return {
        source: source.display, scope, plugin: candidate, previous,
        addedPermissions: candidate.permissions.filter((permission) => !before.has(permission)),
        removedPermissions: [...before].filter((permission) => !after.has(permission)),
        stagingDirectory, destination, packageDigest: lockedDigest.digest, sourceRevision,
        policyRevision: pluginPolicyRevision(this.policySnapshot),
      };
    } catch (error) {
      await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (checkout) await fs.rm(checkout, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async cancelInstall(plan: PluginInstallPlan): Promise<void> {
    await fs.rm(plan.stagingDirectory, { recursive: true, force: true });
  }

  async commitInstall(plan: PluginInstallPlan): Promise<PluginInstallResult> {
    await this.reloadPolicy();
    if (pluginPolicyRevision(this.policySnapshot) !== plan.policyRevision) {
      throw new Error("team plugin policy changed after review; install was cancelled");
    }
    const candidate = await readPlugin(plan.stagingDirectory, plan.scope, this.currentVersion);
    this.assertPolicy(candidate);
    const reviewedFingerprint = permissionFingerprint(this.permissionManifest(plan.plugin));
    const candidateFingerprint = permissionFingerprint(this.permissionManifest(candidate));
    if (
      candidate.state !== "ready"
      || candidate.id !== plan.plugin.id
      || candidate.version !== plan.plugin.version
      || candidateFingerprint !== reviewedFingerprint
    ) {
      throw new Error("staged plugin changed after review; install was cancelled");
    }
    let backup: string | undefined;
    const exists = await fs.stat(plan.destination).then(() => true, () => false);
    if (exists) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backup = path.join(this.backupRoot(plan.scope), plan.plugin.id, `${stamp}-${plan.previous?.version ?? "unknown"}`);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.rename(plan.destination, backup);
    }
    try {
      await fs.rename(plan.stagingDirectory, plan.destination);
    } catch (error) {
      if (backup) await fs.rename(backup, plan.destination).catch(() => undefined);
      throw error;
    }
    await this.refresh(this.projectTrusted);
    return { plugin: this.get(plan.plugin.id) ?? candidate, backup };
  }

  async prepareUpdate(id: string): Promise<PluginInstallPlan> {
    const plugin = this.get(id);
    if (!plugin) throw new Error(`Plugin not found: ${id}`);
    let metadata: PluginInstallMetadata | LegacyPluginInstallMetadata;
    try { metadata = JSON.parse(await fs.readFile(path.join(plugin.directory, INSTALL_METADATA), "utf8")) as PluginInstallMetadata | LegacyPluginInstallMetadata; }
    catch { throw new Error(`Plugin ${id} has no recorded install source; install it again with /plugin install`); }
    if (![1, 2].includes(metadata.version) || typeof metadata.source !== "string") throw new Error(`Plugin ${id} has invalid install metadata`);
    return this.prepareInstall(metadata.source, plugin.scope, id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const plugin = this.get(id);
    if (!plugin) throw new Error(`Plugin not found: ${id}`);
    if (enabled) this.assertPolicy(plugin);
    const marker = path.join(plugin.directory, DISABLED_MARKER);
    if (enabled) await fs.rm(marker, { force: true });
    else await fs.writeFile(marker, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
    await this.refresh(this.projectTrusted);
  }

  async uninstall(id: string): Promise<string> {
    const plugin = this.get(id);
    if (!plugin) throw new Error(`Plugin not found: ${id}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(this.backupRoot(plugin.scope), plugin.id, `${stamp}-${plugin.version}-uninstalled`);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.rename(plugin.directory, backup);
    await this.refresh(this.projectTrusted);
    return backup;
  }

  async recover(id: string, scope: PluginScope): Promise<DiscoveredPlugin> {
    await this.reloadPolicy();
    if (!PLUGIN_ID.test(id)) throw new Error("invalid plugin id");
    const destination = path.join(this.root(scope), id);
    const root = path.join(this.backupRoot(scope), id);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    if (!candidates.length) throw new Error(`No recoverable backup was found for plugin ${id}`);
    const backup = path.join(root, candidates[0]!);
    const candidate = await readPlugin(backup, scope, this.currentVersion);
    if (!candidate.manifest || candidate.state === "invalid" || candidate.state === "incompatible") throw new Error(`Plugin backup is not recoverable: ${candidate.problems.join("; ")}`);
    this.assertPolicy(candidate);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    let displaced: string | undefined;
    if (await fs.stat(destination).then(() => true, () => false)) {
      const current = await readPlugin(destination, scope, this.currentVersion);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      displaced = path.join(root, `${stamp}-${current.version}-pre-recovery`);
      await fs.rename(destination, displaced);
    }
    try { await fs.rename(backup, destination); }
    catch (error) {
      if (displaced) await fs.rename(displaced, destination).catch(() => undefined);
      throw error;
    }
    await this.refresh(this.projectTrusted);
    return this.get(id)!;
  }

  async refresh(projectTrusted: boolean): Promise<DiscoveredPlugin[]> {
    this.projectTrusted = projectTrusted;
    await this.reloadPolicy();
    const global = await scanRoot(this.globalRoot, "global", this.currentVersion);
    const project = projectTrusted ? await scanRoot(path.join(this.cwd, ".xiu", "plugins"), "project", this.currentVersion) : [];
    const winners = new Map<string, DiscoveredPlugin>();
    this.hidden = [];
    for (const plugin of [...global, ...project]) {
      const previous = winners.get(plugin.id);
      if (previous) this.hidden.push(previous);
      winners.set(plugin.id, plugin);
    }
    this.plugins = [...winners.values()].sort((left, right) => left.id.localeCompare(right.id));
    await Promise.all(this.plugins.map(async (plugin) => {
      try {
        if (plugin.signature === "valid-untrusted" && plugin.publisherFingerprint && plugin.publisherPublicKey
          && await this.publisherStore.isTrusted(plugin.publisherFingerprint, plugin.publisherPublicKey)) plugin.signature = "trusted";
        const policyProblems = this.applyPolicy(plugin);
        plugin.active = plugin.state === "ready" && !policyProblems.length && await this.permissionStore.isApproved(this.permissionManifest(plugin));
      }
      catch { plugin.active = false; }
    }));
    return this.list();
  }

  async loadApprovedContributions(): Promise<LoadedPluginContributions> {
    const result: LoadedPluginContributions = { providers: [], mcpServers: {}, skillFiles: [], errors: [] };
    const readBounded = async (file: string, pluginRoot: string): Promise<string> => {
      const [realRoot, realFile] = await Promise.all([fs.realpath(pluginRoot), fs.realpath(file)]);
      if (!isInside(canonical(realRoot), canonical(realFile))) throw new Error("contribution resolves outside the plugin directory");
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_CONTRIBUTION_BYTES) throw new Error(`contribution must be a file no larger than ${MAX_CONTRIBUTION_BYTES} bytes`);
      return fs.readFile(file, "utf8");
    };
    for (const plugin of this.plugins.filter((entry) => entry.active && entry.state === "ready")) {
      for (const entry of plugin.contributions.providers ?? []) {
        try {
          const profile = validateProviderProfile(JSON.parse(await readBounded(path.resolve(plugin.directory, entry.path), plugin.directory)) as ProviderProfile);
          if (!plugin.permissions.includes("network:access")) throw new Error("provider contributions require network:access permission");
          if (profile.apiKeyEnv && !plugin.permissions.includes("credentials:access")) throw new Error("provider profiles with apiKeyEnv require credentials:access permission");
          if (profile.id !== entry.id) throw new Error(`provider profile id must equal contribution id ${entry.id}`);
          if (profile.apiKey !== undefined) throw new Error("plugin provider profiles cannot contain plaintext apiKey values; use apiKeyEnv");
          result.providers.push(profile);
        } catch (error) { result.errors.push({ pluginId: plugin.id, message: `providers.${entry.id}: ${error instanceof Error ? error.message : String(error)}` }); }
      }
      for (const entry of plugin.contributions.tools ?? []) {
        try {
          const serverName = `plugin_${plugin.id}_${entry.id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
          const config = validateMcpServerConfig(serverName, JSON.parse(await readBounded(path.resolve(plugin.directory, entry.path), plugin.directory)));
          const required = config.url ? "network:access" : "process:execute";
          if (!plugin.permissions.includes(required)) throw new Error(`tool contribution requires ${required} permission`);
          const undeclared = (config.permissions ?? []).filter((permission) => !plugin.permissions.includes(permission));
          if (undeclared.length) throw new Error(`tool contribution permissions are missing from plugin manifest: ${undeclared.join(", ")}`);
          result.mcpServers[serverName] = config;
        } catch (error) { result.errors.push({ pluginId: plugin.id, message: `tools.${entry.id}: ${error instanceof Error ? error.message : String(error)}` }); }
      }
      for (const kind of ["skills", "workflows"] as const) {
        for (const entry of plugin.contributions[kind] ?? []) {
          try {
            let file = path.resolve(plugin.directory, entry.path);
            if (!plugin.permissions.includes("instructions:load")) throw new Error(`${kind} contributions require instructions:load permission`);
            const stat = await fs.stat(file);
            if (stat.isDirectory()) file = path.join(file, "SKILL.md");
            await readBounded(file, plugin.directory);
            if (path.basename(file).toLowerCase() !== "skill.md" && kind === "skills") throw new Error("skill contribution must reference SKILL.md or its directory");
            if (path.extname(file).toLowerCase() !== ".md") throw new Error("workflow contribution must be a Markdown file");
            result.skillFiles.push({ file, name: kind === "workflows" ? `workflow:${plugin.id}.${entry.id}` : `${plugin.id}.${entry.id}` });
          } catch (error) { result.errors.push({ pluginId: plugin.id, message: `${kind}.${entry.id}: ${error instanceof Error ? error.message : String(error)}` }); }
        }
      }
    }
    return result;
  }

  list(): DiscoveredPlugin[] { return [...this.plugins]; }
  get(id: string): DiscoveredPlugin | undefined { return this.plugins.find((plugin) => plugin.id === id); }
  shadowed(): DiscoveredPlugin[] { return [...this.hidden]; }
}
