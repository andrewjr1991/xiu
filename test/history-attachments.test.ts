import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { historyAttachmentReferences, restoreHistoryAttachments } from "../apps/desktop/main/history-attachments.js";
import type { RuntimeEvent } from "../src/runtime/protocol.js";

test("historical uploads restore to exact message, including truncated task text", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-history-uploads-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".xiu", "attachments"), { recursive: true });
  await fs.writeFile(path.join(root, ".xiu", "attachments", "second.png"), "image-canary");
  const full = `${"long task ".repeat(500)}\n@.xiu/attachments/second.png\n@.xiu/attachments/missing.png`;
  const events = [
    { eventId: "first", type: "task.started", payload: { taskPreview: "first round" } },
    { eventId: "second", type: "task.started", payload: { taskPreview: full.slice(0, 4000) } },
    { eventId: "steer", type: "task.steered", payload: { text: "supplement\n@.xiu/attachments/second.png" } },
  ] as RuntimeEvent[];
  const refs = historyAttachmentReferences(events, ["first round", full]);
  assert.equal(refs.first, undefined);
  assert.equal(refs.second?.length, 2);
  assert.equal(refs.steer?.length, 1);
  const restored = await restoreHistoryAttachments(root, refs, data => `data:image/png;base64,${data.toString("base64")}`);
  assert.match(restored.second![0]!.previewDataUrl!, /aW1hZ2UtY2FuYXJ5/);
  assert.equal(restored.second![1]!.unavailable, true);
  assert.equal(restored.first, undefined);
  // A new call has no renderer memory, but still restores the same uploads.
  assert.deepEqual(await restoreHistoryAttachments(root, refs, () => "thumbnail"), await restoreHistoryAttachments(root, refs, () => "thumbnail"));
});

test("history upload restoration never reads arbitrary, traversing or linked paths", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-history-paths-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [{ eventId: "bad", type: "task.started", payload: { taskPreview: '@.xiu/attachments/../secret.png\n@.env\n@"C:/outside.png"' } }] as RuntimeEvent[];
  assert.deepEqual(historyAttachmentReferences(events, []), {});
  assert.deepEqual(await restoreHistoryAttachments(root, { bad: [".xiu/attachments/../secret.png", "C:/outside.png"] }, () => { throw Error("Must not decode"); }), {});
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-upload-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".xiu"));
  await fs.writeFile(path.join(outside, "secret.png"), "do-not-read");
  await fs.symlink(outside, path.join(root, ".xiu", "attachments"), process.platform === "win32" ? "junction" : "dir");
  let decoded = false;
  const restored = await restoreHistoryAttachments(root, { bad: [".xiu/attachments/secret.png"] }, () => { decoded = true; return "leak"; });
  assert.equal(decoded, false); assert.equal(restored.bad![0]!.unavailable, true);
});
