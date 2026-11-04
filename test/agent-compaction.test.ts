import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import type { ModelProvider } from "../src/types.js";
import { estimateTextTokens, loadSession } from "../src/session.js";
import { retainUserRequirements } from "../src/user-requirements.js";

test("repeated compaction retains recent user constraints even when model summaries omit them", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-compaction-contract-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const requests: string[][] = [];
  let started!: () => void;
  let unblock!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let firstCall = true;
  const provider: ModelProvider = {
    async complete(system, messages) {
      if (system.includes("CONTEXT CHECKPOINT COMPACTION")) return { text: "Current progress: done. Next action: continue.", toolCalls: [], raw: {} };
      if (firstCall) { firstCall = false; started(); await blocked; }
      requests.push(messages.map((message) => message.content));
      return { text: "Done.", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent({ config: { provider: "openai", providerId: "offline", model: "offline", cwd, contextLimit: 100_000, autoApprove: false }, provider, tools: [], approve: async () => false });
  const constraint = "PRESERVE_SCHEMA_CANARY: keep schema v1 in src/legacy.ts; do not use the network.";
  const steering = "STEERING_EXACT_CANARY: keep Chinese comments.";
  const initial = agent.run(constraint);
  await ready;
  try { assert.equal(agent.steer(steering), true); }
  finally { unblock(); }
  await initial;
  await agent.run("Document the existing module using the earlier constraints.");
  await agent.compact();
  await agent.run("Continue the same offline documentation task.");
  assert(requests.at(-1)!.some((message) => message.includes(constraint)), "First checkpoint should preserve exact requirements outside model prose.");
  await agent.compact();
  await agent.run("Check the existing constraints before proceeding.");
  assert(requests.at(-1)!.some((message) => message.includes(constraint)), "A second checkpoint must retain the same recent user requirement even if the model omitted it.");
  assert(requests.at(-1)!.some((message) => message.includes(steering)), "Steering must survive task cleanup and repeated compaction as actual user text.");
  const restored = await loadSession(cwd, agent.status().sessionId);
  assert(restored.userRequirements?.some((message) => message.includes(constraint)), "Restore reconstructs bounded requirements from original user events.");
  const resumed = new Agent({ config: { provider: "openai", providerId: "offline", model: "offline", cwd, contextLimit: 100_000, autoApprove: false }, provider, tools: [], approve: async () => false, restored });
  await resumed.run("Resume documentation under the same constraints.");
  await resumed.compact();
  await resumed.run("Inspect the restored checkpoint.");
  assert(requests.at(-1)!.some((message) => message.includes(constraint)), "Compacting after restore must not depend on model remembering the old constraint.");
  resumed.clearConversation();
  await resumed.run("A new independent task.");
  await resumed.compact();
  await resumed.run("Inspect the independent checkpoint.");
  assert(!requests.at(-1)!.some((message) => message.includes(constraint)), "Clearing conversation clears retained requirements as well.");
  resumed.restoreSession(restored);
  await resumed.run("Switch back to the original documentation session.");
  await resumed.compact();
  await resumed.run("Check the switched session requirements.");
  assert(requests.at(-1)!.some((message) => message.includes(constraint)), "Switching sessions uses that session's original user requirements.");
});

test("manual compaction refuses an active task without replacing its controller", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-compaction-active-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  let started!: () => void;
  let unblock!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const provider: ModelProvider = { async complete() { started(); await blocked; return { text: "Done.", toolCalls: [], raw: {} }; } };
  const agent = new Agent({ config: { provider: "openai", providerId: "offline", model: "offline", cwd, autoApprove: false }, provider, tools: [], approve: async () => false });
  const running = agent.run("Finish this task before compacting.");
  await ready;
  try {
    await assert.rejects(agent.compact(), /while a task|active task|mode change/i);
    await assert.rejects(agent.run("Overlapping task"), /another task|active task/i);
    assert.equal(agent.cancel(), true, "Rejected overlapping calls must preserve cancellation of the actual running task.");
  }
  finally { unblock(); await assert.rejects(running, /Task cancelled/); }
});

test("legacy session restore rebuilds constraints from user events without promoting model or tool text", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-compaction-legacy-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const events = [
    { type: "task", task: "Keep src/legacy.ts unchanged.", contextualTask: "Keep src/legacy.ts unchanged.\n\nAutomatically prepared project context:\nGENERATED_FILE_CONTEXT" },
    { type: "assistant", text: "MODEL_ONLY_REQUIREMENT" },
    { type: "tool", result: "TOOL_ONLY_REQUIREMENT", name: "read_file" },
    { type: "compact", context: "ACTIVE TASK CONTRACT\nMODEL_ONLY_CHECKPOINT" },
    { type: "task", task: "Document the schema." },
    { type: "steering", items: ["Use Chinese comments.", { instruction: "INVALID_STEERING_OBJECT" }] },
    { type: "completion_gate", message: "INTERNAL_COMPLETION_NOTICE" },
    { type: "compact", summary: "MODEL_ONLY_NEW_CHECKPOINT" },
  ];
  await fs.writeFile(path.join(directory, "legacy.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const restored = await loadSession(cwd, "legacy");
  assert.deepEqual(restored.userRequirements, ["Keep src/legacy.ts unchanged.", "Document the schema.", "Use Chinese comments."]);
  assert.equal(restored.messages[0]?.content, "MODEL_ONLY_NEW_CHECKPOINT", "Transcript compatibility remains intact; retained requirements have an independent user-event source.");
});

test("retained requirements stay bounded, deduplicate and preserve long UTF-8 head and tail", () => {
  const history = Array.from({ length: 20 }, (_, index) => `requirement-${index}`);
  const selected = retainUserRequirements([...history].reverse(), [], estimateTextTokens);
  assert.deepEqual(selected, history.slice(-6));
  assert.deepEqual(retainUserRequirements([history.at(-1)!], selected, estimateTextTokens), selected);
  const long = `HEAD_EXACT\n${"甲".repeat(40_000)}\nTAIL_EXACT`;
  const bounded = retainUserRequirements([long], [], estimateTextTokens);
  assert.equal(bounded.length, 1);
  assert.equal(bounded[0]!.length, 24_000);
  assert(bounded[0]!.startsWith("HEAD_EXACT"));
  assert(bounded[0]!.endsWith("TAIL_EXACT"));
  assert.match(bounded[0]!, /middle omitted/);
  assert.deepEqual(retainUserRequirements([], bounded, estimateTextTokens), bounded, "Repeated retention must not grow the clipped record.");
  assert.deepEqual(retainUserRequirements(["Newest bounded requirement"], bounded, estimateTextTokens), ["Newest bounded requirement"], "A huge old record cannot push the recent selection past its token budget.");
});

test("a checkpoint-only legacy log cannot turn model handoff text into an original user requirement", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-compaction-checkpoint-only-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "checkpoint.jsonl"), '{"type":"compact","summary":"MODEL_HANDOFF_ONLY_CANARY"}\n{"type":"assistant","text":"Previous activity"}\n');
  const restored = await loadSession(cwd, "checkpoint");
  let contract = "";
  const provider: ModelProvider = { async complete(_system, messages) {
    contract = messages[0]!.content.split("FULL TRANSCRIPT TO COMPACT:", 1)[0]!;
    return { text: "Current progress: handoff only. Next action: wait for user.", toolCalls: [], raw: {} };
  } };
  const agent = new Agent({ config: { provider: "openai", providerId: "offline", model: "offline", cwd, autoApprove: false }, provider, tools: [], approve: async () => false, restored });
  await agent.compact();
  assert.doesNotMatch(contract, /MODEL_HANDOFF_ONLY_CANARY/, "No original user event exists to justify promoting this summary into the task contract.");
});

test("steering received during automatic compaction survives its earlier checkpoint snapshot", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-compaction-steering-race-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  let compacting!: () => void;
  let unblock!: () => void;
  const ready = new Promise<void>((resolve) => { compacting = resolve; });
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let firstCompaction = true;
  let normalCalls = 0;
  const requests: string[][] = [];
  const provider: ModelProvider = {
    async complete(system, messages) {
      if (system.includes("CONTEXT CHECKPOINT COMPACTION")) {
        if (firstCompaction) { firstCompaction = false; compacting(); await blocked; }
        return { text: "Current progress: summarized. Next action: continue.", toolCalls: [], raw: {} };
      }
      requests.push(messages.map((message) => message.content));
      return { text: normalCalls++ === 0 ? "Seed evidence. ".repeat(1_300) : "Done.", toolCalls: [], raw: {} };
    },
  };
  const agent = new Agent({ config: { provider: "openai", providerId: "offline", model: "offline", cwd, contextLimit: 4_000, maxTurns: 5, autoApprove: false }, provider, tools: [], approve: async () => false });
  await agent.run("Seed the offline conversation.");
  const running = agent.run("Continue the documentation.");
  await ready;
  const steering = "LATE_STEERING_CANARY: retain Chinese comments.";
  try { assert.equal(agent.steer(steering), true); }
  finally { unblock(); }
  await running;
  await agent.run("Continue the next documentation stage.");
  await agent.compact();
  await agent.run("Inspect the latest constraints.");
  assert(requests.at(-1)!.some((message) => message.includes(steering)), "An older in-flight checkpoint cannot overwrite newer user steering.");
});
