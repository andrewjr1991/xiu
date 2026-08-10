import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mediaOperationKey, MediaOperationStore } from "../src/media-operations.js";

test("media operation keys are stable across object property order", () => {
  const first = mediaOperationKey("image", "agnes", "image-model", { prompt: "x", size: "1K" });
  const second = mediaOperationKey("image", "agnes", "image-model", { size: "1K", prompt: "x" });
  assert.equal(first, second);
});

test("concurrent media operation writers preserve every request", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-media-store-"));
  const first = new MediaOperationStore(cwd);
  const second = new MediaOperationStore(cwd);
  const imageKey = mediaOperationKey("image", "agnes", "image-model", { prompt: "one" });
  const videoKey = mediaOperationKey("video", "agnes", "video-model", { prompt: "two" });
  await Promise.all([
    first.begin({ key: imageKey, kind: "image", providerId: "agnes", model: "image-model" }),
    second.begin({ key: videoKey, kind: "video", providerId: "agnes", model: "video-model" }),
  ]);
  assert.equal((await first.get(imageKey))?.kind, "image");
  assert.equal((await second.get(videoKey))?.kind, "video");
});

test("media operations can be listed newest-first and resolved by stable identifiers", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-media-resolve-"));
  const store = new MediaOperationStore(cwd);
  const first = await store.begin({ key: "a".repeat(64), kind: "image", providerId: "agnes", model: "image-model" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await store.begin({ key: "b".repeat(64), kind: "video", providerId: "agnes", model: "video-model" });
  await store.update(second.key, { status: "submitted", taskId: "task-stable-123456" });

  assert.deepEqual((await store.list()).map((item) => item.requestId), [second.requestId, first.requestId]);
  assert.equal((await store.resolve(second.requestId.slice(0, 8))).requestId, second.requestId);
  assert.equal((await store.resolve("task-stable-123456")).requestId, second.requestId);
  await assert.rejects(() => store.resolve("missing-id"), /not found/);
});
