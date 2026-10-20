import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listReviewFiles, previewGeneratedMedia, previewReviewFile, sanitizeHtmlPreview } from "../src/runtime/review.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-review-"));
  await Promise.all([
    fs.mkdir(path.join(root, "src"), { recursive: true }),
    fs.mkdir(path.join(root, ".xiu"), { recursive: true }),
    fs.mkdir(path.join(root, "node_modules", "hidden"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, "src", "app.ts"), "export const ready = true;\n"),
    fs.writeFile(path.join(root, "README.md"), "# Hello\n\n<script>globalThis.pwned=1</script>\n"),
    fs.writeFile(path.join(root, "unsafe.html"), '<h1 onclick="steal()">Title</h1><script>steal()</script><img src="https://evil.example/a"><form><input name="token"></form><p>Safe</p>'),
    fs.writeFile(path.join(root, ".env"), "API_KEY=do-not-read\n"),
    fs.writeFile(path.join(root, ".xiu", "private.txt"), "private"),
    fs.writeFile(path.join(root, "node_modules", "hidden", "index.js"), "hidden"),
  ]);
  return root;
}

test("desktop review file listing excludes credentials, internal state, and dependencies", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = await listReviewFiles(root);
  assert.deepEqual(files.map((file) => file.path), ["README.md", "src/app.ts", "unsafe.html"]);
});

test("desktop review preview rejects traversal and sensitive files", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => previewReviewFile(root, "../outside.txt"), /不能|cannot/i);
  await assert.rejects(() => previewReviewFile(root, ".env"), /不能|cannot/i);
  await assert.rejects(() => previewReviewFile(root, path.resolve(root, "src/app.ts")), /不能|cannot/i);
});

test("desktop review never follows a file link", async (t) => {
  const root = await fixture();
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { force: true })]));
  await fs.writeFile(outside, "outside secret");
  try { await fs.symlink(outside, path.join(root, "linked.txt"), "file"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows policy does not permit creating a test symlink."); return; }
    throw error;
  }
  await assert.rejects(() => previewReviewFile(root, "linked.txt"), /链接|Junction|outside workspace/i);
  assert.equal((await listReviewFiles(root)).some((file) => file.path === "linked.txt"), false);
});

test("desktop text previews redact known environment credentials", async (t) => {
  const root = await fixture();
  const previous = process.env.XIU_REVIEW_API_KEY;
  process.env.XIU_REVIEW_API_KEY = "review-secret-canary-918273";
  t.after(async () => {
    if (previous === undefined) delete process.env.XIU_REVIEW_API_KEY; else process.env.XIU_REVIEW_API_KEY = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "src", "notice.txt"), "token=review-secret-canary-918273\n");
  const preview = await previewReviewFile(root, "src/notice.txt");
  assert.doesNotMatch(preview.source ?? "", /review-secret-canary-918273/);
  assert.match(preview.source ?? "", /redacted/i);
});

test("desktop HTML preview removes active content, URLs, forms, and attributes", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const preview = await previewReviewFile(root, "unsafe.html");
  assert.equal(preview.kind, "html");
  assert.match(preview.safeHtml ?? "", /<h1>Title<\/h1>/);
  assert.match(preview.safeHtml ?? "", /<p>Safe<\/p>/);
  assert.doesNotMatch(preview.safeHtml ?? "", /steal|script|onclick|evil\.example|form|input|<img/i);
  assert.match(preview.safeHtml ?? "", /default-src 'none'/);
});

test("desktop Markdown preview treats embedded HTML as text", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const preview = await previewReviewFile(root, "README.md");
  assert.equal(preview.kind, "markdown");
  assert.match(preview.safeHtml ?? "", /<h1>Hello<\/h1>/);
  assert.doesNotMatch(preview.safeHtml ?? "", /<script>|globalThis\.pwned=1<\/script>/);
  assert.match(preview.safeHtml ?? "", /&lt;script&gt;/);
});

test("desktop review provides bounded local audio and video previews", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "speech.mp3"), Buffer.from("audio-bytes"));
  await fs.writeFile(path.join(root, "clip.mp4"), Buffer.from("video-bytes"));
  const audio = await previewReviewFile(root, "speech.mp3");
  const video = await previewReviewFile(root, "clip.mp4");
  assert.equal(audio.kind, "audio");
  assert.match(audio.dataUrl ?? "", /^data:audio\/mpeg;base64,/);
  assert.equal(video.kind, "video");
  assert.match(video.dataUrl ?? "", /^data:video\/mp4;base64,/);
});

test("HTML sanitizer strips remote and executable surfaces from direct input", async () => {
  const safe = await sanitizeHtmlPreview('<iframe src="file:///secret"></iframe><object data="https://evil"></object><table style="background:url(https://evil)"><tr><td onmouseover="x()">ok</td></tr></table>');
  assert.doesNotMatch(safe, /<iframe|<object|file:\/\/|https:\/\/evil|onmouseover|background:url/i);
  assert.match(safe, /<table><tbody><tr><td>ok<\/td><\/tr><\/tbody><\/table>/);
});

test("generated media preview returns small images inline, scales large ones through the host and keeps the file rules", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(path.join(root, "assets", "small.png"), Buffer.from("png-bytes"));
  await fs.writeFile(path.join(root, "assets", "large.png"), Buffer.alloc(3 * 1024 * 1024, 1));
  await fs.writeFile(path.join(root, "assets", "clip.mp3"), Buffer.from("mp3-bytes"));
  await fs.writeFile(path.join(root, "assets", "notes.txt"), "text");
  const small = await previewGeneratedMedia(root, "assets/small.png");
  assert.deepEqual(small, { path: "assets/small.png", kind: "image", bytes: 9, dataUrl: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}` });
  assert.equal((await previewGeneratedMedia(root, "assets/large.png")).warning, "图片超过 2 MiB，未载入预览。");
  const scaled: number[] = [];
  const large = await previewGeneratedMedia(root, "assets/large.png", (data, type) => { scaled.push(data.length); return `data:${type};base64,scaled`; });
  assert.deepEqual(large, { path: "assets/large.png", kind: "image", bytes: 3 * 1024 * 1024, dataUrl: "data:image/png;base64,scaled" });
  assert.deepEqual(scaled, [3 * 1024 * 1024]);
  assert.equal((await previewGeneratedMedia(root, "assets/large.png", () => undefined)).warning, "图片无法解码，未载入预览。");
  assert.equal((await previewGeneratedMedia(root, "assets/clip.mp3")).dataUrl, `data:audio/mpeg;base64,${Buffer.from("mp3-bytes").toString("base64")}`);
  await assert.rejects(() => previewGeneratedMedia(root, "assets/notes.txt"), /只能内嵌预览/);
  await assert.rejects(() => previewGeneratedMedia(root, "../outside.png"), /不能/);
  await assert.rejects(() => previewGeneratedMedia(root, ".xiu/private.png"), /不能/);
});
