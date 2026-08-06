import fs from "node:fs/promises";
import path from "node:path";

interface StoredDraft {
  value: string;
  updatedAt: string;
}

export class DraftStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly cwd: string) {}

  private file(): string { return path.join(this.cwd, ".xiu", "draft.json"); }

  async load(): Promise<string> {
    try {
      const stored = JSON.parse(await fs.readFile(this.file(), "utf8")) as StoredDraft;
      return typeof stored.value === "string" ? stored.value : "";
    } catch { return ""; }
  }

  save(value: string): Promise<void> {
    const snapshot: StoredDraft = { value, updatedAt: new Date().toISOString() };
    this.queue = this.queue.then(async () => {
      const file = this.file();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(snapshot), "utf8");
      await fs.rename(`${file}.tmp`, file);
    });
    return this.queue;
  }

  clear(): Promise<void> { return this.save(""); }
  flush(): Promise<void> { return this.queue; }
}
