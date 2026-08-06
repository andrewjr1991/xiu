import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeLanguage, type UiLanguage } from "./i18n.js";

export interface XiuSettings {
  language?: UiLanguage;
}

export class SettingsStore {
  constructor(private readonly filename = path.join(os.homedir(), ".xiu", "settings.json")) {}

  async load(): Promise<XiuSettings> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, "utf8")) as { language?: unknown };
      return typeof parsed.language === "string" ? { language: normalizeLanguage(parsed.language) } : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`Could not read Xiu settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async save(settings: XiuSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.filename);
  }
}
