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
    version: 2,
    generatedAt: new Date().toISOString(),
    files: [{ path: "../../outside-secret.txt", size: 1, modifiedMs: 1, terms: ["outside-secret"] }],
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
