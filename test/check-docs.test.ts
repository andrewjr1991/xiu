import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/check-docs.mjs");
const version = "0.20.3-preview.1";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xiu-docs-check-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@xiu-ai/cli", version }));
  for (const name of ["README.md", "README.zh-CN.md", "QUICKSTART.md", "CONTRIBUTING.md", "CHANGELOG.md", "ROADMAP.zh-CN.md", "SECURITY.zh-CN.md", "USAGE.zh-CN.md", "PUBLISHING.zh-CN.md"]) {
    await writeFile(path.join(root, name), `npm install -g @xiu-ai/cli\n| 当前开发版本 | \`${version}\` |\n不伪造 Provider API 未返回的隐藏思维链\n`);
  }
  await writeFile(path.join(root, `V${version}_DESIGN.zh-CN.md`), "Current design");
  return root;
}

test("documentation checks recognize the exact prerelease design filename", async () => {
  const root = await fixture();
  try {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prerelease support still rejects additional stable or prerelease designs", async () => {
  for (const stale of ["V0.20.2_DESIGN.zh-CN.md", "V0.20.3-preview.0_DESIGN.zh-CN.md"]) {
    const root = await fixture();
    try {
      await writeFile(path.join(root, stale), "Stale design");
      const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Expected only V0\.20\.3-preview\.1_DESIGN/);
      assert.ok(result.stderr.includes(stale));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
