import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function copyTree(source, target) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Evaluation fixture link is forbidden: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(source)) await copyTree(path.join(source, entry), path.join(target, entry));
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported evaluation fixture entry: ${source}`);
  await fs.copyFile(source, target);
}

export async function createIsolation(taskDirectory) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-eval-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  try {
    await copyTree(path.join(taskDirectory, "repo"), workspace);
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  return { root, workspace, home, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
