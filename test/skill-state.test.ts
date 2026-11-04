import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SkillStateStore } from "../src/skill-state.js";
import { SkillRegistry } from "../src/skills.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skill-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => path.join(root, "home"));
  const user = path.join(root, "user");
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  return { root, user, cwd, store: new SkillStateStore(user, cwd) };
}

test("skill preferences are workspace-isolated, persist privately and update unrelated names independently", async (t) => {
  const f = await fixture(t);
  assert.deepEqual([...(await f.store.disabled())], []);
  await assert.rejects(fs.stat(f.user), { code: "ENOENT" });
  await Promise.all([f.store.setDisabled("Review", true), f.store.setDisabled("deploy", true)]);
  assert.deepEqual([...(await new SkillStateStore(f.user, f.cwd).disabled())].sort(), ["deploy", "review"]);
  assert.deepEqual([...(await new SkillStateStore(f.user, path.join(f.root, "other")).disabled())], []);
  await f.store.setDisabled("review", false);
  assert.deepEqual([...(await f.store.disabled())], ["deploy"]);
  const [file] = await fs.readdir(f.store.directory);
  const stored = await fs.readFile(path.join(f.store.directory, file!), "utf8");
  assert.equal(stored.includes(f.cwd), false);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(f.store.directory, file!))).mode & 0o077, 0);
});

test("corrupt or future skill preferences fail closed and are not overwritten by a toggle", async (t) => {
  const f = await fixture(t);
  await f.store.setDisabled("review", true);
  const [name] = await fs.readdir(f.store.directory);
  const file = path.join(f.store.directory, name!);
  for (const value of ['null', '{}', '{"version":2,"name":"review","disabled":true}', '{"version":1,"name":"review","disabled":false}', 'x'.repeat(5000)]) {
    await fs.writeFile(file, value);
    await assert.rejects(f.store.disabled());
    await assert.rejects(f.store.setDisabled("review", false));
    assert.equal(await fs.readFile(file, "utf8"), value);
  }
});

test("skill preference links and non-private files are rejected", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await f.store.setDisabled("review", true);
  const [name] = await fs.readdir(f.store.directory);
  const file = path.join(f.store.directory, name!);
  await fs.chmod(file, 0o644);
  await assert.rejects(f.store.disabled(), /private regular/);
  await fs.chmod(file, 0o600);
  const external = path.join(f.root, "external.json");
  await fs.rename(file, external);
  await fs.symlink(external, file);
  await assert.rejects(f.store.disabled(), /private regular/);
});

test("disabling a skill hides it from tools/catalog without promoting a shadowed lower-priority skill", async (t) => {
  const f = await fixture(t);
  const global = path.join(f.user, "skills");
  const project = path.join(f.cwd, ".xiu", "skills", "review");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(path.join(global, "review"), { recursive: true });
  const source = path.join(project, "SKILL.md");
  await fs.writeFile(source, "---\nname: review\ndescription: Project review\n---\nproject instructions");
  await fs.writeFile(path.join(global, "review", "SKILL.md"), "---\nname: review\n---\nglobal fallback instructions");
  const registry = new SkillRegistry(f.cwd, global);
  await registry.refresh();
  const skill = registry.all()[0]!;
  await registry.setEnabled("review", false, skill.fingerprint!);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.all()[0]!.enabled, false);
  assert.doesNotMatch(registry.catalog(), /Project review|global fallback/);
  await assert.rejects(registry.read("review"), /disabled in this workspace/);
  const restarted = new SkillRegistry(f.cwd, global);
  await restarted.refresh();
  assert.deepEqual(restarted.list(), []);
  await fs.rm(project, { recursive: true });
  await restarted.refresh();
  assert.equal(restarted.all()[0]!.scope, "global");
  assert.deepEqual(restarted.list(), [], "even a source disappearing cannot activate a same-name fallback");
  await assert.rejects(restarted.setEnabled("review", true, skill.fingerprint!), /Skill changed/);
  await restarted.setEnabled("review", true, restarted.all()[0]!.fingerprint!);
  assert.match(await restarted.read("review"), /global fallback instructions/);
  assert.deepEqual((await fs.readdir(f.user)).filter((name) => name === "extension-permissions.json"), [], "toggles do not create permission grants");
});

test("stale content fingerprints and damaged state cannot enable an advertised skill", async (t) => {
  const f = await fixture(t);
  const global = path.join(f.user, "skills");
  await fs.mkdir(path.join(global, "review"), { recursive: true });
  const file = path.join(global, "review", "SKILL.md");
  await fs.writeFile(file, "---\nname: review\n---\ninitial");
  const registry = new SkillRegistry(f.cwd, global);
  await registry.refresh();
  const fingerprint = registry.all()[0]!.fingerprint!;
  await registry.setEnabled("review", false, fingerprint);
  await fs.writeFile(file, "---\nname: review\npermissions: workspace:write\n---\nchanged");
  await assert.rejects(registry.setEnabled("review", true, fingerprint), /Skill changed/);
  assert.deepEqual(registry.list(), []);
  const [entry] = await fs.readdir(f.store.directory);
  await fs.writeFile(path.join(f.store.directory, entry!), "null");
  await assert.rejects(registry.refresh(), /Invalid skill preference/);
  assert.deepEqual(registry.list(), []);
  await assert.rejects(registry.read("review"));
});


test("a preference replaced by a FIFO fails closed without blocking", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await f.store.setDisabled("review", true);
  const [name] = await fs.readdir(f.store.directory);
  const file = path.join(f.store.directory, name!);
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs/promises";
    import { execFileSync } from "node:child_process";
    import { SkillStateStore } from ${JSON.stringify(new URL("../src/skill-state.ts", import.meta.url).href)};
    const file = ${JSON.stringify(file)};
    const open = fs.open.bind(fs);
    let replaced = false;
    fs.open = async (...args) => {
      if (args[0] === file && !replaced) {
        replaced = true;
        await fs.unlink(file);
        execFileSync("mkfifo", ["-m", "600", file]);
      }
      return open(...args);
    };
    const store = new SkillStateStore(${JSON.stringify(f.user)}, ${JSON.stringify(f.cwd)});
    await assert.rejects(store.disabled(), /private regular/);
    assert.equal(replaced, true);
    await assert.rejects(store.setDisabled("review", false), /private regular/);
    assert.equal((await store.inspect()).state, "unreadable");
    assert.equal((await fs.lstat(file)).isFIFO(), true);
    console.log("rejected-without-overwrite");
  `;
  assert.equal(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 }).trim(), "rejected-without-overwrite");
});
