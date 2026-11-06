import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { previewWorkspaceIdentity, formatWorkspaceIdentityPreview } from "../src/workspace-identity-preview.js";
import { legacyTaskRunWorkspaceId, TaskRunJournal } from "../src/task-run.js";
import { runRecoverCommand } from "../src/commands/recover-command.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-identity-preview-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const cwd = await fs.realpath(workspace);
  const taskRunRoot = path.join(root, "runs");
  const id = new TaskRunJournal(cwd, taskRunRoot).workspaceId;
  return { root, cwd, taskRunRoot, id, directory: path.join(taskRunRoot, id) };
}

test("identity preview leaves missing storage absent and never proposes an active migration", async (t) => {
  const f = await fixture(t);
  const preview = await previewWorkspaceIdentity(f.cwd, { taskRunRoot: f.taskRunRoot });
  assert.equal(preview.currentLegacyId, f.id);
  assert.equal(preview.ownershipVerified, false);
  assert.equal(preview.contentValidated, false);
  assert.equal(preview.migrationSupported, false);
  assert.equal(preview.changesApplied, false);
  assert.equal(preview.metadataComplete, true);
  assert.ok(preview.slots.every((slot) => slot.state === "absent" && slot.lockPresent === false));
  assert.deepEqual(await fs.readdir(f.root), ["workspace"]);
  const windows = await previewWorkspaceIdentity(f.cwd, { taskRunRoot: f.taskRunRoot, platform: "win32" });
  assert.equal(windows.identityChangeProposed, false);
  assert.equal(windows.proposedId, windows.currentLegacyId);
  assert.equal(windows.slots.length, 1, "identical namespaces are scanned once");
});

test("identity preview counts bounded metadata without opening JSON or lock contents", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { recursive: true });
  const record = path.join(f.directory, "private-record-canary.json");
  const handle = await fs.open(record, "w");
  await handle.truncate(1024 * 1024);
  await handle.close();
  const lock = path.join(f.directory, ".active.lock");
  await fs.writeFile(lock, "private-lock-canary-私密");
  const before = await fs.readdir(f.directory);
  t.mock.method(fs, "open", async () => { throw new Error("record contents must not be opened"); });
  t.mock.method(fs, "readFile", async () => { throw new Error("record contents must not be read"); });
  const preview = await previewWorkspaceIdentity(f.cwd, { taskRunRoot: f.taskRunRoot });
  const slot = preview.slots.find((item) => item.id === f.id)!;
  assert.equal(slot.regularFiles, 2);
  assert.equal(slot.bytes, 1024 * 1024 + Buffer.byteLength("private-lock-canary-私密"));
  assert.equal(slot.jsonFiles, 1);
  assert.equal(slot.lockPresent, true);
  assert.equal(preview.metadataComplete, true, "metadata completeness is not JSON validity or process liveness");
  assert.deepEqual(await fs.readdir(f.directory), before);
  assert.doesNotMatch(JSON.stringify(preview), /private-record-canary|private-lock-canary|xiu-identity-preview/);
  assert.match(formatWorkspaceIdentityPreview(preview, "en-US"), /Ownership is unverified; migration is not implemented/);
  assert.match(formatWorkspaceIdentityPreview(preview, "zh-CN"), /所有权未核实/);
});

test("entry limits report truncation and unknown lock absence rather than inventing a complete scan", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { recursive: true });
  for (let index = 0; index < 3; index++) await fs.writeFile(path.join(f.directory, `${index}.json`), "invalid json");
  const preview = await previewWorkspaceIdentity(f.cwd, { taskRunRoot: f.taskRunRoot, entryLimit: 1 });
  const slot = preview.slots.find((item) => item.id === f.id)!;
  assert.equal(slot.entries, 1);
  assert.equal(slot.truncated, true);
  assert.equal(slot.lockPresent, null);
  assert.equal(preview.metadataComplete, false);
  assert.match(formatWorkspaceIdentityPreview(preview, "en-US"), /incomplete/);
  for (const entryLimit of [0, -1, 1.5, 10_001, Infinity]) await assert.rejects(previewWorkspaceIdentity(f.cwd, { taskRunRoot: f.taskRunRoot, entryLimit }), /Invalid identity preview entry limit/);
});

test("metadata access errors are partial and never echo paths or exception messages", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { recursive: true });
  const file = path.join(f.directory, "blocked.json");
  await fs.writeFile(file, "private-content-canary");
  const second = path.join(f.directory, "second-blocked.json");
  await fs.writeFile(second, "private-content-canary");
  const original = fs.lstat.bind(fs);
  t.mock.method(fs, "lstat", async (target: Parameters<typeof fs.lstat>[0]) => {
    if ([file, second].includes(String(target))) throw Object.assign(new Error(`private-metadata-canary ${file}`), { code: "EACCES" });
    return original(target);
  });
  const preview = await previewWorkspaceIdentity(f.cwd, { taskRunRoot: f.taskRunRoot });
  assert.equal(preview.metadataComplete, false);
  assert.deepEqual(preview.slots.find((slot) => slot.id === f.id)!.issues, [{ reason: "EACCES", count: 2 }]);
  assert.doesNotMatch(JSON.stringify(preview), /private-metadata-canary|private-content-canary|blocked\.json|xiu-identity-preview/);
});

test("a non-directory storage root is reported without enumeration or modification", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.taskRunRoot, "private-root-canary");
  t.mock.method(fs, "opendir", async () => { throw new Error("unsafe root must not be enumerated"); });
  const preview = await previewWorkspaceIdentity(f.cwd, { taskRunRoot: f.taskRunRoot });
  assert.equal(preview.metadataComplete, false);
  assert.ok(preview.slots.every((slot) => slot.state === "unsafe" && slot.regularFiles === 0 && slot.lockPresent === null));
  assert.equal(await fs.readFile(f.taskRunRoot, "utf8"), "private-root-canary");
});

test("identity metadata rejects linked roots and does not wait on linked/FIFO entries", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { recursive: true });
  await fs.symlink(f.cwd, path.join(f.directory, "linked.json"));
  execFileSync("mkfifo", [path.join(f.directory, "pipe.json")]);
  const source = new URL("../src/workspace-identity-preview.ts", import.meta.url).href;
  const code = `const {previewWorkspaceIdentity}=await import(${JSON.stringify(source)});console.log(JSON.stringify(await previewWorkspaceIdentity(${JSON.stringify(f.cwd)},{taskRunRoot:${JSON.stringify(f.taskRunRoot)}})));`;
  const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { timeout: 10_000, encoding: "utf8" }));
  assert.equal(result.metadataComplete, false);
  assert.equal(result.slots.find((slot: { id: string }) => slot.id === f.id).nonRegularEntries, 2);
  const alias = path.join(f.root, "linked-root");
  await fs.symlink(f.taskRunRoot, alias);
  const linkedRoot = await previewWorkspaceIdentity(f.cwd, { taskRunRoot: alias });
  assert.ok(linkedRoot.slots.every((slot) => slot.state === "unsafe"));
});

test("workspace aliases retain both lexical and canonical legacy namespaces in the preview", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "workspace-alias");
  await fs.symlink(f.cwd, alias);
  const preview = await previewWorkspaceIdentity(alias, { taskRunRoot: f.taskRunRoot });
  assert.equal(preview.currentLegacyId, new TaskRunJournal(alias, f.taskRunRoot).workspaceId);
  assert.equal(preview.canonicalLegacyId, f.id);
  assert.notEqual(preview.currentLegacyId, preview.canonicalLegacyId);
  assert.equal(preview.slots.length, 3);
});

test("recover identity enforces trust and usage before inspecting metadata or recovery records", async () => {
  let inspections = 0;
  let trustChecks = 0;
  let journalReads = 0;
  const errors: string[] = [];
  const options = {
    cwd: "/workspace", language: "en-US" as const,
    stdout: () => { throw new Error("no output expected"); }, stderr: (text: string) => { errors.push(text); },
    isTrusted: async () => { trustChecks++; return false; },
    identityPreview: async () => { inspections++; throw new Error("metadata must not be inspected"); },
    journal: { interrupted: async () => { journalReads++; return undefined; }, abandon: async () => { throw new Error("never abandon"); } },
  };
  assert.equal(await runRecoverCommand(["identity", "json"], options), 1);
  assert.match(errors.join("\n"), /not trusted/);
  assert.equal(inspections + journalReads, 0);
  trustChecks = 0;
  for (const args of [["identity", "migrate"], ["identity", "json", "extra"]]) assert.equal(await runRecoverCommand(args, options), 1);
  assert.equal(trustChecks, 0);
});

test("recover identity serializes metadata without invoking strict recovery or changing records", async (t) => {
  const f = await fixture(t);
  const preview = await previewWorkspaceIdentity(f.cwd, { taskRunRoot: f.taskRunRoot });
  const output: string[] = [];
  let reads = 0;
  const options = {
    cwd: f.cwd, language: "en-US" as const, stdout: (text: string) => { output.push(text); }, stderr: () => { throw new Error("unexpected error"); }, isTrusted: async () => true,
    identityPreview: async (cwd: string) => { assert.equal(cwd, f.cwd); return preview; },
    journal: { interrupted: async () => { reads++; return undefined; }, abandon: async () => { throw new Error("never abandon"); } },
  };
  assert.equal(await runRecoverCommand(["identity", "JSON"], options), 0);
  assert.deepEqual(JSON.parse(output[0]!), preview);
  preview.metadataComplete = false;
  assert.equal(await runRecoverCommand(["identity"], options), 1);
  assert.match(output[1]!, /Metadata scan incomplete/);
  assert.equal(reads, 0);
});

test("identity command errors expose only a reason code", async () => {
  const output: string[] = [];
  assert.equal(await runRecoverCommand(["identity"], {
    cwd: "/workspace", language: "en-US", isTrusted: async () => true, stdout: () => { throw new Error("no success"); }, stderr: (text) => { output.push(text); },
    identityPreview: async () => { throw Object.assign(new Error("private-path-canary /home/private"), { code: "EACCES" }); },
  }), 1);
  assert.match(output[0]!, /EACCES/);
  assert.doesNotMatch(output[0]!, /private-path-canary|\/home\/private/);
});


test("version-1 namespaces remain discoverable until a real migration is implemented", () => {
  const workspace = process.platform === "win32" ? "C:\\Xiu\\Case" : "/Xiu/Case";
  const expected = process.platform === "win32" ? "f65e0a3db326861f213a07d8" : "02c6e4530ac2731e8185d7c9";
  assert.equal(legacyTaskRunWorkspaceId(workspace), expected, "serialized legacy IDs must remain discoverable");
  assert.equal(new TaskRunJournal(workspace).workspaceId, expected, "a preview must not silently activate a new namespace");
});
