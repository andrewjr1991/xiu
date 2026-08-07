import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClipboardAttachmentManager, parsePowerShellClipboardResponse, WindowsClipboardBackend, type ClipboardBackend, type ClipboardPayload } from "../src/clipboard.js";

class FakeClipboard implements ClipboardBackend {
  calls = 0;
  constructor(private readonly payload: ClipboardPayload, private readonly imageBytes?: Buffer, private readonly saveImage = true) {}
  async read(imageOutputPath: string): Promise<ClipboardPayload> {
    this.calls++;
    if (this.payload.kind === "image" && this.saveImage) {
      await fs.writeFile(imageOutputPath, this.imageBytes ?? Buffer.from("png"));
      return { kind: "image", imagePath: imageOutputPath };
    }
    return this.payload;
  }
}

class FailingClipboard implements ClipboardBackend {
  calls = 0;
  constructor(private readonly message: string, private readonly available = false, private readonly cached = false) {}
  async read(): Promise<ClipboardPayload> { this.calls++; throw new Error(this.message); }
  async supportsRightClick(): Promise<boolean> { return this.available; }
  async hasCachedHelper(): Promise<boolean> { return this.cached; }
}

test("PowerShell clipboard JSON preserves Unicode text and file paths", () => {
  assert.deepEqual(parsePowerShellClipboardResponse('\uFEFF{"kind":"text","text":"你好\\n第二行"}'), { kind: "text", text: "你好\n第二行" });
  assert.deepEqual(parsePowerShellClipboardResponse('{"kind":"files","files":["C:\\\\项目\\\\设计稿.png"]}'), {
    kind: "files", files: ["C:\\项目\\设计稿.png"],
  });
});

test("native Windows clipboard files never invoke the optional helper", async () => {
  const native = new FakeClipboard({ kind: "files", files: ["C:\\project\\notes.md"] });
  const helper = new FailingClipboard("helper is blocked");
  const backend = new WindowsClipboardBackend(native, helper);
  assert.deepEqual(await backend.read("C:\\project\\clipboard.png"), { kind: "files", files: ["C:\\project\\notes.md"] });
  assert.equal(native.calls, 1);
  assert.equal(helper.calls, 0);
});

test("blocked bitmap helper gives a save-as-file recovery instruction", async () => {
  const native = new FakeClipboard({ kind: "image" }, undefined, false);
  const helper = new FailingClipboard("application control denied execution");
  const backend = new WindowsClipboardBackend(native, helper);
  await assert.rejects(backend.read("C:\\project\\clipboard.png"), /Save the image as a file/);
});

test("right-click capture stays disabled when no permitted backend exists", async () => {
  const native = new FailingClipboard("Get-Clipboard blocked", false);
  const helper = new FailingClipboard("helper blocked", false, false);
  const backend = new WindowsClipboardBackend(native, helper);
  assert.equal(await backend.supportsRightClick(), false);
});

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
