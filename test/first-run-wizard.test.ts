import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type FirstRunWizardIo, runFirstRunWizard } from "../src/first-run-wizard.js";
import type { SelectOption } from "../src/interactive-ui.js";
import { type ProviderProfile, ProviderRegistry } from "../src/provider-registry.js";

interface Script {
  /** Picks an option by matching its label with a regular expression; `undefined` simulates Esc. */
  selections: (RegExp | undefined)[];
  answers: string[];
  secrets: string[];
}

function scriptedIo(script: Script) {
  const log: string[] = [];
  const titles: string[] = [];
  const io: FirstRunWizardIo = {
    async select<T>(title: string, options: SelectOption<T>[]): Promise<T | undefined> {
      titles.push(title);
      assert.ok(script.selections.length, `unexpected selector: ${title}`);
      const matcher = script.selections.shift();
      if (!matcher) return undefined;
      const option = options.find((item) => matcher.test(item.label));
      assert.ok(option, `no option matching ${matcher} in ${options.map((item) => item.label).join(" | ")}`);
      return option.value;
    },
    async ask(prompt: string): Promise<string> {
      assert.ok(script.answers.length, `unexpected question: ${prompt}`);
      return script.answers.shift()!;
    },
    async askSecret(prompt: string): Promise<string> {
      assert.ok(script.secrets.length, `unexpected secret prompt: ${prompt}`);
      return script.secrets.shift()!;
    },
    log(line: string): void { log.push(line); },
  };
  return { io, log, titles };
}

async function registryFixture(t: test.TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-first-run-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const filename = path.join(home, "providers.json");
  const registry = new ProviderRegistry(filename);
  await registry.load();
  return { registry, filename, home };
}

test("vendor template: key is typed once, the profile is saved only after the probe passes, and the key never reaches the log", async (t) => {
  const { registry, filename } = await registryFixture(t);
  const script = scriptedIo({ selections: [/DeepSeek/], answers: [], secrets: ["sk-first-run-canary"] });
  const probed: ProviderProfile[] = [];
  const activated: string[] = [];
  const result = await runFirstRunWizard({
    language: "zh-CN", registry, env: {}, io: script.io,
    probe: async (profile) => {
      probed.push(profile);
      assert.equal(await fs.stat(filename).then(() => true, () => false), false, "nothing is written before the probe");
      return { models: [{ id: "deepseek-chat", source: "api" }, { id: "deepseek-reasoner", source: "api" }] };
    },
    activate: async (profile, model) => { activated.push(`${profile.id}/${model}`); return true; },
  });
  assert.deepEqual(result, { status: "configured", providerId: "deepseek", model: "deepseek-chat" });
  assert.equal(probed[0]?.apiKey, "sk-first-run-canary");
  assert.equal(probed[0]?.apiKeyEnv, undefined, "a typed key does not also pin an environment variable");
  assert.deepEqual(activated, ["deepseek/deepseek-chat"]);
  const saved = JSON.parse(await fs.readFile(filename, "utf8"));
  assert.equal(saved.active, "deepseek");
  assert.equal(saved.profiles.length, 1);
  assert.equal(saved.profiles[0].baseURL, "https://api.deepseek.com/v1");
  assert.equal(saved.profiles[0].apiKey, undefined, "the key lives in the credential store, not the profile list");
  assert.doesNotMatch(script.log.join("\n"), /sk-first-run-canary/);
  assert.match(script.log.join("\n"), /已保存并设为当前渠道/);
  assert.match(script.titles[0]!, /第 1\/3 步/);
});

test("a failed probe saves nothing and offers retry, reselect or later", async (t) => {
  const { registry, filename } = await registryFixture(t);
  let attempts = 0;
  const script = scriptedIo({
    selections: [/OpenAI$/, /重新输入/, /换一个渠道/, /稍后配置/],
    answers: [],
    secrets: ["sk-bad-one", "sk-bad-two"],
  });
  const result = await runFirstRunWizard({
    language: "zh-CN", registry, env: {}, io: script.io,
    probe: async (profile) => { attempts += 1; throw Object.assign(new Error(`401 Unauthorized: invalid api key ${profile.apiKey}`), { status: 401 }); },
    activate: async () => { throw new Error("must not activate"); },
  });
  assert.deepEqual(result, { status: "skipped" });
  assert.equal(attempts, 2, "retry re-runs the probe once; reselect then later ends the wizard");
  assert.equal(await fs.stat(filename).then(() => true, () => false), false);
  assert.deepEqual(registry.list(), []);
  const text = script.log.join("\n");
  assert.match(text, /服务拒绝了这个 API Key/);
  assert.doesNotMatch(text, /sk-bad-one|sk-bad-two/);
});

test("a detected environment variable is offered first and stores only the variable name", async (t) => {
  const { registry, filename } = await registryFixture(t);
  const script = scriptedIo({ selections: [/检测到 OPENAI_API_KEY/], answers: [], secrets: [] });
  const result = await runFirstRunWizard({
    language: "zh-CN", registry, env: { OPENAI_API_KEY: "env-canary-value" }, io: script.io,
    probe: async (profile) => {
      assert.equal(profile.apiKeyEnv, "OPENAI_API_KEY");
      assert.equal(profile.apiKey, undefined);
      return { models: [], discoveryError: "no /models" };
    },
    activate: async () => true,
  });
  assert.deepEqual(result, { status: "configured", providerId: "openai", model: "gpt-5" });
  const saved = JSON.parse(await fs.readFile(filename, "utf8"));
  assert.equal(saved.profiles[0].apiKeyEnv, "OPENAI_API_KEY");
  const text = `${script.log.join("\n")}\n${await fs.readFile(filename, "utf8")}`;
  assert.doesNotMatch(text, /env-canary-value/);
  assert.match(script.log.join("\n"), /没有模型列表接口/);
});

test("local server: the discovered models are offered and the chosen one becomes the active model", async (t) => {
  const { registry, filename } = await registryFixture(t);
  const script = scriptedIo({ selections: [/^Ollama/, /^qwen3:8b$/], answers: [""], secrets: [] });
  const result = await runFirstRunWizard({
    language: "en-US", registry, env: {}, io: script.io,
    probe: async (profile) => {
      assert.equal(profile.baseURL, "http://127.0.0.1:11434/v1");
      assert.equal(profile.model, "local-model");
      return { models: [{ id: "llama3.1:8b", source: "api" }, { id: "qwen3:8b", source: "api" }] };
    },
    activate: async () => true,
  });
  assert.deepEqual(result, { status: "configured", providerId: "ollama", model: "qwen3:8b" });
  const saved = JSON.parse(await fs.readFile(filename, "utf8"));
  assert.equal(saved.profiles[0].model, "qwen3:8b");
  assert.equal(saved.activeModels.ollama, "qwen3:8b");
  assert.match(script.titles[1]!, /Step 3\/3 · Choose a model \(2 returned/);
});

test("Esc on the first step and a blank key both leave without writing anything", async (t) => {
  const { registry, filename } = await registryFixture(t);
  const escaped = scriptedIo({ selections: [undefined], answers: [], secrets: [] });
  assert.deepEqual(await runFirstRunWizard({ language: "zh-CN", registry, env: {}, io: escaped.io, probe: async () => ({ models: [] }), activate: async () => true }), { status: "cancelled" });
  // A blank key returns to step 1, where the user then chooses "later".
  const blank = scriptedIo({ selections: [/智谱/, /稍后配置/], answers: [], secrets: [""] });
  assert.deepEqual(await runFirstRunWizard({ language: "zh-CN", registry, env: {}, io: blank.io, probe: async () => ({ models: [] }), activate: async () => true }), { status: "skipped" });
  assert.equal(await fs.stat(filename).then(() => true, () => false), false);
});

test("custom OpenAI-compatible service asks for URL and model, and an existing id gets a numeric suffix", async (t) => {
  const { registry } = await registryFixture(t);
  await registry.upsert({ id: "custom", name: "Existing", kind: "openai-compatible", model: "m", baseURL: "https://existing.example/v1", features: { text: true, tools: true, vision: false, image: false, video: false } });
  const script = scriptedIo({ selections: [/自定义 OpenAI 兼容服务/], answers: ["https://gateway.example/v1", "gpt-4.1"], secrets: [""] });
  const result = await runFirstRunWizard({
    language: "zh-CN", registry, env: {}, io: script.io,
    probe: async (profile) => { assert.equal(profile.apiKey, undefined); return { models: [{ id: "gpt-4.1", source: "api" }] }; },
    activate: async () => true,
  });
  assert.deepEqual(result, { status: "configured", providerId: "custom-2", model: "gpt-4.1" });
  assert.equal(registry.get("custom-2")?.baseURL, "https://gateway.example/v1");
});

test("activation failure after a passed probe removes the just-saved profile", async (t) => {
  const { registry } = await registryFixture(t);
  const script = scriptedIo({ selections: [/Kimi/, /稍后配置/], answers: [], secrets: ["sk-kimi"] });
  const result = await runFirstRunWizard({
    language: "zh-CN", registry, env: {}, io: script.io,
    probe: async () => ({ models: [] }),
    activate: async () => false,
  });
  assert.deepEqual(result, { status: "skipped" });
  assert.deepEqual(registry.list(), []);
  assert.match(script.log.join("\n"), /已撤销刚保存的配置/);
});
