import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipFixture, type ZipEntry } from "./helpers/skill-zip.js";
import { stageLocalSkillPackage } from "../src/skills.js";

const skill = (name: string) => `---\nname: ${name}\npermissions: instructions:load\n---\n# Inert fixture`;
async function fixture(t: { after(fn: () => Promise<unknown>): unknown }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-skill-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("single SKILL.md imports only the selected file and preserves fallback name", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "single-skill");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), "# Standalone instructions");
  await fs.writeFile(path.join(source, "unrelated-secret.txt"), "must not copy siblings");
  const destination = path.join(root, "staged");
  const items = await stageLocalSkillPackage(path.join(source, "SKILL.md"), destination);
  assert.equal(items[0]?.name, "single-skill");
  assert.deepEqual(await fs.readdir(path.join(destination, "single-skill")), ["SKILL.md"]);
  await fs.writeFile(path.join(source, "other.md"), skill("other"));
  await assert.rejects(stageLocalSkillPackage(path.join(source, "other.md"), path.join(root, "other-stage")), /SKILL.md or ZIP/);
});

test("ZIP imports wrapped multi-skill packages, resources and scripts as inert data", async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, "must-not-execute");
  const entries: ZipEntry[] = [
    { name: "bundle/one/SKILL.md", data: skill("one"), method: 8 },
    { name: "bundle/one/references/说明.md", data: "你好" },
    { name: "bundle/two/" },
    { name: "bundle/two/SKILL.md", data: skill("two") },
    { name: "bundle/two/install.cjs", data: `require('fs').writeFileSync(${JSON.stringify(marker)},'executed')` },
  ];
  const source = path.join(root, "bundle.zip");
  await fs.writeFile(source, zipFixture(entries));
  const destination = path.join(root, "staged");
  const items = await stageLocalSkillPackage(source, destination);
  assert.deepEqual(items.map((item) => item.name).sort(), ["one", "two"]);
  assert.equal(await fs.readFile(path.join(destination, "bundle/bundle/one/references/说明.md"), "utf8"), "你好");
  await assert.rejects(fs.stat(marker));
});

test("ZIP root skill without metadata uses archive name", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "standalone.zip");
  await fs.writeFile(source, zipFixture([{ name: "SKILL.md", data: "# Instructions" }]));
  assert.equal((await stageLocalSkillPackage(source, path.join(root, "staged")))[0]?.name, "standalone");
});

test("Chinese archive and source folder names allow valid manifest names", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "技能包.zip");
  await fs.writeFile(source, zipFixture([{ name: "SKILL.md", data: skill("named-skill") }]));
  assert.equal((await stageLocalSkillPackage(source, path.join(root, "zip-stage")))[0]?.name, "named-skill");
  const folder = path.join(root, "下载");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "SKILL.md"), skill("named-file"));
  assert.equal((await stageLocalSkillPackage(path.join(folder, "SKILL.md"), path.join(root, "file-stage")))[0]?.name, "named-file");
});

for (const name of ["../escaped", "/absolute", "C:/drive", "a\\escape", "a/../escape", "a/./alias", "a//alias", "a/stream:ads", "CON.txt", "a/trailing.", "a/trailing ", "a/\u0000bad"]) {
  test(`ZIP rejects unsafe path ${JSON.stringify(name)}`, async (t) => {
    const root = await fixture(t);
    const source = path.join(root, "unsafe.zip");
    await fs.writeFile(source, zipFixture([{ name: "SKILL.md", data: skill("valid") }, { name, data: "bad" }]));
    await assert.rejects(stageLocalSkillPackage(source, path.join(root, "staged")));
    await assert.rejects(fs.stat(path.join(root, "escaped")));
  });
}

for (const [label, entries] of [
  ["duplicate", [{ name: "SKILL.md", data: skill("valid") }, { name: "SKILL.md", data: "different" }]],
  ["case alias", [{ name: "folder/SKILL.md", data: skill("valid") }, { name: "Folder/other", data: "alias" }]],
  ["file-directory collision", [{ name: "folder", data: "file" }, { name: "folder/SKILL.md", data: skill("valid") }]],
  ["symlink", [{ name: "SKILL.md", data: "../target", mode: 0xa1ff }]],
  ["special file", [{ name: "SKILL.md", mode: 0x11ff }]],
  ["encrypted", [{ name: "SKILL.md", data: skill("valid"), flags: 0x801 }]],
  ["unsupported compression", [{ name: "SKILL.md", data: skill("valid"), method: 99 }]],
  ["oversized declared data", [{ name: "SKILL.md", data: "small", method: 8, size: 21 * 1024 * 1024 }]],
  ["underreported inflated size", [{ name: "SKILL.md", data: skill("valid"), method: 8, size: 1 }]],
  ["bad checksum", [{ name: "SKILL.md", data: skill("valid"), crc: 1 }]],
  ["missing skill", [{ name: "README.md", data: "no skill" }]],
  ["unknown permissions", [{ name: "SKILL.md", data: "---\nname: bad\npermissions: unknown:permission\n---\nBad" }]],
  ["duplicate skill names", [{ name: "one/SKILL.md", data: skill("same") }, { name: "two/SKILL.md", data: skill("same") }]],
] satisfies Array<[string, ZipEntry[]]>) {
  test(`ZIP rejects ${label}`, async (t) => {
    const root = await fixture(t);
    const source = path.join(root, "bad.zip");
    await fs.writeFile(source, zipFixture(entries));
    await assert.rejects(stageLocalSkillPackage(source, path.join(root, "staged")));
  });
}

test("ZIP rejects excessive entries, excessive inflated data and malformed archives", async (t) => {
  const root = await fixture(t);
  for (const [index, bytes] of [
    zipFixture(Array.from({ length: 1001 }, (_, index) => ({ name: `entry-${index}` }))),
    zipFixture([{ name: "SKILL.md", data: Buffer.alloc(21 * 1024 * 1024), method: 8 }]),
    Buffer.alloc(21 * 1024 * 1024),
    Buffer.from("not a ZIP"),
  ].entries()) {
    const source = path.join(root, `${index}.zip`);
    await fs.writeFile(source, bytes);
    await assert.rejects(stageLocalSkillPackage(source, path.join(root, `stage-${index}`)));
  }
});

test("oversized standalone files are refused before preview", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "SKILL.md");
  await fs.writeFile(source, Buffer.alloc(21 * 1024 * 1024));
  await assert.rejects(stageLocalSkillPackage(source, path.join(root, "staged")), /20 MB/);
});
