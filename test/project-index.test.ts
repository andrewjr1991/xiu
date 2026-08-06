import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { ProjectIndex } from "../src/project-index.js";
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
