import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BRANCH, VERSION, validateBundle, validateJobs } from "../.github/scripts/device-test-release.mjs";

const commit = "a".repeat(40);
function jobs() {
  return [
    ...["windows-latest", "ubuntu-latest", "macos-26-intel"].map((os) => `Verify (${os}, Node 20.18.1)`),
    ...["windows-latest", "ubuntu-latest", "macos-26-intel"].map((os) => `Desktop (${os})`),
    "Compat (ubuntu-latest, Node 22)", "Compat (ubuntu-latest, Node 24)", "Dependency audit",
  ].map((name) => ({ name, head_sha: commit, status: "completed", conclusion: "success" }));
}

test("device release requires all nine exact-commit gates, including audit and both compat jobs", () => {
  validateJobs(jobs(), commit);
  for (let index = 0; index < 9; index++) {
    assert.throws(() => validateJobs(jobs().filter((_, i) => i !== index), commit));
    for (const conclusion of ["failure", "cancelled", "skipped", "neutral"]) {
      const changed = jobs(); changed[index]!.conclusion = conclusion;
      assert.throws(() => validateJobs(changed, commit));
    }
    const stale = jobs(); stale[index]!.head_sha = "b".repeat(40);
    assert.throws(() => validateJobs(stale, commit));
    const unfinished = jobs(); unfinished[index]!.status = "in_progress";
    assert.throws(() => validateJobs(unfinished, commit));
  }
  assert.throws(() => validateJobs([...jobs(), jobs()[0]!], commit));
});

for (const kind of ["cli", "desktop"] as const) {
  test(`device release rejects stale, dirty, unverified and substituted ${kind} artifacts`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "xiu-release-"));
    const bytes = Buffer.from("deterministic CI candidate fixture");
    const name = kind === "cli" ? `xiu-ai-cli-${VERSION}-${commit}.tgz` : `Xiu-${VERSION}-x64-${commit}-unsigned.exe`;
    const manifest = {
      schemaVersion: 1, package: { name: `@xiu-ai/${kind}`, version: VERSION },
      source: { commit, worktreeModified: false, event: "push", ref: `refs/heads/${BRANCH}` },
      build: { platform: kind === "cli" ? "linux" : "win32", architecture: "x64", runId: "123", runAttempt: "1" },
      candidate: { acceptance: "job-checks-passed" }, verification: { status: "passed", checks: { tests: "success" } },
      files: [{ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
    };
    try {
      await writeFile(path.join(root, name), bytes);
      await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
      assert.deepEqual((await validateBundle(root, kind, commit, "123", "1")).bytes, bytes);
      const variants = [
        { ...manifest, source: { ...manifest.source, commit: "b".repeat(40) } },
        { ...manifest, source: { ...manifest.source, worktreeModified: true } },
        { ...manifest, source: { ...manifest.source, event: "pull_request" } },
        { ...manifest, source: { ...manifest.source, ref: "refs/heads/main" } },
        { ...manifest, package: { ...manifest.package, version: "0.20.12" } },
        { ...manifest, build: { ...manifest.build, runId: "122" } },
        { ...manifest, build: { ...manifest.build, runAttempt: "2" } },
        { ...manifest, build: { ...manifest.build, architecture: "arm64" } },
        { ...manifest, verification: { status: "passed", checks: { tests: "failure" } } },
        { ...manifest, verification: { status: "passed", checks: {} } },
        { ...manifest, candidate: { acceptance: "unaccepted-candidate" } },
        { ...manifest, files: [{ ...manifest.files[0], name: "../outside" }] },
        { ...manifest, files: [{ ...manifest.files[0], sha256: "b".repeat(64) }] },
      ];
      for (const variant of variants) {
        await writeFile(path.join(root, "manifest.json"), JSON.stringify(variant));
        await assert.rejects(validateBundle(root, kind, commit, "123", "1"));
      }
      await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
      await writeFile(path.join(root, name), "substituted bytes");
      await assert.rejects(validateBundle(root, kind, commit, "123", "1"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
