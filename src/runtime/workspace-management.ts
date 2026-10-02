import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stageLocalSkillPackage } from "../skills.js";
import type { ProviderRegistry } from "../provider-registry.js";
import { isProviderRoutingPhase, type ProviderRoutingPhase, type ProviderRoutingPolicy } from "../provider-routing.js";
import { SettingsStore } from "../settings.js";
import type { SkillRegistry } from "../skills.js";
import { redactSecrets } from "../secret-redaction.js";
import type { WebSearchConfig } from "../web-search.js";

export interface WorkspaceManagementSnapshot {
  revision: string;
  providers: Array<{ id: string; name: string; fallback: string[] }>;
  routing: ProviderRoutingPolicy;
  web: { enabled: boolean; provider?: string; endpoint?: string; apiKeyEnv?: string; managed: boolean };
  skills: Array<{ name: string; description: string; scope: string; permissions: string[]; warnings: string[] }>;
}
export type WorkspaceManagementRequest =
  | { action: "skill-install"; revision: string; token: string; confirmed: true }
  | { action: "routing"; revision: string; enabled: boolean }
  | { action: "stage"; revision: string; phase: ProviderRoutingPhase; providerId?: string }
  | { action: "fallback"; revision: string; providerId: string; chain: string[] }
  | { action: "web"; revision: string; enabled: boolean; provider: "tavily" | "brave" | "searxng"; endpoint: string; apiKeyEnv?: string };

/** Only explicit non-secret configuration and bounded summaries cross the bridge. */
export class WorkspaceManagementService {
  private pending?: { root: string; packageRoot: string; digest: string; token: string; expiresAt: number; revision: string };
  private closed = false;
  private previewGeneration = 0;
  constructor(private readonly registry: ProviderRegistry, private readonly skills: SkillRegistry,
    private readonly settings = new SettingsStore()) {}

  private metadata(value: string, limit: number): string {
    const secrets = this.registry.list().flatMap((item) => {
      const profile = this.registry.get(item.id);
      return [profile?.apiKey, profile?.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined];
    }).filter((key): key is string => Boolean(key));
    return redactSecrets(value, secrets).slice(0, limit);
  }

  private async digest(root: string): Promise<string> {
    const hash = createHash("sha256");
    let count = 0; let bytes = 0;
    const scan = async (directory: string) => {
      for (const entry of (await fs.readdir(directory)).sort()) {
        const file = path.join(directory, entry);
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) throw new Error("Skill package changed.");
        if (stat.isDirectory()) await scan(file);
        else if (stat.isFile()) {
          count++; bytes += stat.size;
          if (count > 1000 || bytes > 20 * 1024 * 1024) throw new Error("Skill package exceeds limits.");
          hash.update(path.relative(root, file)); hash.update("\0"); hash.update(await fs.readFile(file)); hash.update("\0");
        } else throw new Error("Unsupported skill object.");
      }
    };
    await scan(root);
    return hash.digest("hex");
  }

  async cancelSkillPreview(): Promise<void> {
    this.previewGeneration++;
    const pending = this.pending; this.pending = undefined;
    if (pending) await fs.rm(pending.root, { recursive: true, force: true });
  }

  async close(): Promise<void> { this.closed = true; await this.cancelSkillPreview(); }

  async prepareSkill(source: string) {
    if (this.closed) throw new Error("Management service closed.");
    await this.cancelSkillPreview();
    const generation = this.previewGeneration;
    const revision = (await this.snapshot()).revision;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skill-preview-"));
    const packageRoot = path.join(root, "package");
    try {
      const skills = await stageLocalSkillPackage(source, packageRoot);
      for (const skill of skills) {
        try { await fs.lstat(path.join(this.skills.globalDirectory(), skill.name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        throw new Error("A skill already exists. Replacement requires a separate workflow.");
      }
      const digest = await this.digest(packageRoot);
      if (this.closed || generation !== this.previewGeneration) throw new Error("Skill preview cancelled.");
      const token = randomUUID(); const expiresAt = Date.now() + 5 * 60_000;
      this.pending = { root, packageRoot, digest, token, expiresAt, revision };
      return { revision, token, digest, expiresAt: new Date(expiresAt).toISOString(),
        skills: skills.map((skill) => ({ ...skill, name: this.metadata(skill.name, 160) })) };
    } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
  }

  async snapshot(): Promise<WorkspaceManagementSnapshot> {
    const config = await this.settings.load();
    const secrets = this.registry.list().flatMap((item) => { const profile = this.registry.get(item.id); return [profile?.apiKey, profile?.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined]; }).filter((key): key is string => Boolean(key));
    if (config.webSearch?.apiKeyEnv && process.env[config.webSearch.apiKeyEnv]) secrets.push(process.env[config.webSearch.apiKeyEnv]!);
    const clean = (value: string, limit: number) => redactSecrets(value, secrets).slice(0, limit);
    const providers = this.registry.list().map((item) => ({ id: item.id, name: clean(item.name, 160), fallback: this.registry.failoverChain(item.id) }));
    const routing = this.registry.routingPolicy();
    const revision = createHash("sha256").update(JSON.stringify({ config, providers, routing })).digest("hex");
    return { revision, providers, routing,
      web: { enabled: config.webSearch?.enabled === true, provider: config.webSearch?.provider,
        apiKeyEnv: config.webSearch?.apiKeyEnv,
        endpoint: config.webSearch?.baseURL ? clean(config.webSearch.baseURL.split(/[?#]/)[0]!, 2_000) : undefined, managed: Boolean(config.webSearch?.managedAuth) },
      skills: this.skills.list().slice(0, 300).map((item) => ({ name: clean(item.name, 160),
        description: clean(item.description, 500), scope: item.scope,
        permissions: item.permissions, warnings: item.permissionWarnings.map((value) => clean(value, 160)) })),
    };
  }

  async change(request: WorkspaceManagementRequest): Promise<void> {
    if (this.closed) throw new Error("Management service closed.");
    if (!request || typeof request.revision !== "string" || request.revision !== (await this.snapshot()).revision) {
      if (request?.action === "skill-install") await this.cancelSkillPreview();
      throw new Error("配置已变化，请刷新后重试。");
    }
    switch (request.action) {
      case "skill-install": {
        const pending = this.pending;
        this.pending = undefined; // A confirmation token is single-use, even on failure.
        if (!pending) throw new Error("Skill preview is unavailable.");
        try {
          if (request.confirmed !== true || request.token !== pending.token || request.revision !== pending.revision || Date.now() >= pending.expiresAt
            || await this.digest(pending.packageRoot) !== pending.digest) throw new Error("Skill preview changed or expired.");
          await this.skills.install(pending.packageRoot, false, async () => true);
          return;
        } finally { await fs.rm(pending.root, { recursive: true, force: true }); }
      }
      case "routing":
        if (typeof request.enabled !== "boolean") throw new Error("Invalid routing selection.");
        return this.registry.setRoutingEnabled(request.enabled);
      case "stage":
        if (!isProviderRoutingPhase(request.phase) || (request.providerId !== undefined && typeof request.providerId !== "string")) throw new Error("Invalid routing stage.");
        return this.registry.setRoutingPhase(request.phase, request.providerId);
      case "fallback":
        if (typeof request.providerId !== "string" || !Array.isArray(request.chain) || request.chain.length > 8 || request.chain.some((id) => typeof id !== "string")) throw new Error("Invalid fallback chain.");
        return this.registry.setFailoverChain(request.providerId, request.chain);
      case "web": {
        if (typeof request.enabled !== "boolean" || !["tavily", "brave", "searxng"].includes(request.provider)
          || typeof request.endpoint !== "string" || request.endpoint.length > 2_000) throw new Error("Invalid search configuration.");
        const url = new URL(request.endpoint);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("请使用无凭据、无查询参数的 HTTPS 服务地址。");
        if (request.apiKeyEnv !== undefined && (typeof request.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(request.apiKeyEnv))) throw new Error("请输入环境变量名称，不要填写密钥。");
        const current = await this.settings.load();
        const webSearch: WebSearchConfig = { ...current.webSearch, enabled: request.enabled, provider: request.provider, baseURL: url.toString(), apiKeyEnv: request.apiKeyEnv || undefined, managedAuth: undefined, authBaseURL: undefined };
        await this.settings.save({ ...current, webSearch });
        return;
      }
      default: throw new Error("Unknown management action.");
    }
  }
}
