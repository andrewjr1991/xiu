import assert from "node:assert/strict";
import test from "node:test";
import { estimateConversationTokens } from "../src/session.js";
import { IMAGE_TOKEN_ESTIMATE, dataUrlFromImage, imageFromDataUrl, retainLatestImages } from "../src/tool-images.js";
import type { ConversationMessage } from "../src/types.js";

test("only raster data URLs become tool images, and they round-trip", () => {
  const image = imageFromDataUrl("data:image/png;base64,Zml4dHVyZQ==");
  assert.deepEqual(image, { mediaType: "image/png", data: "Zml4dHVyZQ==" });
  assert.equal(dataUrlFromImage(image!), "data:image/png;base64,Zml4dHVyZQ==");
  assert.equal(imageFromDataUrl("data:image/jpeg;base64,/9j/4AAQ")?.mediaType, "image/jpeg");
  for (const rejected of ["data:text/html;base64,PGh0bWw+", "data:image/svg+xml;base64,PHN2Zz4=", "https://fixture.invalid/a.png", "data:image/png;base64,not base64!", ""]) assert.equal(imageFromDataUrl(rejected), undefined, rejected);
});

test("only the newest frame keeps its image; older tool results say so once", () => {
  const image = { mediaType: "image/png" as const, data: "AAAA" };
  const messages: ConversationMessage[] = [
    { role: "user", content: "start" },
    { role: "tool", content: "Frame: a", toolCallId: "1", toolName: "computer_observe", images: [image] },
    { role: "assistant", content: "clicking" },
    { role: "tool", content: "Frame: b", toolCallId: "2", toolName: "computer_input", images: [image] },
    { role: "tool", content: "Frame: c", toolCallId: "3", toolName: "computer_observe", images: [image] },
  ];
  assert.equal(retainLatestImages(messages), 2);
  assert.equal(messages[1]!.images, undefined); assert.equal(messages[3]!.images, undefined);
  assert.deepEqual(messages[4]!.images, [image]);
  assert.match(messages[1]!.content, /^Frame: a\n\[Screenshot no longer attached/);
  // Idempotent: a second pass strips nothing and never appends the note twice.
  assert.equal(retainLatestImages(messages), 0);
  assert.equal(messages[1]!.content.split("Screenshot no longer attached").length, 2);
  assert.equal(messages[2]!.content, "clicking");
});

test("attached images count toward the context estimate", () => {
  const plain: ConversationMessage = { role: "tool", content: "Frame: a", toolCallId: "1", toolName: "computer_observe" };
  const withImage = { ...plain, images: [{ mediaType: "image/png" as const, data: "AAAA" }] };
  assert.equal(estimateConversationTokens([withImage]) - estimateConversationTokens([plain]), IMAGE_TOKEN_ESTIMATE);
});
