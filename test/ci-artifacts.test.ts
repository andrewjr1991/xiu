import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactContext, verificationContext, writeReport } from "../scripts/ci-artifacts.mjs";

const cliSteps = () => Object.fromEntries(["dependencies", "python", "docs", "typecheck", "tests", "migration", "build", "evaluation", "pack_audit", "candidate", "package_smoke", "platform_smoke"].map((id) => [id, { outcome: "success" }]));
const desktopSteps = () => Object.fromEntries(["dependencies", "desktop_dependencies", "typecheck", "build", "smoke", "ui", "ui_evidence", "ui_evidence_upload", "browser"].map((id) => [id, { outcome: "success" }]));

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "xiu-ci-artifacts-")));
  await mkdir(path.join(root, "apps/desktop"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@xiu-ai/cli", version: "0.20.2" }));
  await writeFile(path.join(root, "apps/desktop/package.json"), JSON.stringify({ name: "@xiu-ai/desktop", version: "0.20.2" }));
  await writeFile(path.join(root, ".gitignore"), ".validation-ci/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Xiu CI Fixture", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "fixture");
  return { root, commit: git("rev-parse", "HEAD").trim(), close: () => rm(root, { recursive: true, force: true }) };
}

test("CI candidate acceptance uses original outcomes, never a masked conclusion", () => {
  const steps = cliSteps();
  assert.equal(verificationContext("cli", "linux", steps).status, "passed");
  steps.tests = { outcome: "failure", conclusion: "success" } as typeof steps.tests;
  assert.equal(verificationContext("cli", "linux", steps).status, "failed");
  delete steps.tests;
  assert.equal(verificationContext("cli", "linux", steps).status, "incomplete");
  steps.tests = { outcome: "skipped" };
  assert.equal(verificationContext("cli", "linux", steps).status, "incomplete");
});

test("Windows CLI requires the privacy preflight and cannot mask its failure", () => {
  const steps: Record<string, { outcome: string; conclusion?: string }> = cliSteps();
  assert.equal(verificationContext("cli", "win32", steps).status, "incomplete");
  steps.provider_privacy = { outcome: "failure", conclusion: "success" };
  assert.equal(verificationContext("cli", "win32", steps).status, "failed");
  steps.tests = { outcome: "skipped" };
  assert.equal(verificationContext("cli", "win32", steps).checks.tests, "skipped");
  assert.equal(verificationContext("cli", "win32", steps).status, "failed");
  steps.provider_privacy = { outcome: "success" };
  assert.equal(verificationContext("cli", "win32", steps).status, "incomplete");
  steps.tests = { outcome: "success" };
  assert.equal(verificationContext("cli", "win32", steps).status, "incomplete");
  steps.windows_regressions = { outcome: "failure", conclusion: "success" };
  assert.equal(verificationContext("cli", "win32", steps).status, "failed");
  steps.windows_regressions = { outcome: "skipped" };
  assert.equal(verificationContext("cli", "win32", steps).status, "incomplete");
  steps.windows_regressions = { outcome: "success" };
  assert.equal(verificationContext("cli", "win32", steps).status, "passed");
  delete steps.provider_privacy;
  delete steps.windows_regressions;
  assert.equal(verificationContext("cli", "linux", steps).status, "passed");
});

test("desktop checks require browser isolation and Windows installer acceptance", () => {
  const steps = desktopSteps();
  assert.equal(verificationContext("desktop", "linux", steps).status, "passed");
  assert.equal(verificationContext("desktop", "win32", steps).status, "incomplete");
  delete steps.browser;
  assert.equal(verificationContext("desktop", "linux", steps).status, "incomplete");
});

test("desktop evidence validation and upload are required on every platform", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const gate of ["ui_evidence", "ui_evidence_upload"]) {
      const steps: Record<string, { outcome: string; conclusion?: string }> = {
        ...desktopSteps(), installer: { outcome: "success" }, installer_smoke: { outcome: "success" }, candidate: { outcome: "success" },
      };
      assert.equal(verificationContext("desktop", platform, steps).status, "passed");
      steps[gate] = { outcome: "failure", conclusion: "success" };
      assert.equal(verificationContext("desktop", platform, steps).status, "failed");
      assert.equal(verificationContext("desktop", platform, steps).checks[gate], "failure");
      steps[gate] = { outcome: "skipped" };
      assert.equal(verificationContext("desktop", platform, steps).status, "incomplete");
      delete steps[gate];
      assert.equal(verificationContext("desktop", platform, steps).status, "incomplete");
    }
  }
});

test("CI reports bind candidates, checksums and test outcomes to the exact commit", async () => {
  const f = await fixture();
  try {
    const env = { XIU_CI_PLATFORM: "linux", GITHUB_SHA: f.commit, XIU_CI_STEPS: JSON.stringify(cliSteps()), GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "example/xiu", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" };
    const context = await artifactContext(f.root, "cli", env);
    await mkdir(context.staging, { recursive: true });
    const candidate = Buffer.from("local fixture tarball");
    await writeFile(path.join(context.staging, context.candidateName), candidate);
    const manifest = await writeReport(f.root, "cli", env);
    assert.equal(manifest.source.commit, f.commit);
    assert.equal(manifest.package.version, "0.20.2");
    assert.equal(manifest.candidate.acceptance, "job-checks-passed");
    assert.equal(manifest.build.runAttempt, "2");
    assert.ok(context.artifactName.includes(f.commit));
    assert.ok(context.candidateName.includes(f.commit));
    assert.equal(manifest.files[0].sha256, createHash("sha256").update(candidate).digest("hex"));
    const json = await readFile(path.join(context.directory, "manifest.json"));
    const sums = await readFile(path.join(context.directory, "SHA256SUMS"), "utf8");
    assert.ok(sums.includes(`${manifest.files[0].sha256}  ${context.candidateName}`));
    assert.ok(sums.includes(`${createHash("sha256").update(json).digest("hex")}  manifest.json`));
    assert.deepEqual(await readFile(path.join(context.directory, context.candidateName)), candidate);
  } finally { await f.close(); }
});

test("desktop candidates stay unaccepted when screenshot evidence is failed or missing", async () => {
  const f = await fixture();
  try {
    const env = { XIU_CI_PLATFORM: "win32", GITHUB_SHA: f.commit };
    const context = await artifactContext(f.root, "desktop", env);
    await mkdir(context.staging, { recursive: true });
    await writeFile(path.join(context.staging, context.candidateName), "synthetic installer fixture");
    for (const gate of ["ui_evidence", "ui_evidence_upload"]) {
      for (const outcome of ["failure", "skipped", undefined]) {
        const steps: Record<string, { outcome: string }> = {
          ...desktopSteps(), installer: { outcome: "success" }, installer_smoke: { outcome: "success" }, candidate: { outcome: "success" },
        };
        if (outcome) steps[gate] = { outcome }; else delete steps[gate];
        const manifest = await writeReport(f.root, "desktop", { ...env, XIU_CI_STEPS: JSON.stringify(steps) });
        assert.equal(manifest.source.worktreeModified, false);
        assert.equal(manifest.candidate.available, true);
        assert.equal(manifest.candidate.acceptance, "unaccepted-candidate");
        assert.equal(manifest.verification.status, outcome === "failure" ? "failed" : "incomplete");
      }
    }
  } finally { await f.close(); }
});

test("a failed gate keeps a built candidate available but explicitly unaccepted", async () => {
  const f = await fixture();
  try {
    const steps = { ...cliSteps(), tests: { outcome: "failure", outputs: { secret: "DO-NOT-EXPORT" } } };
    const env = { XIU_CI_PLATFORM: "linux", XIU_CI_STEPS: JSON.stringify(steps) };
    const context = await artifactContext(f.root, "cli", env);
    await mkdir(context.staging, { recursive: true });
    await writeFile(path.join(context.staging, context.candidateName), "candidate");
    const manifest = await writeReport(f.root, "cli", env);
    assert.equal(manifest.candidate.available, true);
    assert.equal(manifest.candidate.acceptance, "unaccepted-candidate");
    assert.equal(manifest.verification.checks.tests, "failure");
    assert.equal(JSON.stringify(manifest).includes("DO-NOT-EXPORT"), false);
  } finally { await f.close(); }
});

test("failed or skipped packaging still produces a truthful progress record", async () => {
  const f = await fixture();
  try {
    const steps = { ...cliSteps(), build: { outcome: "failure" }, candidate: { outcome: "skipped" } };
    const env = { XIU_CI_PLATFORM: "linux", XIU_CI_STEPS: JSON.stringify(steps) };
    const context = await artifactContext(f.root, "cli", env);
    await mkdir(context.staging, { recursive: true });
    await writeFile(path.join(context.staging, context.candidateName), "stale-unverified-file");
    const manifest = await writeReport(f.root, "cli", env);
    assert.equal(manifest.candidate.available, false);
    assert.equal(manifest.candidate.acceptance, "unavailable");
    assert.deepEqual(manifest.files, []);
    await assert.rejects(readFile(path.join(context.directory, context.candidateName)), { code: "ENOENT" });
    assert.match(await readFile(path.join(context.directory, "progress.md"), "utf8"), /No installable candidate/);
  } finally { await f.close(); }
});

test("CI reports reject mismatched commits and missing claimed candidates", async () => {
  const f = await fixture();
  try {
    await assert.rejects(artifactContext(f.root, "cli", { GITHUB_SHA: "a".repeat(40) }), /does not match/);
    await assert.rejects(writeReport(f.root, "cli", { XIU_CI_STEPS: JSON.stringify(cliSteps()) }), { code: "ENOENT" });
    await assert.rejects(artifactContext(f.root, "cli", { XIU_CI_PLATFORM: "../../outside" }), /Invalid platform/);
  } finally { await f.close(); }
});

test("CI keeps failed checks visible and uploads candidates without publishing", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/ci.yml"), "utf8");
  assert.equal(workflow.includes("continue-on-error:"), false);
  assert.equal(workflow.includes("cancel-in-progress: true"), false);
  assert.equal(workflow.includes("installer:msix"), false);
  assert.equal(workflow.includes("npm publish"), false);
  assert.match(workflow, /python test\/xiu-search-auth-migration\.test\.py -v/);
  assert.match(workflow, /xvfb-run --auto-servernum npm --prefix apps\/desktop run smoke:browser/);
  assert.match(workflow, /XIU_PACKAGE_ARCHIVE: \$\{\{ steps\.candidate\.outputs\.archive \}\}/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /id: provider_privacy/);
  assert.match(workflow, /node --test --import tsx test\/provider-windows-privacy\.test\.ts/);
  assert.match(workflow, /id: windows_regressions/);
  assert.match(workflow, /--test-name-pattern="workspace cleanup\|rapid detached commands\|CLI current action" test\/background\.test\.ts test\/provider-recovery-entry\.test\.ts/);
  assert.match(workflow, /steps\.provider_privacy\.outcome == 'success' && steps\.windows_regressions\.outcome == 'success'/);
  const desktopWorkflow = workflow.slice(workflow.indexOf("\n  desktop:"));
  const validationIndex = desktopWorkflow.indexOf("id: ui_evidence\n");
  const uploadIndex = desktopWorkflow.indexOf("id: ui_evidence_upload\n");
  const reportIndex = desktopWorkflow.indexOf("id: report\n");
  assert.ok(validationIndex >= 0 && uploadIndex > validationIndex && reportIndex > uploadIndex, "desktop report must observe evidence validation and upload outcomes");
  const helper = await readFile(path.resolve("apps/desktop/scripts/package-windows.mjs"), "utf8");
  assert.match(helper, /"--publish", "never"/);
});

test("dirty source is recorded and cannot be labelled an accepted candidate", async () => {
  const f = await fixture();
  try {
    const env = { XIU_CI_PLATFORM: "linux", XIU_CI_STEPS: JSON.stringify(cliSteps()), GITHUB_RUN_ATTEMPT: "3" };
    const context = await artifactContext(f.root, "cli", env);
    assert.ok(context.artifactName.endsWith("-attempt3"));
    await mkdir(context.staging, { recursive: true });
    await writeFile(path.join(context.staging, context.candidateName), "candidate");
    await writeFile(path.join(f.root, "uncommitted-source.txt"), "change");
    const manifest = await writeReport(f.root, "cli", env);
    assert.equal(manifest.source.worktreeModified, true);
    assert.equal(manifest.candidate.acceptance, "unaccepted-candidate");
    assert.equal(manifest.verification.status, "passed");
  } finally { await f.close(); }
});
