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
