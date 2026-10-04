import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { defaultPreferences, parsePreferences, type DesktopPreferences } from "../shared/preferences.js";

export class PreferencesStore {
  value: DesktopPreferences = { ...defaultPreferences };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return;
      this.value = parsePreferences(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch { /* Invalid preferences never change execution permissions. */ }
  }
  save(input: unknown): Promise<DesktopPreferences> {
    const next = parsePreferences(input);
    const operation = this.queue.then(async () => {
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      try { await fs.rename(temp, this.file); } finally { await fs.unlink(temp).catch(() => undefined); }
      this.value = next;
      return { ...next };
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
