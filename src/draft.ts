import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface StoredDraft {
  value: string;
  updatedAt: string;
}

export class DraftStore {
  private queue: Promise<void> = Promise.resolve();
  private memoryValue: string | undefined;

  constructor(private readonly cwd: string) {}

  private file(): string { return path.join(this.cwd, ".xiu", "draft.json"); }

  async load(): Promise<string> {
    if (this.memoryValue !== undefined) return this.memoryValue;
    try {
      const stored = JSON.parse(await fs.readFile(this.file(), "utf8")) as StoredDraft;
      this.memoryValue = typeof stored.value === "string" ? stored.value : "";
      return this.memoryValue;
    } catch { return ""; }
  }

  save(value: string): Promise<void> {
    this.memoryValue = value;
    const snapshot: StoredDraft = { value, updatedAt: new Date().toISOString() };
    // Draft persistence is best-effort. A locked file, antivirus scanner, or
    // enterprise policy must never turn an input convenience into a fatal CLI
    // error. Recover a previously rejected queue so later keystrokes still save.
    this.queue = this.queue.catch(() => undefined).then(() => this.persist(snapshot)).catch(() => undefined);
    return this.queue;
  }

  clear(): Promise<void> { return this.save(""); }
  flush(): Promise<void> { return this.queue; }

  private async persist(snapshot: StoredDraft): Promise<void> {
    const file = this.file();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(snapshot), "utf8");
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(temporary, file);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) break;
          await new Promise((resolve) => setTimeout(resolve, 15 * (2 ** attempt)));
        }
      }
      // Windows can keep the destination open briefly. A bounded direct-write
      // fallback sacrifices atomicity only for this disposable draft cache.
      await fs.writeFile(file, JSON.stringify(snapshot), "utf8");
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}
