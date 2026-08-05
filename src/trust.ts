import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface TrustStore {
  version: 1;
  workspaces: string[];
}

export function defaultTrustStorePath(): string {
  return path.join(os.homedir(), ".xiu", "trusted-workspaces.json");
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  const resolved = await fs.realpath(workspace).catch(() => path.resolve(workspace));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function loadTrustStore(file: string): Promise<TrustStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<TrustStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces) || !parsed.workspaces.every((item) => typeof item === "string")) {
      throw new Error("invalid trust store structure");
    }
    return parsed as TrustStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: [] };
    throw new Error(`Unable to read Xiu trust store at ${file}: ${(error as Error).message}`);
  }
}

export async function isWorkspaceTrusted(workspace: string, file = defaultTrustStorePath()): Promise<boolean> {
  const canonical = await canonicalWorkspace(workspace);
  return (await loadTrustStore(file)).workspaces.includes(canonical);
}

export async function trustWorkspace(workspace: string, file = defaultTrustStorePath()): Promise<void> {
  const canonical = await canonicalWorkspace(workspace);
  const store = await loadTrustStore(file);
  if (!store.workspaces.includes(canonical)) store.workspaces.push(canonical);
  store.workspaces.sort();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}
