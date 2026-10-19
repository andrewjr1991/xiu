import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSkillTools, SkillRegistry } from "../src/skills.js";

const skillMarkdown = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nFollow these instructions carefully.\n`;

test("skill registry discovers project, compatible, and global skills with project precedence", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skills-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  // A custom globalRoot does not disable the compatible ~/.agents/skills root.
  // Keep host-installed user skills out of this deterministic fixture.
  t.mock.method(os, "homedir", () => path.join(cwd, "fixture-home"));
  const globalRoot = path.join(cwd, "global-skills");
  await fs.mkdir(path.join(cwd, ".xiu", "skills", "review"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".claude", "skills", "deploy"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".agents", "skills", "grill-me"), { recursive: true });
  await fs.mkdir(path.join(globalRoot, "review"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".xiu", "skills", "review", "SKILL.md"), skillMarkdown("review", "Project review workflow"));
  await fs.writeFile(path.join(cwd, ".claude", "skills", "deploy", "SKILL.md"), skillMarkdown("deploy", "Compatible deploy workflow"));
  await fs.writeFile(path.join(cwd, ".agents", "skills", "grill-me", "SKILL.md"), skillMarkdown("grill-me", "Strict design review workflow"));
  await fs.writeFile(path.join(globalRoot, "review", "SKILL.md"), skillMarkdown("review", "Global review workflow"));
  const registry = new SkillRegistry(cwd, globalRoot);
  await registry.refresh(true);
  assert.deepEqual(registry.list().map((skill) => skill.name).sort(), ["deploy", "grill-me", "review"]);
  assert.equal(registry.list().find((skill) => skill.name === "review")?.scope, "project");
  assert.match(registry.catalog(), /deploy \[compatible\]/);
  assert.match(registry.catalog(), /grill-me \[compatible\]/);
  assert.match(await registry.read("review"), /Project review workflow/);

  const tool = createSkillTools(registry)[0]!;
  assert.match(await tool.execute({ name: "deploy" }, { cwd, approve: async () => true }), /Compatible deploy workflow/);
});

test("local skill installation uses a recoverable backup when replacing", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skill-install-"));
  const globalRoot = path.join(cwd, "installed");
  const source = path.join(cwd, "source-skill");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), skillMarkdown("quality-check", "First version"));
  const registry = new SkillRegistry(cwd, globalRoot);
  const first = await registry.install(source);
  assert.equal(first[0]?.name, "quality-check");
  await assert.rejects(registry.install(source), /already exists/);

  await fs.writeFile(path.join(source, "SKILL.md"), skillMarkdown("quality-check", "Second version"));
  const second = await registry.install(source, true);
  assert.ok(second[0]?.backup);
  assert.match(await fs.readFile(path.join(globalRoot, "quality-check", "SKILL.md"), "utf8"), /Second version/);
  assert.match(await fs.readFile(path.join(second[0]!.backup!, "SKILL.md"), "utf8"), /First version/);
});

test("model catalog omits redundant global workflow skills but explicit reads still work", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skills-workflow-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => path.join(cwd, "fixture-home"));
  const globalRoot = path.join(cwd, "global-skills");
  await fs.mkdir(path.join(globalRoot, "using-superpowers"), { recursive: true });
  await fs.mkdir(path.join(globalRoot, "domain-review"), { recursive: true });
  await fs.writeFile(path.join(globalRoot, "using-superpowers", "SKILL.md"), skillMarkdown("using-superpowers", "Generic startup workflow"));
  await fs.writeFile(path.join(globalRoot, "domain-review", "SKILL.md"), skillMarkdown("domain-review", "Review domain data"));
  const registry = new SkillRegistry(cwd, globalRoot);
  await registry.refresh(false);
  assert.doesNotMatch(registry.catalog(), /using-superpowers/);
  assert.match(registry.catalog(), /domain-review/);
  assert.match(await registry.read("using-superpowers"), /Generic startup workflow/);
});

test("skill permission expansion requires acknowledgement and preserves the old install when declined", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skill-permissions-"));
  const globalRoot = path.join(cwd, "installed");
  const source = path.join(cwd, "source-skill");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), skillMarkdown("network-review", "Review")
    .replace("description: Review", "description: Review\npermissions: workspace:read"));
  const registry = new SkillRegistry(cwd, globalRoot);
  const prompts: string[][] = [];
  await registry.install(source, false, async ({ added }) => { prompts.push(added); return true; });
  assert.deepEqual(prompts, [["workspace:read"]]);

  await fs.writeFile(path.join(source, "SKILL.md"), skillMarkdown("network-review", "Review v2")
    .replace("description: Review v2", "description: Review v2\npermissions: workspace:read, network:access"));
  await assert.rejects(registry.install(source, true, async ({ added }) => {
    assert.deepEqual(added, ["network:access"]);
    return false;
  }), /permission acknowledgement was declined/);
  assert.match(await fs.readFile(path.join(globalRoot, "network-review", "SKILL.md"), "utf8"), /description: Review\n/);
  assert.doesNotMatch(await fs.readFile(path.join(globalRoot, "network-review", "SKILL.md"), "utf8"), /network:access/);

  await registry.install(source, true, async () => true);
  assert.match(await fs.readFile(path.join(globalRoot, "network-review", "SKILL.md"), "utf8"), /network:access/);
  await fs.rm(cwd, { recursive: true, force: true });
});

test("skill installation rejects unknown permission names", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skill-unknown-permission-"));
  const source = path.join(cwd, "source-skill");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), skillMarkdown("unsafe", "Unsafe")
    .replace("description: Unsafe", "description: Unsafe\npermissions: system:override"));
  const registry = new SkillRegistry(cwd, path.join(cwd, "installed"));
  await assert.rejects(registry.install(source, false, async () => true), /unknown permissions.*system:override/i);
  await fs.rm(cwd, { recursive: true, force: true });
});

test("skills the registry finds but does not list are named with a reason, and /skills gets one line about them", async (t) => {
  const { skillIssuesNote } = await import("../src/skills.js");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skill-issues-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => path.join(cwd, "fixture-home"));
  const globalRoot = path.join(cwd, "global-skills");
  await fs.mkdir(path.join(cwd, ".xiu", "skills", "review"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".xiu", "skills", "locked"), { recursive: true });
  await fs.mkdir(path.join(globalRoot, "review"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".xiu", "skills", "review", "SKILL.md"), skillMarkdown("review", "Project review workflow"));
  const locked = path.join(cwd, ".xiu", "skills", "locked", "SKILL.md");
  await fs.writeFile(locked, skillMarkdown("locked", "Cannot be read"));
  await fs.writeFile(path.join(globalRoot, "review", "SKILL.md"), skillMarkdown("review", "Global review workflow"));
  const oversized = path.join(cwd, "plugin-big-SKILL.md");
  await fs.writeFile(oversized, `${skillMarkdown("big", "Too large")}${"x".repeat(120_001)}`);
  // A permission error is simulated for one file so the test does not depend on chmod (which Windows ignores).
  // The glob hands the registry forward-slash paths on Windows, so compare resolved paths, not strings.
  const realReadFile = fs.readFile.bind(fs);
  t.mock.method(fs, "readFile", ((file: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
    if (typeof file === "string" && path.resolve(file) === path.resolve(locked)) return Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${locked}'`), { code: "EACCES" }));
    return (realReadFile as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFile);

  const registry = new SkillRegistry(cwd, globalRoot);
  registry.setPluginFiles([{ file: oversized, name: "big" }, { file: path.join(cwd, "missing-SKILL.md"), name: "gone" }]);
  await registry.refresh(true);
  assert.deepEqual(registry.list().map((skill) => skill.name), ["review"]);
  assert.deepEqual(registry.issues(), [
    { name: "locked", scope: "project", reason: "unreadable", detail: "EACCES" },
    { name: "big", scope: "plugin", reason: "oversized" },
    { name: "gone", scope: "plugin", reason: "unreadable", detail: "ENOENT" },
    { name: "review", scope: "global", reason: "shadowed", detail: "project" },
  ]);
  assert.doesNotMatch(JSON.stringify(registry.issues()), new RegExp(cwd.replace(/[\\/]/g, "[\\\\/]")), "no path in an issue");

  const en = skillIssuesNote(registry.issues(), "en-US")!;
  assert.equal(en, "4 more skills are not listed: locked (project, unreadable: EACCES), big (plugin, over the size limit, not loaded), gone (plugin, unreadable: ENOENT), review (global, shadowed by the project skill of the same name).");
  const zh = skillIssuesNote(registry.issues(), "zh-CN")!;
  assert.match(zh, /^另有 4 个技能未列出：locked（project，无法读取：EACCES）、big（plugin，超过大小限制，未加载）、gone（plugin，无法读取：ENOENT）、review（global，被 project 范围的同名技能覆盖）。$/);
  assert.equal(skillIssuesNote([], "en-US"), undefined);
  assert.equal(skillIssuesNote([{ name: "x", scope: "global", reason: "unreadable", detail: "EIO" }], "en-US"), "1 more skill is not listed: x (global, unreadable: EIO).");

  // A root over the file limit says how many files were not read instead of dropping them silently.
  for (let index = 0; index < 301; index++) {
    const folder = path.join(globalRoot, `many-${String(index).padStart(3, "0")}`);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "SKILL.md"), skillMarkdown(`many-${index}`, "One of many"));
  }
  await registry.refresh(false);
  assert.equal(registry.list().length, 300);
  assert.deepEqual(registry.issues().filter((issue) => issue.reason === "truncated"), [{ name: "~/.xiu/skills", scope: "global", reason: "truncated", detail: "2" }]);
  assert.match(skillIssuesNote(registry.issues(), "zh-CN")!, /~\/\.xiu\/skills（global，超过 300 个 SKILL\.md，后 2 个未读取）/);
});
