import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSkillTools, SkillRegistry } from "../src/skills.js";

const skillMarkdown = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nFollow these instructions carefully.\n`;

test("skill registry discovers project, compatible, and global skills with project precedence", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skills-"));
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
  assert.equal(registry.list().length, 3);
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
