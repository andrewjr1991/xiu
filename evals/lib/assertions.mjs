import fs from "node:fs/promises";
import { safeWorkspacePath } from "./core.mjs";

export async function fileEquals(workspace, relative, expected) {
  const actual = await fs.readFile(safeWorkspacePath(workspace, relative), "utf8");
  if (actual !== expected) throw new Error(`${relative} does not match the expected content.`);
}

export async function fileIncludes(workspace, relative, expected) {
  const actual = await fs.readFile(safeWorkspacePath(workspace, relative), "utf8");
  if (!actual.includes(expected)) throw new Error(`${relative} does not contain ${JSON.stringify(expected)}.`);
}

export async function fileMissing(workspace, relative) {
  const exists = await fs.lstat(safeWorkspacePath(workspace, relative)).then(() => true, () => false);
  if (exists) throw new Error(`${relative} must not exist.`);
}

export function answerIncludes(answer, expected) {
  if (!String(answer).toLowerCase().includes(String(expected).toLowerCase())) throw new Error(`Answer does not contain ${JSON.stringify(expected)}.`);
}

export function exactChanges(result, expected) {
  const actual = [...result.changedFiles].sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`Changed files differ: ${actual.join(", ") || "none"}.`);
}
