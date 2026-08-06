import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClipboardAttachmentManager, type ClipboardBackend, type ClipboardPayload } from "../src/clipboard.js";

class FakeClipboard implements ClipboardBackend {
  constructor(private readonly payload: ClipboardPayload, private readonly imageBytes?: Buffer) {}
  async read(imageOutputPath: string): Promise<ClipboardPayload> {
    if (this.payload.kind === "image") {
      await fs.writeFile(imageOutputPath, this.imageBytes ?? Buffer.from("png"));
      return { kind: "image", imagePath: imageOutputPath };
    }
    return this.payload;
  }
}

test("plain clipboard text remains ordinary editor text", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-clipboard-text-"));
  const manager = new ClipboardAttachmentManager(cwd, new FakeClipboard({ kind: "text", text: "hello 中文" }));
  const result = await manager.paste();
  assert.equal(result.insertText, "hello 中文");
  assert.deepEqual(result.attachments, []);
});

test("clipboard screenshots are saved as workspace attachment references", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-clipboard-image-"));
  const manager = new ClipboardAttachmentManager(cwd, new FakeClipboard({ kind: "image" }, Buffer.from([137, 80, 78, 71])));
  const result = await manager.paste();
  assert.equal(result.attachments.length, 1);
  assert.match(result.attachments[0] ?? "", /^\.xiu[\\/]attachments[\\/].+-clipboard\.png$/);
  assert.match(result.insertText, /^@\.xiu\/attachments\/.+-clipboard\.png $/);
  assert.deepEqual(await fs.readFile(path.join(cwd, result.attachments[0]!)), Buffer.from([137, 80, 78, 71]));
});

test("external copied files are imported while workspace files stay in place", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-clipboard-files-workspace-"));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-clipboard-files-source-"));
  const outside = path.join(external, "design notes.md");
  const inside = path.join(cwd, "src.ts");
  await fs.writeFile(outside, "notes", "utf8");
  await fs.writeFile(inside, "code", "utf8");
  const manager = new ClipboardAttachmentManager(cwd, new FakeClipboard({ kind: "files", files: [outside, inside] }));
  const result = await manager.paste();
  assert.equal(result.attachments.length, 2);
  assert.match(result.attachments[0] ?? "", /^\.xiu[\\/]attachments[\\/].+design notes\.md$/);
  assert.equal(result.attachments[1], "src.ts");
  assert.match(result.insertText, /@"\.xiu\/attachments\/.+design notes\.md" @src\.ts /);
  assert.equal(await fs.readFile(path.join(cwd, result.attachments[0]!), "utf8"), "notes");
});

test("clipboard directories are rejected instead of recursively imported", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-clipboard-directory-"));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-clipboard-source-directory-"));
  const manager = new ClipboardAttachmentManager(cwd, new FakeClipboard({ kind: "files", files: [directory] }));
  await assert.rejects(manager.paste(), /not a regular file/);
});
