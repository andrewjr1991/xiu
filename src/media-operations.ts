import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type MediaOperationKind = "image" | "video";
export type MediaOperationStatus = "submitting" | "submitted" | "asset_ready" | "completed" | "ambiguous" | "failed";

export interface MediaOperationRecord {
  key: string;
  requestId: string;
  kind: MediaOperationKind;
  providerId: string;
  model: string;
  status: MediaOperationStatus;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  url?: string;
  cachedAsset?: string;
  savedPath?: string;
  error?: string;
  retryAfterAt?: string;
}

interface MediaOperationFile {
  version: 1;
  operations: MediaOperationRecord[];
}

const storeWriteLocks = new Map<string, Promise<void>>();

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stableValue(item)]));
  return value;
}

export function mediaOperationKey(kind: MediaOperationKind, providerId: string, model: string, request: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue({ kind, providerId, model, request }))).digest("hex");
}

export class MediaOperationStore {
  private readonly file: string;
  private readonly cacheDir: string;

  constructor(private readonly cwd: string) {
    this.file = path.join(cwd, ".xiu", "media-operations.json");
    this.cacheDir = path.join(cwd, ".xiu", "media-assets");
  }

  async get(key: string): Promise<MediaOperationRecord | undefined> {
    await (storeWriteLocks.get(this.file) ?? Promise.resolve());
    return (await this.read()).operations.find((item) => item.key === key);
  }

  async list(limit = 20): Promise<MediaOperationRecord[]> {
    await (storeWriteLocks.get(this.file) ?? Promise.resolve());
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return (await this.read()).operations
      .slice()
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, bounded);
  }

  async resolve(identifier: string): Promise<MediaOperationRecord> {
    await (storeWriteLocks.get(this.file) ?? Promise.resolve());
    const value = identifier.trim();
    if (!value) throw new Error("media request id must not be empty");
    const operations = (await this.read()).operations;
    const exact = operations.find((item) => item.requestId === value || item.key === value || item.taskId === value);
    if (exact) return exact;
    if (value.length < 8) throw new Error("media request id prefix must contain at least 8 characters");
    const matches = operations.filter((item) => item.requestId.startsWith(value) || item.key.startsWith(value) || item.taskId?.startsWith(value));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`media request id prefix is ambiguous (${matches.length} matches)`);
    throw new Error(`media request not found: ${value}`);
  }

  async cooldown(kind: MediaOperationKind, providerId: string, model: string): Promise<MediaOperationRecord | undefined> {
    await (storeWriteLocks.get(this.file) ?? Promise.resolve());
    const now = Date.now();
    return (await this.read()).operations
      .filter((item) => item.kind === kind && item.providerId === providerId && item.model === model && item.retryAfterAt && Date.parse(item.retryAfterAt) > now)
      .sort((left, right) => Date.parse(right.retryAfterAt!) - Date.parse(left.retryAfterAt!))[0];
  }

  async begin(input: { key: string; kind: MediaOperationKind; providerId: string; model: string }, force = false): Promise<MediaOperationRecord> {
    return this.mutate(async () => {
      const data = await this.read();
      const existing = data.operations.find((item) => item.key === input.key);
      if (existing && !force) return existing;
      const now = new Date().toISOString();
      const record: MediaOperationRecord = { ...input, requestId: randomUUID(), status: "submitting", createdAt: now, updatedAt: now };
      data.operations = data.operations.filter((item) => item.key !== input.key);
      data.operations.push(record);
      if (data.operations.length > 200) data.operations = data.operations.slice(-200);
      await this.write(data);
      return record;
    });
  }

  async update(key: string, patch: Partial<Omit<MediaOperationRecord, "key" | "requestId" | "kind" | "providerId" | "model" | "createdAt">>): Promise<MediaOperationRecord> {
    return this.mutate(async () => {
      const data = await this.read();
      const index = data.operations.findIndex((item) => item.key === key);
      if (index < 0) throw new Error(`Unknown media operation ${key.slice(0, 12)}`);
      const record = { ...data.operations[index]!, ...patch, updatedAt: new Date().toISOString() };
      data.operations[index] = record;
      await this.write(data);
      return record;
    });
  }

  async cacheAsset(requestId: string, extension: string, bytes: Buffer): Promise<string> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const target = path.join(this.cacheDir, `${requestId}${extension}`);
    await fs.writeFile(target, bytes);
    return path.relative(this.cwd, target);
  }

  private async read(): Promise<MediaOperationFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as MediaOperationFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.operations)) throw new Error("invalid media operation store");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, operations: [] };
      throw error;
    }
  }

  private async write(data: MediaOperationFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.file);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = storeWriteLocks.get(this.file) ?? Promise.resolve();
    let result!: T;
    const current = previous.catch(() => undefined).then(async () => { result = await operation(); });
    storeWriteLocks.set(this.file, current.catch(() => undefined));
    await current;
    return result;
  }
}

export function mediaRetryBlocked(record: MediaOperationRecord): string | undefined {
  if (record.status === "ambiguous") return `Media request ${record.requestId} may already have been accepted or billed. Xiu will not submit it again automatically. Set force_new_generation=true only after the user explicitly approves a possible duplicate charge.`;
  if (record.status === "failed") return `Media request ${record.requestId} reached a terminal failure. Creating another paid request requires force_new_generation=true and explicit user approval.`;
  if (record.status === "submitting") return `Media request ${record.requestId} has an unknown submission outcome. Xiu will not submit a duplicate automatically; use force_new_generation=true only with explicit user approval.`;
  return undefined;
}
