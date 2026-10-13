import assert from "node:assert/strict";
import test from "node:test";
import { assertCommit, releaseAssets, releaseNotes, selectArtifact, selectCiRun, sha256, verifyBundle, verifyJobs, type WorkflowRun } from "../scripts/release-draft.mjs";

const commit = "a".repeat(40);
const other = "b".repeat(40);
const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 42, head_sha: commit, head_branch: "main", event: "push", path: ".github/workflows/ci.yml",
  status: "completed", conclusion: "success", created_at: "2026-10-13T10:00:00Z", run_attempt: 1,
  html_url: "https://github.com/andrewjr1991/xiu/actions/runs/42", ...overrides,
});

function bundle(kind: "cli" | "desktop", overrides: { manifest?: Record<string, unknown>; candidate?: Buffer } = {}) {
  const name = kind === "cli" ? `xiu-ai-cli-0.21.0-${commit}.tgz` : `Xiu-0.21.0-x64-${commit}-unsigned.exe`;
  const bytes = Buffer.from(`${kind} candidate`);
  const manifest = {
    schemaVersion: 1,
    package: { name: kind === "cli" ? "@xiu-ai/cli" : "@xiu-ai/desktop", version: "0.21.0" },
    source: { commit, worktreeModified: false, event: "push", ref: "refs/heads/main", pullRequestHeadCommit: null },
    build: { platform: "win32", runId: "42", runAttempt: "1" },
    candidate: { available: true, published: false, acceptance: "job-checks-passed" },
    verification: { status: "passed", checks: {} },
    files: [{ name, bytes: bytes.length, sha256: sha256(bytes) }],
    ...overrides.manifest,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  return new Map<string, Buffer>([
    [name, overrides.candidate ?? bytes],
    ["manifest.json", Buffer.from(manifestText)],
    ["SHA256SUMS", Buffer.from(`${sha256(bytes)}  ${name}\n${sha256(Buffer.from(manifestText))}  manifest.json\n`)],
    ["progress.md", Buffer.from("notes")],
  ]);
}
const expected = { version: "0.21.0", commit, runId: 42 };

test("release drafts only accept a full commit SHA", () => {
  assert.equal(assertCommit(commit), commit);
  for (const bad of ["main", "a".repeat(39), "A".repeat(40), `${commit}\n`, undefined]) assert.throws(() => assertCommit(bad), /40-character/);
});

test("the CI run must be the newest successful main push for exactly this commit", () => {
  assert.equal(selectCiRun([run({ id: 1, head_sha: other }), run()], commit).id, 42);
  assert.equal(selectCiRun([run({ id: 1, created_at: "2026-10-13T09:00:00Z" }), run({ id: 2 })], commit).id, 2);
  assert.throws(() => selectCiRun([run({ event: "pull_request" }), run({ head_branch: "codex/x" })], commit), /No main push CI run/);
  assert.throws(() => selectCiRun([run({ id: 1, created_at: "2026-10-13T09:00:00Z" }), run({ id: 2, conclusion: "failure" })], commit), /not a success/);
  assert.throws(() => selectCiRun([run({ status: "in_progress", conclusion: null })], commit), /not a success/);
});

test("every job must pass and the newest artifact attempt wins", () => {
  assert.equal(verifyJobs([{ name: "a", status: "completed", conclusion: "success" }]), 1);
  assert.throws(() => verifyJobs([]), /no jobs/);
  assert.throws(() => verifyJobs([{ name: "Verify", status: "completed", conclusion: "skipped" }]), /Verify \(skipped\)/);
  const name = (attempt: string, platform = "win32") => ({ name: `xiu-cli-0.21.0-${platform}-${commit}-attempt${attempt}`, expired: false });
  assert.equal(selectArtifact([name("1"), name("2"), name("3", "linux")], "cli", "0.21.0", commit).name, name("2").name);
  assert.throws(() => selectArtifact([{ ...name("1"), expired: true }], "cli", "0.21.0", commit), /missing or expired/);
  assert.throws(() => selectArtifact([name("1x")], "cli", "0.21.0", commit), /missing or expired/);
});

test("a CI bundle is accepted only when it matches the commit, version, run and its own checksums", () => {
  const verified = verifyBundle("cli", bundle("cli"), expected);
  assert.equal(verified.name, `xiu-ai-cli-0.21.0-${commit}.tgz`);
  const rejects = (input: Map<string, Buffer>, pattern: RegExp) => assert.throws(() => verifyBundle("cli", input, expected), pattern);
  rejects(bundle("cli", { candidate: Buffer.from("tampered") }), /checksum or size/);
  rejects(bundle("cli", { manifest: { source: { commit: other, worktreeModified: false, event: "push", ref: "refs/heads/main" } } }), /commit b+/);
  rejects(bundle("cli", { manifest: { source: { commit, worktreeModified: true, event: "push", ref: "refs/heads/main" } } }), /modified worktree/);
  rejects(bundle("cli", { manifest: { source: { commit, worktreeModified: false, event: "pull_request", ref: "refs/pull/1/merge" } } }), /main push/);
  rejects(bundle("cli", { manifest: { candidate: { acceptance: "unaccepted-candidate" } } }), /acceptance/);
  rejects(bundle("cli", { manifest: { build: { platform: "linux", runId: "42" } } }), /platform linux/);
  rejects(bundle("cli", { manifest: { build: { platform: "win32", runId: "41" } } }), /run 41/);
  const forged = bundle("cli");
  forged.set("manifest.json", Buffer.from(forged.get("manifest.json")!.toString().replace('"0.21.0"', '"0.21.0" ')));
  rejects(forged, /manifest checksum/);
});

test("release assets keep the original candidates and list every file in SHA256SUMS", () => {
  const assets = releaseAssets("0.21.0", verifyBundle("cli", bundle("cli"), expected), verifyBundle("desktop", bundle("desktop"), expected));
  assert.deepEqual(assets.map((asset) => asset.name), [
    `xiu-ai-cli-0.21.0-${commit}.tgz`, `Xiu-0.21.0-x64-${commit}-unsigned.exe`, "cli-0.21.0-manifest.json", "desktop-0.21.0-manifest.json", "SHA256SUMS-0.21.0",
  ]);
  assert.equal(assets[0]!.bytes.toString(), "cli candidate");
  const sums = assets.at(-1)!.bytes.toString().trim().split("\n");
  assert.deepEqual(sums, assets.slice(0, -1).map((asset) => `${sha256(asset.bytes)}  ${asset.name}`));
});

test("draft notes use the version's changelog section and state that nothing was published", () => {
  const changelog = "# Changelog\n\n## Unreleased\n\n- pending\n\n## 0.21.0 — 2026-10-20\n\n- shipped thing\n\n## 0.20.8 — 2026-10-13\n\n- old\n";
  const notes = releaseNotes(changelog, "0.21.0", commit, run(), 9);
  assert.match(notes, /- shipped thing/);
  assert.doesNotMatch(notes, /pending|old/);
  assert.match(notes, new RegExp(`\`${commit}\``));
  assert.match(notes, /\[42\]\(https:\/\/github\.com\/andrewjr1991\/xiu\/actions\/runs\/42\)，9 项作业全部通过/);
  assert.match(notes, /不会发布 npm/);
  assert.match(releaseNotes("# Changelog\n\n## Unreleased\n\n- pending\n", "0.21.0", commit, run(), 9), /- pending/);
});
