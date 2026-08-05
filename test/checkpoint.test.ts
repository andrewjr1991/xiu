import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointManager } from "../src/checkpoint.js";
import { Agent } from "../src/agent.js";
import { builtinTools } from "../src/tools.js";
import type { ModelProvider } from "../src/types.js";

test("checkpoint restores an edited file to its previous content", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-checkpoint-"));
  await fs.writeFile(path.join(cwd, "file.txt"), "before");
  const manager = new CheckpointManager(cwd, "session-1");
  const checkpoint = await manager.capture("write_file", { path: "file.txt" }, "write file.txt");
  await fs.writeFile(path.join(cwd, "file.txt"), "after");
  await manager.restore(checkpoint!.id);
  assert.equal(await fs.readFile(path.join(cwd, "file.txt"), "utf8"), "before");
  assert.match(await manager.diff(), /file\.txt/);
});

test("checkpoint removes a file that did not exist before generation", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-checkpoint-new-"));
  const manager = new CheckpointManager(cwd, "session-2");
  const checkpoint = await manager.capture("generate_image", { output_path: "asset.png" }, "generate asset.png");
  await fs.writeFile(path.join(cwd, "asset.png"), "generated");
  await manager.restore(checkpoint!.id);
  await assert.rejects(fs.access(path.join(cwd, "asset.png")));
});

test("Agent creates a checkpoint automatically before an approved write", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-checkpoint-agent-"));
  await fs.writeFile(path.join(cwd, "tracked.txt"), "original");
  const manager = new CheckpointManager(cwd);
  let calls = 0;
  const provider: ModelProvider = {
    async complete() {
      calls++;
      if (calls === 1) return { text: "edit", toolCalls: [{ id: "write", name: "write_file", input: { path: "tracked.txt", content: "changed" } }], raw: {} };
      if (calls === 2) return { text: "verify", toolCalls: [{ id: "diff", name: "git_diff", input: {} }], raw: {} };
      return { text: "done", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent(
    { provider: "openai", model: "test", cwd, maxTurns: 5, autoApprove: true },
    provider, builtinTools, async () => true, {}, undefined, undefined, undefined, manager,
  );
  await agent.run("change tracked.txt");
  const checkpoints = await manager.list();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.files[0]?.path, "tracked.txt");
});
