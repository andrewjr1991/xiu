import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION = "0.20.14-beta.1";
export const BRANCH = `codex/xiu-device-test-${VERSION}`;
const REPOSITORY = "andrewjr1991/xiu";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Exactly the original nine gates must finish successfully; the publishing job is separate.
export function validateJobs(jobs, commit) {
  const names = [
    ...["windows-latest", "ubuntu-latest", "macos-26-intel"].map((os) => `Verify (${os}, Node 20.18.1)`),
    ...["windows-latest", "ubuntu-latest", "macos-26-intel"].map((os) => `Desktop (${os})`),
    ...["22", "24"].map((node) => `Compat (ubuntu-latest, Node ${node})`),
    "Dependency audit",
  ];
  for (const name of names) {
    const matches = jobs.filter((job) => job.name === name);
    assert.equal(matches.length, 1, `Missing or duplicate gate: ${name}`);
    assert.equal(matches[0].head_sha, commit, `Wrong source: ${name}`);
    assert.equal(matches[0].status, "completed", `Unfinished gate: ${name}`);
    assert.equal(matches[0].conclusion, "success", `Failed gate: ${name}`);
  }
}

export async function validateBundle(directory, kind, commit, runId, attempt) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  const platform = kind === "cli" ? "linux" : "win32";
  const name = kind === "cli" ? `xiu-ai-cli-${VERSION}-${commit}.tgz` : `Xiu-${VERSION}-x64-${commit}-unsigned.exe`;
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.package, { name: `@xiu-ai/${kind}`, version: VERSION });
  assert.equal(manifest.source.commit, commit);
  assert.equal(manifest.source.worktreeModified, false);
  assert.equal(manifest.source.event, "push");
  assert.equal(manifest.source.ref, `refs/heads/${BRANCH}`);
  assert.equal(manifest.build.platform, platform);
  assert.equal(manifest.build.architecture, "x64");
  assert.equal(String(manifest.build.runId), String(runId));
  assert.equal(String(manifest.build.runAttempt), String(attempt));
  assert.equal(manifest.candidate.acceptance, "job-checks-passed");
  assert.equal(manifest.verification.status, "passed");
  assert.ok(Object.keys(manifest.verification.checks).length > 0);
  assert.ok(Object.values(manifest.verification.checks).every((outcome) => outcome === "success"));
  assert.equal(manifest.files.length, 1);
  const bytes = await readFile(path.join(directory, name));
  assert.ok(bytes.length > 0);
  assert.deepEqual(manifest.files[0], { name, bytes: bytes.length, sha256: sha256(bytes) });
  return { name, bytes };
}

async function main() {
  const env = process.env;
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_EVENT_NAME, "push");
  assert.equal(env.GITHUB_REF, `refs/heads/${BRANCH}`);
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/u);
  const commit = env.GITHUB_SHA;
  assert.equal(JSON.parse(await readFile("package.json", "utf8")).version, VERSION);
  assert.equal(JSON.parse(await readFile("apps/desktop/package.json", "utf8")).version, VERSION);
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const pages = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/jobs?filter=latest&per_page=100`));
  validateJobs(pages.flatMap((page) => page.jobs), commit);
  const output = path.resolve(".device-test-release");
  await mkdir(output, { recursive: true });
  const assets = [];
  for (const kind of ["cli", "desktop"]) {
    const platform = kind === "cli" ? "linux" : "win32";
    const directory = path.join(output, kind);
    gh("run", "download", env.GITHUB_RUN_ID, "--repo", REPOSITORY, "--name", `xiu-${kind}-${VERSION}-${platform}-${commit}-attempt${env.GITHUB_RUN_ATTEMPT}`, "--dir", directory);
    const file = await validateBundle(directory, kind, commit, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
    assets.push(file);
    assets.push({ name: `${kind}-manifest.json`, bytes: await readFile(path.join(directory, "manifest.json")) });
  }
  const sums = assets.map(({ name, bytes }) => `${sha256(bytes)}  ${name}`).join("\n") + "\n";
  assets.push({ name: "SHA256SUMS", bytes: Buffer.from(sums) });
  for (const asset of assets) await writeFile(path.join(output, asset.name), asset.bytes);
  const notes = `# Xiu ${VERSION} Windows x64 真机测试版\n\n` +
    `源码：${commit}\nCI：https://github.com/${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}\n\n` +
    "下载 Xiu-*.exe 安装；这是未签名的 Windows x64 NSIS 预发布版，供真机测试。安装器、CLI 包来自本次 CI 原始制品，全部九项门禁通过后发布。SHA256SUMS 可用于校验下载。没有发布 npm，也不更新稳定版 latest。\n\n" +
    "本轮包括长历史分批浏览、复制与 Markdown 表格、渠道代理和管理入口，以及会话持久化、中断恢复、并发启动和显示事件隔离修复。\n\n" +
    "建议先备份现有用户数据，关闭其他 Xiu/CLI 实例；测试全新安装与覆盖升级、渠道连接、长历史跳转/复制、任务停止与确认恢复、退出重开。失败/取消后可能已有副作用，先核验，不重复执行未知操作。切勿同时运行旧版和此版本处理同一项目。\n\n" +
    "已知限制：安装器未签名；POSIX 旧工作区身份碰撞迁移、完整锁协议、ARM64/外部企业设备和真实计费模型验收仍待完成。本次 Linux/三平台 CI 不替代你的真机反馈。原始 manifest 中 published:false 表示构建时尚未发布；以本 Release 和精确提交/摘要为分发依据。\n";
  await writeFile(path.join(output, "release-notes.md"), notes);
  const tag = `v${VERSION}`;
  // Fail closed on existing tags/releases. Never replace a published asset or move a tag.
  const refs = execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: "utf8" });
  assert.equal(refs.trim(), "", "Release tag already exists; inspect it instead of overwriting");
  // Draft releases do not reliably materialize their tag until publication.
  // Create a non-forced tag first so it can be checked before making assets public.
  execFileSync("git", ["tag", tag, commit], { timeout: 30_000 });
  execFileSync("git", ["push", "origin", `refs/tags/${tag}`], { timeout: 60_000 });
  gh("release", "create", tag, "--repo", REPOSITORY, "--target", commit, "--draft", "--prerelease", "--latest=false", "--title", `Xiu ${VERSION} · Windows x64 真机测试版`, "--notes-file", path.join(output, "release-notes.md"), ...assets.map((asset) => path.join(output, asset.name)));
  const tagObject = JSON.parse(gh("api", `repos/${REPOSITORY}/git/ref/tags/${tag}`));
  assert.equal(tagObject.object.sha, commit, "Tag must identify this exact source commit");
  assert.equal(tagObject.object.type, "commit");
  const downloaded = path.join(output, "readback");
  gh("release", "download", tag, "--repo", REPOSITORY, "--dir", downloaded);
  for (const { name, bytes } of assets) assert.deepEqual(await readFile(path.join(downloaded, name)), bytes, `Release readback mismatch: ${name}`);
  gh("release", "edit", tag, "--repo", REPOSITORY, "--draft=false", "--prerelease", "--latest=false");
  console.log(`Published verified prerelease: https://github.com/${REPOSITORY}/releases/tag/${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
