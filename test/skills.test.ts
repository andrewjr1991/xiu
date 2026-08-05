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
  await fs.mkdir(path.join(globalRoot, "review"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".xiu", "skills", "review", "SKILL.md"), skillMarkdown("review", "Project review workflow"));
  await fs.writeFile(path.join(cwd, ".claude", "skills", "deploy", "SKILL.md"), skillMarkdown("deploy", "Compatible deploy workflow"));
  await fs.writeFile(path.join(globalRoot, "review", "SKILL.md"), skillMarkdown("review", "Global review workflow"));
  const registry = new SkillRegistry(cwd, globalRoot);
  await registry.refresh(true);
  assert.equal(registry.list().length, 2);
  assert.equal(registry.list().find((skill) => skill.name === "review")?.scope, "project");
  assert.match(registry.catalog(), /deploy \[compatible\]/);
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
