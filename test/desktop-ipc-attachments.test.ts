import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { attachmentsIpcChannels, presentAttachments, registerAttachmentsIpc, type AttachmentsIpcContext, type AttachmentsIpcIo } from "../apps/desktop/main/ipc-attachments.js";
import type { IpcSenderLike } from "../apps/desktop/main/security-policy.js";
import { desktopChannels } from "../apps/desktop/shared/protocol.js";

type Listener = (event: IpcSenderLike, ...args: never[]) => unknown;
const trusted: IpcSenderLike = { sender: { id: 1 } };
const stranger: IpcSenderLike = { sender: { id: 2 } };
const ws = path.resolve("/ws");

function fakeLstat(files: Record<string, { size?: number; symlink?: boolean; dir?: boolean }>): AttachmentsIpcIo["lstat"] {
  return async (absolute) => {
    const entry = files[path.relative(ws, absolute).replace(/\\/g, "/")];
    if (!entry) throw new Error(`ENOENT ${absolute}`);
    return { isFile: () => !entry.dir, isSymbolicLink: () => entry.symlink === true, size: entry.size ?? 10 };
  };
}

test("presentAttachments keeps only plain files inside the workspace and adds image previews within the size limit", async () => {
  const thumbs: string[] = [];
  const thumbnail = (absolute: string) => { thumbs.push(path.relative(ws, absolute).replace(/\\/g, "/")); return "data:thumb"; };
  const lstat = fakeLstat({ "notes/a b.md": { size: 3 }, "img/pic.PNG": { size: 20 }, "img/huge.jpg": { size: 25 * 1024 * 1024 + 1 } });
  const result = await presentAttachments(ws, { insertText: "", attachments: ["notes/a b.md", "img/pic.PNG", "img/huge.jpg"], notice: "pasted" }, thumbnail, { lstat });
  assert.deepEqual(result, {
    insertText: "",
    notice: "pasted",
    attachments: [
      { reference: '@"notes/a b.md"', path: "notes/a b.md", name: "a b.md", bytes: 3, kind: "file" },
      { reference: "@img/pic.PNG", path: "img/pic.PNG", name: "pic.PNG", bytes: 20, kind: "image", previewDataUrl: "data:thumb" },
      { reference: "@img/huge.jpg", path: "img/huge.jpg", name: "huge.jpg", bytes: 25 * 1024 * 1024 + 1, kind: "image" },
    ],
  });
  // Only the small image was decoded; the oversized one keeps its kind without a preview.
  assert.deepEqual(thumbs, ["img/pic.PNG"]);
  assert.equal("notice" in await presentAttachments(ws, { insertText: "", attachments: [] }, thumbnail, { lstat }), false);
});

test("presentAttachments refuses paths that escape the workspace, symlinks and directories without decoding them", async () => {
  let decoded = 0;
  const thumbnail = () => { decoded += 1; return "data:thumb"; };
  const lstat = fakeLstat({ "link.png": { symlink: true }, "dir.png": { dir: true } });
  await assert.rejects(() => presentAttachments(ws, { insertText: "", attachments: ["../outside.png"] }, thumbnail, { lstat }), /附件路径超出工作区/);
  await assert.rejects(() => presentAttachments(ws, { insertText: "", attachments: ["link.png"] }, thumbnail, { lstat }), /附件不是安全的普通文件/);
  await assert.rejects(() => presentAttachments(ws, { insertText: "", attachments: ["dir.png"] }, thumbnail, { lstat }), /附件不是安全的普通文件/);
  assert.equal(decoded, 0);
});

function harness(options: { workspace?: string; chosen?: string[] } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, Listener>();
  const ctx: AttachmentsIpcContext = {
    handleIpc: (channel, listener) => { assert.equal(handlers.has(channel), false, `${channel} registered twice`); handlers.set(channel, listener); },
    assertTrustedSender: (event) => { calls.push("trust"); if (event !== trusted) throw new Error("untrusted sender"); },
    trustedWorkspacePath: () => { calls.push("workspace"); if (!options.workspace) throw new Error("no trusted workspace"); return options.workspace; },
    chooseAttachmentFiles: async () => { calls.push("choose"); return options.chosen; },
    writeClipboardText: (text) => { calls.push(`clipboard:${text}`); },
    imageThumbnail: () => "data:thumb",
  };
  const io: AttachmentsIpcIo = {
    lstat: fakeLstat({ "a.txt": { size: 5 } }),
    manager: (workspace) => {
      calls.push(`manager:${workspace}`);
      return {
        attachFiles: async (files) => { calls.push(`attachFiles:${files.join("|")}`); return { insertText: "", attachments: ["a.txt"] }; },
        paste: async () => { calls.push("paste"); return { insertText: "", attachments: ["a.txt"], notice: "来自剪贴板" }; },
        attachBytes: async (files) => { calls.push(`attachBytes:${files.map((file) => file.name).join("|")}`); return { insertText: "", attachments: ["a.txt"] }; },
      };
    },
  };
  registerAttachmentsIpc(ctx, io);
  // ipcMain.handle turns a synchronous throw into a rejected invoke, so the harness does too.
  const invoke = async (channel: string, event: IpcSenderLike, ...args: unknown[]) => handlers.get(channel)!(event, ...(args as never[]));
  return { calls, handlers, invoke };
}

const presented = { insertText: "", attachments: [{ reference: "@a.txt", path: "a.txt", name: "a.txt", bytes: 5, kind: "file" }] };

test("the attachment channels register exactly once and every handler refuses an untrusted sender before touching state", async () => {
  const { calls, handlers, invoke } = harness({ workspace: ws, chosen: ["/tmp/x.txt"] });
  assert.deepEqual([...handlers.keys()].sort(), [...attachmentsIpcChannels].sort());
  assert.equal(handlers.size, 4);
  for (const channel of attachmentsIpcChannels) {
    calls.length = 0;
    await assert.rejects(() => invoke(channel, stranger, "text"), /untrusted sender/, channel);
    assert.deepEqual(calls, ["trust"], `${channel} touched state for an untrusted sender`);
  }
});

test("choosing, pasting and importing go through the workspace's attachment manager, and a cancelled picker returns nothing", async () => {
  const picked = harness({ workspace: ws, chosen: ["/tmp/x.txt", "/tmp/y.png"] });
  assert.deepEqual(await picked.invoke(desktopChannels.attachmentsChoose, trusted), presented);
  assert.deepEqual(picked.calls, ["trust", "workspace", "choose", `manager:${ws}`, "attachFiles:/tmp/x.txt|/tmp/y.png"]);

  const cancelled = harness({ workspace: ws });
  assert.deepEqual(await cancelled.invoke(desktopChannels.attachmentsChoose, trusted), { insertText: "", attachments: [] });
  assert.deepEqual(cancelled.calls, ["trust", "workspace", "choose"]);

  const pasted = harness({ workspace: ws });
  assert.deepEqual(await pasted.invoke(desktopChannels.attachmentsPaste, trusted), { ...presented, notice: "来自剪贴板" });
  assert.deepEqual(pasted.calls, ["trust", "workspace", `manager:${ws}`, "paste"]);

  const imported = harness({ workspace: ws });
  assert.deepEqual(await imported.invoke(desktopChannels.attachmentsImport, trusted, { files: [{ name: "d.bin", data: new Uint8Array([1]) }] }), presented);
  assert.deepEqual(imported.calls, ["trust", "workspace", `manager:${ws}`, "attachBytes:d.bin"]);
  for (const bad of [undefined, null, {}, { files: "x" }]) {
    imported.calls.length = 0;
    await assert.rejects(() => imported.invoke(desktopChannels.attachmentsImport, trusted, bad), /Invalid attachment request/);
    assert.deepEqual(imported.calls, ["trust"]);
  }
});

test("copying a message needs a trusted workspace and a non-empty string of at most 200k characters", async () => {
  const { calls, invoke } = harness({ workspace: ws });
  assert.equal(await invoke(desktopChannels.copyMessage, trusted, "hello"), undefined);
  assert.deepEqual(calls, ["trust", "workspace", "clipboard:hello"]);
  for (const bad of ["", 42, undefined, "x".repeat(200_001)]) {
    calls.length = 0;
    await assert.rejects(() => invoke(desktopChannels.copyMessage, trusted, bad), /复制内容无效或过长/);
    assert.deepEqual(calls, ["trust", "workspace"]);
  }
  const closed = harness({});
  await assert.rejects(() => closed.invoke(desktopChannels.copyMessage, trusted, "hello"), /no trusted workspace/);
  assert.equal(closed.calls.some((call) => call.startsWith("clipboard")), false);
});
