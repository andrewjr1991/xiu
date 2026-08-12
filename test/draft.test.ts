import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DraftStore } from "../src/draft.js";

test("draft survives restart and clears after submission", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-draft-"));
  const first = new DraftStore(cwd);
  await first.save("未完成的\n多行需求");
  assert.equal(await new DraftStore(cwd).load(), "未完成的\n多行需求");
  await first.clear();
  assert.equal(await new DraftStore(cwd).load(), "");
});

test("draft persistence failures never reject input or poison later saves", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-draft-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const blockedWorkspace = path.join(root, "workspace-file");
  await fs.writeFile(blockedWorkspace, "not a directory");
  const store = new DraftStore(blockedWorkspace);
  await assert.doesNotReject(() => store.save("still typing"));
  await assert.doesNotReject(() => store.save("still typing more"));
  await assert.doesNotReject(() => store.flush());
  assert.equal(await store.load(), "still typing more");
});
