import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { createProjectIndexTools, ProjectIndex } from "../src/project-index.js";
import type { ModelProvider } from "../src/types.js";

test("project index detects stack, checks, and relevant source files", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-"));
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
    scripts: { test: "node --test", build: "tsc" },
    dependencies: { react: "latest" },
    devDependencies: { typescript: "latest", vite: "latest" },
  }));
  await fs.writeFile(path.join(cwd, "src", "authentication.ts"), "export function validateSessionToken(token: string) { return token.length > 10; }");
  await fs.writeFile(path.join(cwd, "src", "unrelated.ts"), "export const color = 'blue';");
  await fs.writeFile(path.join(cwd, ".env"), "PRIVATE_TOKEN=do-not-index-this-secret");
  const index = new ProjectIndex(cwd);
  await index.initialize();
  assert.deepEqual(index.profile().stacks, ["Node.js", "TypeScript", "React", "Vite"]);
  assert.equal(index.profile().checks.test, "npm run test");
  const result = await index.search("session token authentication");
  assert.match(result, /src\/authentication\.ts/);
  assert.match(result, /validateSessionToken/);
  assert.equal(index.status().files, 3);
  assert.doesNotMatch(await index.search("do-not-index-this-secret"), /\.env/);
  await fs.access(path.join(cwd, ".xiu", "index.json"));

  let receivedContext = "";
  const provider: ModelProvider = {
    async complete(_system, messages) {
      receivedContext = messages.at(-1)?.content ?? "";
      return { text: "done", toolCalls: [], raw: {} };
    },
  };
  await new Agent({ provider: "openai", model: "test", cwd, maxTurns: 3, autoApprove: true }, provider, [], async () => true, {}, undefined, index)
    .run("fix authentication session token validation");
  assert.match(receivedContext, /Detected project: Node\.js, TypeScript, React, Vite/);
  assert.match(receivedContext, /src\/authentication\.ts/);
});

test("project index exposes bounded paths for @ completion", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-paths-"));
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "src", "agent.ts"), "export const agent = true;\n");
  await fs.writeFile(path.join(cwd, "src", "activity.ts"), "export const activity = true;\n");
  const index = new ProjectIndex(cwd);
  await index.initialize();
  assert.deepEqual(index.paths("agent"), ["src/agent.ts"]);
  assert.equal(index.paths("src", 1).length, 1);
});

test("project index reuses every unchanged file from a persistent cache", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-cache-"));
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  await fs.writeFile(path.join(cwd, "src", "alpha.ts"), "export const alphaCacheMarker = true;\n");
  await fs.writeFile(path.join(cwd, "src", "beta.ts"), "export const betaCacheMarker = true;\n");

  const first = new ProjectIndex(cwd);
  await first.initialize();
  assert.equal(first.status().mode, "full");
  assert.equal(first.status().indexed, 3);

  const second = new ProjectIndex(cwd);
  await second.initialize();
  assert.equal(second.status().mode, "cache");
  assert.equal(second.status().files, 3);
  assert.equal(second.status().reused, 3);
  assert.equal(second.status().indexed, 0);
  assert.equal(second.status().added, 0);
  assert.equal(second.status().updated, 0);
  assert.equal(second.status().removed, 0);
});

test("project index incrementally applies additions modifications and deletions", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-delta-"));
  const changed = path.join(cwd, "changed.ts");
  await fs.writeFile(changed, "export const oldIncrementalMarker = true;\n");
  await fs.writeFile(path.join(cwd, "removed.ts"), "export const removedIncrementalMarker = true;\n");
  const first = new ProjectIndex(cwd);
  await first.initialize();

  await fs.writeFile(changed, "export const newIncrementalMarker = true;\n");
  await fs.utimes(changed, new Date(), new Date(Date.now() + 2_000));
  await fs.rm(path.join(cwd, "removed.ts"));
  await fs.writeFile(path.join(cwd, "added.ts"), "export const addedIncrementalMarker = true;\n");

  const second = new ProjectIndex(cwd);
  await second.initialize();
  const status = second.status();
  assert.equal(status.mode, "incremental");
  assert.equal(status.files, 2);
  assert.equal(status.indexed, 2);
  assert.equal(status.added, 1);
  assert.equal(status.updated, 1);
  assert.equal(status.removed, 1);
  assert.match(await second.search("newIncrementalMarker"), /changed\.ts/);
  assert.match(await second.search("addedIncrementalMarker"), /added\.ts/);
  assert.doesNotMatch(await second.search("removedIncrementalMarker"), /removed\.ts/);
});

test("an invalidated in-memory index refreshes before the next search", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-invalidated-"));
  const target = path.join(cwd, "feature.ts");
  await fs.writeFile(target, "export const beforeRefresh = true;\n");
  const index = new ProjectIndex(cwd);
  await index.initialize();

  await fs.writeFile(target, "export const afterRefresh = true;\n");
  await fs.utimes(target, new Date(), new Date(Date.now() + 2_000));
  index.invalidate();
  assert.equal(index.status().dirty, true);
  assert.match(await index.search("afterRefresh"), /feature\.ts/);
  assert.equal(index.status().dirty, false);
  assert.equal(index.status().updated, 1);
  assert.equal(index.status().indexed, 1);
});

test("project index rebuilds corrupted and unsafe caches", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-recovery-"));
  await fs.writeFile(path.join(cwd, "safe.ts"), "export const safeRecoveryMarker = true;\n");
  const first = new ProjectIndex(cwd);
  await first.initialize();
  const cachePath = path.join(cwd, ".xiu", "index.json");

  await fs.writeFile(cachePath, "{broken", "utf8");
  const corrupted = new ProjectIndex(cwd);
  await corrupted.initialize();
  assert.equal(corrupted.status().mode, "full");
  assert.match(await corrupted.search("safeRecoveryMarker"), /safe\.ts/);

  await fs.writeFile(cachePath, JSON.stringify({
    version: 3,
    generatedAt: new Date().toISOString(),
    files: [{ path: "../../outside-secret.txt", size: 1, modifiedMs: 1, terms: ["outside-secret"], language: "Other", analyzed: false, symbols: [], imports: [], references: [] }],
    profile: { stacks: [], checks: {}, markers: [] },
    truncated: false,
  }), "utf8");
  const unsafe = new ProjectIndex(cwd);
  await unsafe.initialize();
  assert.equal(unsafe.status().mode, "full");
  assert.deepEqual(unsafe.paths(), ["safe.ts"]);
  assert.doesNotMatch(await unsafe.search("outside-secret"), /outside-secret\.txt/);
});

test("project profile tool lazily initializes an index", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-tool-"));
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { build: "tsc" }, devDependencies: { typescript: "latest" } }));
  const index = new ProjectIndex(cwd);
  const tool = createProjectIndexTools(index).find((candidate) => candidate.name === "project_profile");
  assert.ok(tool);
  const profile = JSON.parse(await tool.execute({}, { cwd })) as { stacks: string[]; checks: Record<string, string> };
  assert.deepEqual(profile.stacks, ["Node.js", "TypeScript"]);
  assert.equal(profile.checks.build, "npm run build");
  assert.equal(index.status().mode, "full");
});

test("project index never follows directory links outside the workspace", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-link-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-outside-"));
  await fs.writeFile(path.join(outside, "external.ts"), "export const externalSecretMarker = true;\n");
  try {
    await fs.symlink(outside, path.join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symbolic links unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  await fs.writeFile(path.join(cwd, "local.ts"), "export const localMarker = true;\n");
  const index = new ProjectIndex(cwd);
  await index.initialize();
  assert.deepEqual(index.paths(), ["local.ts"]);
  assert.doesNotMatch(await index.search("externalSecretMarker"), /external\.ts/);
});

test("a long-lived Agent refreshes externally added changed deleted and renamed files at each task boundary", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-long-lived-"));
  await fs.writeFile(path.join(cwd, "changed.ts"), "export const oldExternalMarker = true;\n");
  await fs.writeFile(path.join(cwd, "deleted.ts"), "export const deletedExternalMarker = true;\n");
  await fs.writeFile(path.join(cwd, "before-rename.ts"), "export const renamedExternalMarker = true;\n");
  await fs.writeFile(path.join(cwd, "unchanged.ts"), "export const unchangedExternalMarker = true;\n");
  const index = new ProjectIndex(cwd);
  let context = "";
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, autoApprove: false },
    { async complete(_system, messages) {
      context = messages.at(-1)?.content ?? "";
      return { text: "Inspected.", toolCalls: [], raw: {} };
    } }, [], async () => false, {}, undefined, index,
  );
  await agent.run("Find oldExternalMarker");
  assert.match(context, /oldExternalMarker/);
  await fs.writeFile(path.join(cwd, "changed.ts"), "export const updatedExternalMarker = true;\n");
  await fs.writeFile(path.join(cwd, "added.ts"), "export const addedExternalMarker = true;\n");
  await fs.rm(path.join(cwd, "deleted.ts"));
  await fs.rename(path.join(cwd, "before-rename.ts"), path.join(cwd, "after-rename.ts"));
  await agent.run("Find updatedExternalMarker addedExternalMarker renamedExternalMarker");
  assert.deepEqual(index.paths().sort(), ["added.ts", "after-rename.ts", "changed.ts", "unchanged.ts"]);
  assert.equal(index.status().added, 2);
  assert.equal(index.status().updated, 1);
  assert.equal(index.status().removed, 2);
  assert.equal(index.status().reused, 1);
  assert.match(context, /added\.ts/);
  assert.match(await index.findSymbols({ query: "updatedExternalMarker" }), /changed\.ts/);
  assert.doesNotMatch(await index.findSymbols({ query: "oldExternalMarker" }), /changed\.ts/);
});

test("index accesses recheck external files after a bounded interval without scanning on every access", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-freshness-"));
  await fs.writeFile(path.join(cwd, "first.ts"), "export const firstExternal = true;\n");
  let now = 1_000;
  const index = new ProjectIndex(cwd, () => now);
  const discover = t.mock.method(index as unknown as { discover(): Promise<unknown> }, "discover");
  await index.initialize();
  await fs.writeFile(path.join(cwd, "added.ts"), "export const nextExternal = true;\n");
  await index.initialize();
  await index.search("firstExternal");
  await index.repositoryMap({});
  await index.findSymbols({ query: "firstExternal" });
  assert.equal(discover.mock.callCount(), 1);
  now += 5_000;
  await Promise.all([index.initialize(), index.search("nextExternal"), index.repositoryMap({})]);
  assert.equal(discover.mock.callCount(), 2);
  assert.deepEqual(index.paths().sort(), ["added.ts", "first.ts"]);
  assert.equal(index.status().indexed, 1);
  assert.equal(index.status().reused, 1);
});

test("index freshness notices equal-size external edits with preserved mtime and refreshes project checks", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-preserved-time-"));
  const source = path.join(cwd, "feature.ts");
  await fs.writeFile(source, "export const beforeMarker = true;\n");
  // Use an exactly representable timestamp to avoid filesystem rounding being
  // mistaken for the modification that this regression is meant to detect.
  const mtime = new Date("2020-01-01T00:00:00.000Z");
  await fs.utimes(source, mtime, mtime);
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  let now = 0;
  const index = new ProjectIndex(cwd, () => now);
  await index.initialize();
  await fs.writeFile(source, "export const after_Marker = true;\n");
  await fs.utimes(source, mtime, mtime);
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
  now += 5_000;
  const result = await index.findSymbols({ query: "after_Marker" });
  assert.match(result, /feature\.ts/);
  assert.doesNotMatch(await index.findSymbols({ query: "beforeMarker" }), /feature\.ts/);
  assert.deepEqual(index.profile().checks, { build: "npm run build" });
  assert.equal(index.status().updated, 2);
});

test("an invalidation during refresh survives and concurrent readers coalesce the follow-up scan", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-race-"));
  await fs.writeFile(path.join(cwd, "first.ts"), "export const first = true;\n");
  const index = new ProjectIndex(cwd);
  const internal = index as unknown as { discover(): Promise<unknown> };
  const originalDiscover = internal.discover.bind(index);
  let discovered!: () => void;
  const scanReady = new Promise<void>((resolve) => { discovered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let scans = 0;
  t.mock.method(internal, "discover", async () => {
    const result = await originalDiscover();
    if (++scans === 1) { discovered(); await gate; }
    return result;
  });
  const initial = index.initialize();
  await scanReady;
  await fs.writeFile(path.join(cwd, "added-during-scan.ts"), "export const during = true;\n");
  index.invalidate();
  const readers = Promise.all([index.initialize(), index.initialize(), index.search("during")]);
  release();
  await Promise.all([initial, readers]);
  assert.equal(scans, 2);
  assert.equal(index.status().dirty, false);
  assert.deepEqual(index.paths().sort(), ["added-during-scan.ts", "first.ts"]);
});

test("force and explicit invalidation bypass freshness while a clock rollback cannot freeze the index", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-refresh-bypass-"));
  await fs.writeFile(path.join(cwd, "feature.ts"), "export const feature = true;\n");
  let now = 10_000;
  const index = new ProjectIndex(cwd, () => now);
  const discover = t.mock.method(index as unknown as { discover(): Promise<unknown> }, "discover");
  await index.initialize();
  await index.initialize(true);
  assert.equal(index.status().mode, "full");
  index.invalidate();
  await index.initialize();
  assert.equal(index.status().mode, "cache");
  now = 0;
  await index.initialize();
  assert.equal(discover.mock.callCount(), 4);
  assert.equal(index.status().indexed, 0);
});

test("old index cache metadata is safely upgraded before reuse", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-cache-upgrade-"));
  await fs.writeFile(path.join(cwd, "feature.ts"), "export const feature = true;\n");
  await new ProjectIndex(cwd).initialize();
  const cacheFile = path.join(cwd, ".xiu", "index.json");
  const cache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  for (const file of cache.files) delete file.changedMs;
  await fs.writeFile(cacheFile, JSON.stringify(cache));
  const upgraded = new ProjectIndex(cwd);
  await upgraded.initialize();
  assert.equal(upgraded.status().indexed, 1);
  const reused = new ProjectIndex(cwd);
  await reused.initialize();
  assert.equal(reused.status().indexed, 0);
  assert.equal(reused.status().reused, 1);
});

test("find_relevant_code refreshes externally added and changed search terms after the freshness window", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-index-search-freshness-"));
  await fs.writeFile(path.join(cwd, "existing.ts"), "export const oldSearchMarker = true;\n");
  let now = 0;
  const index = new ProjectIndex(cwd, () => now);
  const discover = t.mock.method(index as unknown as { discover(): Promise<unknown> }, "discover");
  const tool = createProjectIndexTools(index).find((candidate) => candidate.name === "find_relevant_code")!;
  assert.match(await tool.execute({ query: "oldSearchMarker" }, { cwd }), /existing\.ts/);
  await fs.writeFile(path.join(cwd, "existing.ts"), "export const changedSearchMarker = true;\n");
  await fs.writeFile(path.join(cwd, "added.ts"), "export const addedSearchMarker = true;\n");
  await tool.execute({ query: "addedSearchMarker" }, { cwd });
  assert.equal(discover.mock.callCount(), 1);
  now += 5_000;
  // Exercise the actual tool entry point with no initialize/profile/symbol call
  // to refresh the cache on its behalf.
  assert.match(await tool.execute({ query: "addedSearchMarker" }, { cwd }), /added\.ts/);
  assert.match(await tool.execute({ query: "changedSearchMarker" }, { cwd }), /existing\.ts/);
  assert.equal(await tool.execute({ query: "oldSearchMarker" }, { cwd }), "No relevant files found.");
  assert.equal(discover.mock.callCount(), 2);
});
