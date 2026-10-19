import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { explainError, formatUserFacingError } from "../src/user-facing-errors.js";
import { WorkspaceDirectoryError, assertWorkspaceDirectory } from "../src/workspace-directory.js";

async function scratch(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-workspace-directory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("an existing directory passes; a missing path, a path through a file and a file itself are named for what they are", async (t) => {
  const root = await scratch(t);
  const file = path.join(root, "notes.txt");
  await fs.writeFile(file, "x");
  await assertWorkspaceDirectory(root);

  const missing = await assertWorkspaceDirectory(path.join(root, "gone")).then(() => undefined, (error: unknown) => error);
  assert.ok(missing instanceof WorkspaceDirectoryError);
  assert.equal(missing.problem, "missing");
  assert.equal(missing.code, "ENOENT");
  assert.equal(missing.message, `Workspace does not exist: ${path.join(root, "gone")}`, "the raw message scripts match on is unchanged");

  const throughFile = await assertWorkspaceDirectory(path.join(file, "sub")).then(() => undefined, (error: unknown) => error);
  assert.ok(throughFile instanceof WorkspaceDirectoryError);
  assert.equal(throughFile.problem, "missing", "a path that runs through a file does not exist either");

  const notDirectory = await assertWorkspaceDirectory(file).then(() => undefined, (error: unknown) => error);
  assert.ok(notDirectory instanceof WorkspaceDirectoryError);
  assert.equal(notDirectory.problem, "not-directory");
  assert.equal(notDirectory.code, undefined);
  assert.equal(notDirectory.message, `Workspace is not a directory: ${file}`);
});

test("the explanation names the problem with the path in both languages and keeps the raw message as the detail", () => {
  const error = new WorkspaceDirectoryError("not-directory", "/work/notes.txt");
  const en = explainError(error, "en-US");
  assert.equal(en.code, "workspace/not-directory");
  assert.equal(en.cause, "The workspace path is a file, not a directory: /work/notes.txt. A workspace must be a directory.");
  assert.match(en.nextStep, /^Point --cwd at the project directory/);
  assert.equal(en.detail, "Workspace is not a directory: /work/notes.txt");
  const zh = explainError(error, "zh-CN");
  assert.equal(zh.cause, "工作区路径是文件而不是目录：/work/notes.txt。工作区必须是目录。");
  assert.equal(explainError(new Error("startup failed", { cause: error }), "en-US").code, "workspace/not-directory", "a wrapped error is still recognised");

  const missing = new WorkspaceDirectoryError("missing", "/work/gone", { code: "ENOENT" });
  assert.equal(explainError(missing, "en-US").cause, "The workspace directory does not exist: /work/gone.");
  const unreadable = new WorkspaceDirectoryError("unreadable", "/work/locked", { code: "EACCES" });
  assert.equal(unreadable.message, "Workspace could not be read (EACCES): /work/locked");
  assert.equal(explainError(unreadable, "zh-CN").code, "workspace/unreadable");

  const text = formatUserFacingError("Xiu could not start", missing, "en-US", { diagnostic: "xiu doctor" });
  assert.deepEqual(text.split("\n").map((line) => line.split(": ")[0]), ["Xiu could not start", "Next step", "Diagnose", "Detail"]);
  assert.match(text, /\nDetail: workspace\/missing · Workspace does not exist: \/work\/gone$/);
});
