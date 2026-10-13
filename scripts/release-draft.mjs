// Builds a GitHub Release *draft* from the original main-CI candidates of one exact commit.
// It never publishes the release, creates a tag, or publishes to npm: a draft has no tag
// until a maintainer publishes it, and npm stays a separate maintainer step.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
// Windows runs the full CLI gate (including provider privacy and recovery regressions)
// and is the only platform that produces the desktop installer.
const CANDIDATE_PLATFORM = "win32";

export function assertCommit(value) {
  if (typeof value !== "string" || !COMMIT.test(value)) throw new Error("Expected a full 40-character lowercase commit SHA");
  return value;
}

export function assertVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value)) throw new Error("Unexpected package version");
  return value;
}

/** The newest completed push run of CI on main for exactly this commit; it must have succeeded. */
export function selectCiRun(runs, commit) {
  const candidates = runs
    .filter((run) => run.head_sha === commit && run.event === "push" && run.head_branch === "main" && run.path === ".github/workflows/ci.yml")
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const run = candidates[0];
  if (!run) throw new Error(`No main push CI run found for ${commit}`);
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error(`Main CI run ${run.id} for ${commit} is ${run.status}/${run.conclusion ?? "pending"}, not a success`);
  return run;
}

/** Every job of the run's latest attempt must have succeeded; a skipped or re-run-pending job is not accepted. */
export function verifyJobs(jobs) {
  if (jobs.length === 0) throw new Error("CI run reported no jobs");
  const failed = jobs.filter((job) => job.status !== "completed" || job.conclusion !== "success");
  if (failed.length) throw new Error(`CI jobs did not all pass: ${failed.map((job) => `${job.name} (${job.conclusion ?? job.status})`).join(", ")}`);
  return jobs.length;
}

/** The newest unexpired upload of one candidate artifact (a re-run job uploads under a higher attempt). */
export function selectArtifact(artifacts, kind, version, commit) {
  const prefix = `xiu-${kind}-${version}-${CANDIDATE_PLATFORM}-${commit}-attempt`;
  const matches = artifacts
    .filter((artifact) => !artifact.expired && artifact.name.startsWith(prefix) && /^\d+$/u.test(artifact.name.slice(prefix.length)))
    .sort((left, right) => Number(right.name.slice(prefix.length)) - Number(left.name.slice(prefix.length)));
  if (!matches[0]) throw new Error(`CI artifact ${prefix}* is missing or expired`);
  return matches[0];
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseSums(text) {
  return new Map(text.trim().split(/\r?\n/u).map((line) => {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw new Error("Unreadable SHA256SUMS line");
    return [match[2], match[1]];
  }));
}

/**
 * Checks a downloaded CI bundle against its own manifest and checksums, and against the
 * commit, version and run being released. Returns the one candidate file it vouches for.
 */
export function verifyBundle(kind, bundle, expected) {
  const manifestText = bundle.get("manifest.json")?.toString("utf8");
  const sumsText = bundle.get("SHA256SUMS")?.toString("utf8");
  if (!manifestText || !sumsText) throw new Error(`${kind} bundle is missing manifest.json or SHA256SUMS`);
  const manifest = JSON.parse(manifestText);
  const sums = parseSums(sumsText);
  const problems = [];
  if (manifest.schemaVersion !== 1) problems.push("unknown manifest schema");
  if (manifest.package?.version !== expected.version) problems.push(`version ${manifest.package?.version}`);
  if (manifest.source?.commit !== expected.commit) problems.push(`commit ${manifest.source?.commit}`);
  if (manifest.source?.worktreeModified !== false) problems.push("modified worktree");
  if (manifest.source?.event !== "push" || manifest.source?.ref !== "refs/heads/main") problems.push("not built from a main push");
  if (manifest.build?.runId !== String(expected.runId)) problems.push(`run ${manifest.build?.runId}`);
  if (manifest.build?.platform !== CANDIDATE_PLATFORM) problems.push(`platform ${manifest.build?.platform}`);
  if (manifest.candidate?.acceptance !== "job-checks-passed" || manifest.verification?.status !== "passed") problems.push(`acceptance ${manifest.candidate?.acceptance}/${manifest.verification?.status}`);
  if (sums.get("manifest.json") !== sha256(Buffer.from(manifestText))) problems.push("manifest checksum");
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length !== 1) problems.push(`${files.length} candidate files`);
  const file = files[0];
  const bytes = file ? bundle.get(file.name) : undefined;
  if (file && !bytes) problems.push(`missing ${file.name}`);
  if (file && bytes && (bytes.length !== file.bytes || sha256(bytes) !== file.sha256 || sums.get(file.name) !== file.sha256)) problems.push(`${file.name} checksum or size`);
  if (problems.length) throw new Error(`${kind} candidate rejected: ${problems.join("; ")}`);
  return { name: file.name, bytes, manifestText };
}

/** The five release assets, named as earlier releases named them, with their checksum file last. */
export function releaseAssets(version, cli, desktop) {
  const assets = [
    { name: cli.name, bytes: cli.bytes },
    { name: desktop.name, bytes: desktop.bytes },
    { name: `cli-${version}-manifest.json`, bytes: Buffer.from(cli.manifestText) },
    { name: `desktop-${version}-manifest.json`, bytes: Buffer.from(desktop.manifestText) },
  ];
  const sums = `${assets.map((asset) => `${sha256(asset.bytes)}  ${asset.name}`).join("\n")}\n`;
  return [...assets, { name: `SHA256SUMS-${version}`, bytes: Buffer.from(sums) }];
}

/** Draft notes: the version's CHANGELOG section (or Unreleased) plus where the assets came from. */
export function releaseNotes(changelog, version, commit, run, jobCount) {
  const sections = changelog.split(/^## /mu).slice(1);
  const section = sections.find((item) => item.startsWith(`${version} `) || item.startsWith(`${version}\n`))
    ?? sections.find((item) => item.startsWith("Unreleased"));
  const body = section ? section.slice(section.indexOf("\n") + 1).trim() : "";
  return [
    `## Xiu ${version}`,
    "",
    body || "（请填写本版本要点。）",
    "",
    "## 验证与来源",
    "",
    `精确 main 源提交：\`${commit}\`。`,
    `CI：[${run.id}](${run.html_url})，${jobCount} 项作业全部通过。附件直接取自该运行的 Windows CLI tarball、未签名 Windows x64 安装器与两份 manifest，已核对提交、版本、清洁工作树、大小与 SHA256，未重新打包。`,
    "",
    "## 限制",
    "",
    "- Windows x64 安装器未签名，可能显示未知发布者提示。",
    `- GitHub 发布不会发布 npm。维护者确认 \`@xiu-ai/cli@${version}\` 尚未发布后，可发布附件中的同源 tarball；禁止覆盖已发布版本。`,
    "",
    "> 这是自动生成的草稿。发布前请补全要点与验收说明。",
    "",
  ].join("\n");
}

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: options.encoding ?? "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options });
}

function ghJson(endpoint) {
  return JSON.parse(gh(["api", "-H", "Accept: application/vnd.github+json", endpoint]));
}

function ghPages(endpoint, key) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const result = ghJson(`${endpoint}${separator}per_page=100&page=${page}`);
    const batch = key ? result[key] : result;
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`Too many pages for ${endpoint}`);
}

async function downloadBundle(repo, runId, artifactName) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiu-release-"));
  gh(["run", "download", String(runId), "--repo", repo, "--name", artifactName, "--dir", directory]);
  const bundle = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Unexpected entry ${entry.name} in ${artifactName}`);
    bundle.set(entry.name, await readFile(path.join(directory, entry.name)));
  }
  return { bundle, directory };
}

export async function createDraft(env = process.env, root = process.cwd()) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw new Error("GITHUB_REPOSITORY is required");
  const commit = assertCommit(env.XIU_RELEASE_COMMIT?.trim());

  execFileSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: root, windowsHide: true });
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "origin/main"], { cwd: root, windowsHide: true });
  } catch {
    throw new Error(`${commit} is not on main`);
  }
  const showJson = (file) => JSON.parse(execFileSync("git", ["show", `${commit}:${file}`], { cwd: root, encoding: "utf8", windowsHide: true }));
  const version = assertVersion(showJson("package.json").version);
  if (showJson("apps/desktop/package.json").version !== version) throw new Error("CLI and desktop versions differ at this commit");
  const tag = `v${version}`;

  const releases = ghPages(`repos/${repo}/releases`);
  if (releases.some((release) => release.tag_name === tag)) throw new Error(`A release or draft for ${tag} already exists; never overwrite one`);
  if (ghJson(`repos/${repo}/git/matching-refs/tags/${tag}`).some((ref) => ref.ref === `refs/tags/${tag}`)) {
    throw new Error(`Tag ${tag} already exists; never move a published tag`);
  }

  const run = selectCiRun(ghPages(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${commit}&event=push&branch=main`, "workflow_runs"), commit);
  const jobCount = verifyJobs(ghPages(`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs"));
  const artifacts = ghPages(`repos/${repo}/actions/runs/${run.id}/artifacts`, "artifacts");
  const expected = { version, commit, runId: run.id };
  const temporary = [];
  try {
    const verified = {};
    for (const kind of ["cli", "desktop"]) {
      const { bundle, directory } = await downloadBundle(repo, run.id, selectArtifact(artifacts, kind, version, commit).name);
      temporary.push(directory);
      verified[kind] = verifyBundle(kind, bundle, expected);
    }
    const assets = releaseAssets(version, verified.cli, verified.desktop);
    const staging = await mkdtemp(path.join(os.tmpdir(), "xiu-release-assets-"));
    temporary.push(staging);
    for (const asset of assets) await writeFile(path.join(staging, asset.name), asset.bytes);
    const notesPath = path.join(staging, "notes.md");
    await writeFile(notesPath, releaseNotes(await readFile(path.join(root, "CHANGELOG.md"), "utf8"), version, commit, run, jobCount));

    gh([
      "release", "create", tag, "--repo", repo, "--draft", "--target", commit, "--title", `Xiu ${version}`, "--notes-file", notesPath,
      ...(version.includes("-") ? ["--prerelease"] : []),
      ...assets.map((asset) => path.join(staging, asset.name)),
    ]);

    // Read the uploads back; a mismatch leaves the draft unpublished for inspection.
    const draft = ghPages(`repos/${repo}/releases`).find((release) => release.tag_name === tag && release.draft);
    if (!draft) throw new Error(`Draft for ${tag} was not found after upload`);
    const uploaded = new Map(draft.assets.map((asset) => [asset.name, asset]));
    for (const asset of assets) {
      const remote = uploaded.get(asset.name);
      if (!remote || remote.size !== asset.bytes.length || (remote.digest && remote.digest !== `sha256:${sha256(asset.bytes)}`)) {
        throw new Error(`Uploaded ${asset.name} does not match the CI candidate; the draft was left unpublished`);
      }
    }
    const summary = [`Draft ${tag} created from ${commit} (CI run ${run.id}, ${jobCount} jobs passed): ${draft.html_url}`, ...assets.map((asset) => `- ${asset.name} ${asset.bytes.length} bytes sha256:${sha256(asset.bytes)}`), "Not published, no tag created, npm untouched.", ""].join("\n");
    if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
    console.log(summary);
    return draft;
  } finally {
    for (const directory of temporary) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await createDraft();
}
