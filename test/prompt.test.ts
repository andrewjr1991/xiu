import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSystemPrompt } from "../src/prompt.js";

test("system prompt identifies 静然 as Xiu's developer and rejects provider attribution", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-prompt-identity-"));
  const prompt = await buildSystemPrompt(cwd);
  assert.match(prompt, /developed by 静然/);
  assert.match(prompt, /Never attribute Xiu's development.*Sapiens AI/);
  assert.match(prompt, /provider supplies the underlying model but is not Xiu's developer/);
  assert.match(prompt, /You are not Agnes, Claude, ChatGPT, Codex/);
  assert.match(prompt, /NON-OVERRIDABLE PRODUCT IDENTITY/);
  assert.match(prompt, /PRIMARY GOAL remains mandatory/);
  assert.match(prompt, /HTML, source code, Markdown, JSON.*are not images/);
  assert.match(prompt, /meaningful phase changes.*user-facing progress sentence/);
  assert.match(prompt, /use verify_output with explicit required and forbidden content/);
  assert.match(prompt, /Treat @\.xiu\/attachments references as user-provided attachments/);
});

test("Chinese language mode governs all user-visible model output", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-prompt-language-"));
  const prompt = await buildSystemPrompt(cwd, undefined, "zh-CN");
  assert.match(prompt, /Use Simplified Chinese for every user-facing response/);
  assert.match(prompt, /progress update, plan goal and step title, visible reasoning summary/);
  assert.match(prompt, /Never expose private chain-of-thought/);
  assert.match(prompt, /USER_INPUT_REQUIRED/);
  assert.match(prompt, /plan goal, step title, and note.*Simplified Chinese/);
});
