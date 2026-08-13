import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseExtensionPermissions, type ExtensionPermission } from "./extension-permissions.js";

export const PLUGIN_POLICY_FILE = "xiu.plugin-policy.json";
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_POLICY_ENTRIES = 128;
const SHA256 = /^[a-f0-9]{64}$/;

export interface PluginTeamPolicy {
  version: 1;
  requireSignature: boolean;
  allowedSources?: string[];
  allowedPublishers?: string[];
  deniedPermissions: ExtensionPermission[];
}

export interface PluginPolicySnapshot {
  state: "not-configured" | "active" | "invalid" | "not-loaded";
  file: string;
  fingerprint?: string;
  policy?: PluginTeamPolicy;
  problem?: string;
}

export interface PluginPolicySubject {
  scope: "project" | "global";
  installSource?: string;
  signature: "unsigned" | "valid-untrusted" | "trusted" | "invalid";
  publisherFingerprint?: string;
  permissions: ExtensionPermission[];
}

function normalizeHttpsSource(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("allowedSources entries must be 'project' or credential-free HTTPS URLs");
  }
  parsed.hash = "";
  return parsed.toString();
}

function uniqueStrings(value: unknown, name: string, normalize: (entry: string) => string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_POLICY_ENTRIES) throw new Error(`${name} must be an array with at most ${MAX_POLICY_ENTRIES} entries`);
  const result = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 2_048) throw new Error(`${name} contains an invalid entry`);
    return normalize(entry.trim());
  });
  return [...new Set(result)].sort();
}

function parsePolicy(value: unknown): PluginTeamPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin policy must be a JSON object");
  const raw = value as Record<string, unknown>;
  const known = new Set(["version", "requireSignature", "allowedSources", "allowedPublishers", "deniedPermissions"]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`plugin policy contains unknown fields: ${unknown.join(", ")}`);
  if (raw.version !== 1) throw new Error("plugin policy version must be 1");
  if (raw.requireSignature !== undefined && typeof raw.requireSignature !== "boolean") throw new Error("requireSignature must be boolean");
  const allowedSources = uniqueStrings(raw.allowedSources, "allowedSources", (entry) => entry === "project" ? entry : normalizeHttpsSource(entry));
  const allowedPublishers = uniqueStrings(raw.allowedPublishers, "allowedPublishers", (entry) => {
    const normalized = entry.toLowerCase().replace(/^sha256:/, "");
    if (!SHA256.test(normalized)) throw new Error("allowedPublishers entries must be full SHA-256 fingerprints");
    return normalized;
  });
  if (raw.deniedPermissions !== undefined && !Array.isArray(raw.deniedPermissions)) throw new Error("deniedPermissions must be an array");
  const permissionResult = parseExtensionPermissions(raw.deniedPermissions ?? []);
  if (permissionResult.unknown.length) throw new Error(`deniedPermissions contains unknown permissions: ${permissionResult.unknown.join(", ")}`);
  return {
    version: 1,
    requireSignature: raw.requireSignature === true,
    ...(allowedSources !== undefined ? { allowedSources } : {}),
    ...(allowedPublishers !== undefined ? { allowedPublishers } : {}),
    deniedPermissions: permissionResult.permissions,
  };
}

export async function loadPluginTeamPolicy(cwd: string, projectTrusted: boolean): Promise<PluginPolicySnapshot> {
  const file = path.join(cwd, PLUGIN_POLICY_FILE);
  if (!projectTrusted) return { state: "not-loaded", file };
  let raw: Buffer;
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_POLICY_BYTES) {
      return { state: "invalid", file, problem: "plugin policy must be a bounded regular file" };
    }
    raw = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "not-configured", file };
    return { state: "invalid", file, problem: "plugin policy could not be read" };
  }
  try {
    const policy = parsePolicy(JSON.parse(raw.toString("utf8")));
    const canonical = JSON.stringify(policy);
    return { state: "active", file, policy, fingerprint: createHash("sha256").update(canonical).digest("hex") };
  } catch (error) {
    return { state: "invalid", file, problem: error instanceof Error ? error.message : "plugin policy is invalid" };
  }
}

function normalizedSubjectSource(subject: PluginPolicySubject): string | undefined {
  if (!subject.installSource) return subject.scope === "project" ? "project" : undefined;
  if (!/^https:\/\//i.test(subject.installSource)) return undefined;
  try { return normalizeHttpsSource(subject.installSource); }
  catch { return undefined; }
}

export function pluginPolicyRevision(snapshot: PluginPolicySnapshot): string {
  return snapshot.state === "active" ? `active:${snapshot.fingerprint}` : snapshot.state;
}

export function evaluatePluginPolicy(snapshot: PluginPolicySnapshot, subject: PluginPolicySubject): string[] {
  if (snapshot.state === "invalid") return [`team plugin policy is invalid: ${snapshot.problem ?? "unknown error"}`];
  if (snapshot.state !== "active" || !snapshot.policy) return [];
  const policy = snapshot.policy;
  const problems: string[] = [];
  if (policy.requireSignature && subject.signature === "unsigned") problems.push("team policy requires a valid plugin signature");
  if (policy.allowedPublishers !== undefined && (!subject.publisherFingerprint || !policy.allowedPublishers.includes(subject.publisherFingerprint))) {
    problems.push("plugin publisher is not in the team allowlist");
  }
  if (policy.allowedSources !== undefined) {
    const source = normalizedSubjectSource(subject);
    if (!source || !policy.allowedSources.includes(source)) problems.push("plugin source is not in the team allowlist");
  }
  const denied = subject.permissions.filter((permission) => policy.deniedPermissions.includes(permission));
  if (denied.length) problems.push(`team policy denies permissions: ${denied.join(", ")}`);
  return problems;
}
