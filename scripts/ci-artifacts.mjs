import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CLI_CHECKS = ["dependencies", "python", "docs", "typecheck", "tests", "migration", "build", "evaluation", "pack_audit", "candidate", "package_smoke", "platform_smoke"];
const DESKTOP_CHECKS = ["dependencies", "desktop_dependencies", "typecheck", "build", "smoke", "ui", "ui_evidence", "ui_evidence_upload", "browser"];
const OUTCOMES = new Set(["success", "failure", "cancelled", "skipped"]);

export function verificationContext(kind, platform, steps) {
  const required = kind === "cli" ? [...CLI_CHECKS, ...(platform === "win32" ? ["provider_privacy", "windows_regressions"] : [])] : [...DESKTOP_CHECKS, ...(platform === "win32" ? ["installer", "installer_smoke", "candidate"] : [])];
  const checks = Object.fromEntries(required.map((name) => [name, OUTCOMES.has(steps[name]?.outcome) ? steps[name].outcome : "not-run"]));
  const values = Object.values(checks);
  return {
    scope: "This job only; check all jobs for this exact commit before accepting the candidate.",
    status: values.includes("failure") ? "failed" : values.every((value) => value === "success") ? "passed" : "incomplete",
    checks,
  };
}

function safePart(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export async function artifactContext(root, kind, env = process.env) {
  if (!["cli", "desktop"].includes(kind)) throw new Error("Expected cli or desktop artifact kind");
  const packagePath = kind === "cli" ? "package.json" : "apps/desktop/package.json";
  const pkg = JSON.parse(await readFile(path.join(root, packagePath), "utf8"));
  const version = safePart(pkg.version, "package version");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  if (!/^[a-f0-9]{40}$/u.test(commit) || (env.GITHUB_SHA && env.GITHUB_SHA !== commit)) throw new Error("Checked-out commit does not match GITHUB_SHA");
  const worktreeModified = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8", windowsHide: true }).trim().length > 0;
  const platform = safePart(env.XIU_CI_PLATFORM ?? process.platform, "platform");
  const candidateName = kind === "cli" ? `xiu-ai-cli-${version}-${commit}.tgz` : platform === "win32" ? `Xiu-${version}-x64-${commit}-unsigned.exe` : null;
  const attempt = safePart(env.GITHUB_RUN_ATTEMPT ?? "1", "run attempt");
  const artifactName = `xiu-${kind}-${version}-${platform}-${commit}-attempt${attempt}`;
  const directory = path.join(root, ".validation-ci", kind, platform, artifactName, "bundle");
  const staging = path.dirname(directory);
  return { kind, version, commit, worktreeModified, platform, packageName: pkg.name, artifactName, directory, staging, candidateName };
}

async function output(values, env) {
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${String(value).replaceAll("\\", "/")}\n`).join(""));
}

export async function prepareCandidate(root, kind, env = process.env) {
  const context = await artifactContext(root, kind, env);
  if (!context.candidateName) throw new Error("Only Windows x64 desktop installers are distributed");
  await mkdir(context.staging, { recursive: true });
  const archive = path.join(context.staging, context.candidateName);
  if (kind === "cli") {
    const npmCli = [env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find((file) => file && existsSync(file));
    if (!npmCli) throw new Error("Could not locate npm-cli.js for candidate packaging");
    const packed = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", context.staging], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 180_000 }));
    if (packed.length !== 1 || packed[0].name !== context.packageName || packed[0].version !== context.version || path.basename(packed[0].filename) !== packed[0].filename || !packed[0].filename.endsWith(".tgz")) throw new Error("npm pack returned an unexpected package identity");
    await rename(path.join(context.staging, packed[0].filename), archive);
  } else {
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Desktop candidates must be produced on Windows x64");
    await copyFile(path.join(root, "apps/desktop/release", `Xiu-${context.version}-x64.exe`), archive);
  }
  if ((await stat(archive)).size === 0) throw new Error("Candidate artifact is empty");
  await output({ archive }, env);
  console.log(`Prepared ${context.candidateName}`);
  return archive;
}

export async function writeReport(root, kind, env = process.env) {
  const context = await artifactContext(root, kind, env);
  await mkdir(context.directory, { recursive: true });
  const steps = JSON.parse(env.XIU_CI_STEPS ?? "{}");
  const verification = verificationContext(kind, context.platform, steps);
  const files = [];
  if (context.candidateName) await rm(path.join(context.directory, context.candidateName), { force: true });
  if (context.candidateName && steps.candidate?.outcome === "success") {
    const candidatePath = path.join(context.staging, context.candidateName);
    const bytes = await readFile(candidatePath);
    if (bytes.length === 0) throw new Error("Candidate artifact is empty");
    await copyFile(candidatePath, path.join(context.directory, context.candidateName));
    files.push({ name: context.candidateName, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const manifest = {
    schemaVersion: 1,
    package: { name: context.packageName, version: context.version },
    source: { commit: context.commit, worktreeModified: context.worktreeModified, event: env.GITHUB_EVENT_NAME ?? "local", ref: env.GITHUB_REF ?? null, pullRequestHeadCommit: env.XIU_PR_HEAD_SHA || null },
    build: { createdAt: new Date().toISOString(), platform: context.platform, architecture: process.arch, node: process.version, runnerOs: env.RUNNER_OS ?? null, runId: env.GITHUB_RUN_ID ?? null, runAttempt: env.GITHUB_RUN_ATTEMPT ?? null, runUrl },
    candidate: { available: files.length > 0, format: kind === "cli" ? "npm-tarball" : context.platform === "win32" ? "unsigned-windows-x64-nsis" : "no-desktop-distribution", published: false, acceptance: verification.status === "passed" && !context.worktreeModified && files.length > 0 ? "job-checks-passed" : files.length > 0 ? "unaccepted-candidate" : "unavailable" },
    verification,
    files,
  };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(context.directory, "manifest.json"), json);
  const checksums = [...files.map((file) => `${file.sha256}  ${file.name}`), `${createHash("sha256").update(json).digest("hex")}  manifest.json`];
  await writeFile(path.join(context.directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  const summary = [`## ${context.packageName} ${context.version} (${context.platform})`, "", `Commit: ${context.commit}`, `Source worktree modified: ${context.worktreeModified}`, `Candidate: ${manifest.candidate.acceptance}`, `Verification: ${verification.status} (this job only)`, ...(runUrl ? [`Run: ${runUrl}`] : []), "", ...Object.entries(verification.checks).map(([check, outcome]) => `- ${check}: ${outcome}`), "", "Candidates are for testing, not a release. Check every job for this exact commit before accepting.", ...(kind === "desktop" && context.platform === "win32" ? ["Windows x64 NSIS is unsigned; no signing or Microsoft Store submission was performed."] : []), ...(files.length ? [] : ["No installable candidate was produced by this job; inspect failed or skipped build steps."]), ""].join("\n");
  await writeFile(path.join(context.directory, "progress.md"), summary);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary);
  await output({ artifact_name: context.artifactName, directory: context.directory, version: context.version }, env);
  console.log(summary);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, kind] = process.argv.slice(2);
  if (command === "prepare") await prepareCandidate(process.cwd(), kind);
  else if (command === "report") await writeReport(process.cwd(), kind);
  else throw new Error("Usage: node scripts/ci-artifacts.mjs <prepare|report> <cli|desktop>");
}
