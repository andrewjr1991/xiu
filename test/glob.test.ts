import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import glob from "../src/glob.js";
import { builtinTools, executeTool } from "../src/tools.js";

test("shared glob rejects nested, oversized and alternate malformed patterns before parsing", async () => {
  for (const pattern of ["{".repeat(10000), "(".repeat(10000), "{)".repeat(32), "{\\}".repeat(32), "{[}]".repeat(32), "([)]".repeat(32), "[(".repeat(32), "x".repeat(8193), "f{1..1000000}.ts"]) {
    await assert.rejects(glob(pattern), /Glob .*limit/);
    await assert.rejects(glob("**/*", { ignore: [pattern] }), /Glob .*limit/);
  }
  await assert.rejects(glob(Array(257).fill("**/*")), /Too many glob patterns/);
  await assert.rejects(glob("f{1..3..0}.ts"), /Invalid glob range/);
});

test("glob refuses linked static roots as well as links found during traversal", async (t) => {
  // macOS /var is a system symlink; the absolute-path control must exercise
  // an ordinary external directory, not the intentionally refused link alias.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xiu-glob-junction-")));
  const cwd = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  try {
    await fs.mkdir(cwd);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    try {
      await fs.symlink(outside, path.join(cwd, "external"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("Environment does not allow symlinks");
        return;
      }
      throw error;
    }
    for (const pattern of ["**/*.txt", "external/*.txt", "external/secret.txt"]) {
      assert.deepEqual(await glob(pattern, { cwd, followSymbolicLinks: false }), []);
    }
    assert.deepEqual(await glob("external/*.txt", { cwd, followSymbolicLinks: true }), ["external/secret.txt"]);
    const tool = builtinTools.find((candidate) => candidate.name === "list_files")!;
    assert.match(await executeTool(tool, { pattern: "../outside/*.txt" }, { cwd, approve: async () => false }), /inside workspace/);
    assert.match(await executeTool(tool, { pattern: "../outside/*.txt" }, { cwd, accessMode: "full", approve: async () => false }), /secret\.txt/);
    assert.match(await executeTool(tool, { pattern: `${outside.replaceAll("\\", "/")}/*.txt` }, { cwd, accessMode: "full", approve: async () => false }), /secret\.txt/);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("glob retains braces, extglobs, stepped/padded ranges, dot files and directory non-expansion", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-glob-"));
  try {
    await fs.mkdir(path.join(cwd, "src"));
    await fs.mkdir(path.join(cwd, "node_modules"));
    const names = ["a.ts", "b.ts", ".hidden.ts", "中文.ts", ...Array.from({ length: 12 }, (_, index) => `f${index + 1}.ts`), "p01.ts", "p02.ts", "p03.ts", ...["Z", "[", "]", "^", "_", "`", "a"].map((letter) => `c${letter}.ts`)];
    await Promise.all(names.map((name) => fs.writeFile(path.join(cwd, "src", name), "needle")));
    await fs.writeFile(path.join(cwd, "node_modules", "ignored.ts"), "needle");
    assert.deepEqual((await glob("src/{a,b}.ts", { cwd })).sort(), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual((await glob("src/@(a|b).ts", { cwd })).sort(), ["src/a.ts", "src/b.ts"]);
    assert.equal((await glob("src/f{1..12}.ts", { cwd })).length, 12);
    assert.deepEqual((await glob("src/f{1..9..2}.ts", { cwd })).sort(), [1, 3, 5, 7, 9].map((n) => `src/f${n}.ts`));
    assert.deepEqual((await glob("src/p{01..03}.ts", { cwd })).sort(), ["src/p01.ts", "src/p02.ts", "src/p03.ts"]);
    const crossCase = ["Z", "[", "]", "^", "_", "`", "a"].map((letter) => `src/c${letter}.ts`).sort();
    assert.deepEqual((await glob("src/c{Z..a}.ts", { cwd })).sort(), crossCase);
    assert.deepEqual((await glob("src/c{a..Z}.ts", { cwd })).sort(), crossCase);
    assert.deepEqual(await glob("src/c\\[.ts", { cwd }), ["src/c[.ts"]);
    assert.ok(!(await glob(["src/*.ts", "!src/a.ts"], { cwd })).includes("src/a.ts"));
    assert.deepEqual(await glob("src", { cwd }), []);
    assert.deepEqual((await glob(["src/a.ts", "src/a.ts"], { cwd, unique: true })), ["src/a.ts"]);
    assert.equal((await glob("**/*", { cwd, dot: true, ignore: ["**/node_modules/**"] })).length, names.length);
    assert.equal((await glob("src/a.ts", { cwd, absolute: true }))[0], path.join(cwd, "src", "a.ts").replaceAll("\\", "/"));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("both search tools enforce glob limits even with Full Access and preserve ordinary search", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-glob-tools-"));
  try {
    await fs.writeFile(path.join(cwd, "ok.ts"), "needle");
    for (const name of ["list_files", "search_text"]) {
      const tool = builtinTools.find((candidate) => candidate.name === name)!;
      for (const accessMode of ["ask", "full"] as const) {
        const context = { cwd, accessMode, approve: async () => false };
        for (const pattern of ["{".repeat(1000), "{)".repeat(32)]) {
          assert.match(await executeTool(tool, { pattern, query: "needle" }, context), /^Tool error: Glob .*limit/);
        }
        assert.match(await executeTool(tool, { pattern: "*.ts", query: "needle" }, context), /ok\.ts/);
      }
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
