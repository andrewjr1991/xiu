import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "../src/agent.js";
import { deleteSession, listSessionsWithIssues, loadSession, rebuildSessionSummaries, refreshSessionSummary } from "../src/session.js";
import { inspectSessionSummaryStorage, readSessionSummary, writeSessionSummary } from "../src/session-summary.js";

for (const replacement of ["regular", "symlink"] as const) {
  test(`summary replacement with ${replacement} at open falls back to the original log`, { skip: replacement === "symlink" && process.platform === "win32" }, async (t) => {
    const f = await fixture(t);
    await refreshSessionSummary(f.file);
    const value = JSON.parse(await fs.readFile(f.summary, "utf8"));
    value.item.firstTask = "foreign cache canary";
    const foreign = path.join(f.cwd, "foreign-cache.json");
    await fs.writeFile(foreign, JSON.stringify(value));
    const original = fs.open.bind(fs);
    let replaced = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === f.summary && !replaced) {
        replaced = true;
        await fs.rename(f.summary, `${f.summary}.previous`);
        if (replacement === "symlink") await fs.symlink(foreign, f.summary);
        else await fs.copyFile(foreign, f.summary);
        // Exercise the portable verification used when no-follow is unavailable.
        args[1] = (args[1] as number) & ~(constants.O_NOFOLLOW ?? 0);
      }
      return original(...args);
    });
    const listing = await listSessionsWithIssues(f.cwd);
    assert.equal(listing.sessions[0]?.firstTask, "original task");
    assert.equal(await fs.readFile(foreign, "utf8"), JSON.stringify(value));
  });
}

test("a summary changed during reading falls back without accepting mixed cache evidence", async (t) => {
  const f = await fixture(t);
  await refreshSessionSummary(f.file);
  const value = JSON.parse(await fs.readFile(f.summary, "utf8"));
  value.item.firstTask = "changed cache"; // Same byte length as the original title.
  const original = fs.open.bind(fs);
  let changed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]) === f.summary) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (...data: Parameters<typeof handle.read>) => {
        if (!changed) {
          changed = true;
          await fs.writeFile(f.summary, JSON.stringify(value));
          const future = new Date(Date.now() + 10000);
          await fs.utimes(f.summary, future, future);
        }
        return read(...data);
      });
    }
    return handle;
  });
  const listing = await listSessionsWithIssues(f.cwd);
  assert.equal(changed, true);
  assert.equal(listing.sessions[0]?.firstTask, "original task");
  assert.deepEqual(listing.unreadable, []);
});

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-summary-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, ".xiu", "sessions");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "sample.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ type: "task", task: "original task", timestamp: "2026-11-04T00:00:00.000Z", config: { providerId: "original-provider", model: "original-model" } })}\nnull\n`);
  return { cwd, file, summary: `${file}.summary.json` };
}

test("summary storage counts file bytes without opening contents or creating missing caches", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.summary, "invalid-private-cache-私密");
  const missing = path.join(path.dirname(f.file), "missing-cache.jsonl");
  await fs.writeFile(missing, "");
  const directory = path.join(path.dirname(f.file), "directory-cache.jsonl");
  await fs.writeFile(directory, "");
  await fs.mkdir(`${directory}.summary.json`);
  const large = path.join(path.dirname(f.file), "large-cache.jsonl");
  await fs.writeFile(large, "");
  const handle = await fs.open(`${large}.summary.json`, "w");
  await handle.truncate(1024 * 1024);
  await handle.close();
  await fs.writeFile(path.join(path.dirname(f.file), "orphan.jsonl.summary.json"), "not-counted");
  const before = await fs.readdir(path.dirname(f.file));
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", (...args: Parameters<typeof fs.open>) => {
    assert.ok(!String(args[0]).endsWith(".summary.json"), "metadata inspection must never open cache contents");
    return originalOpen(...args);
  });
  assert.deepEqual(await inspectSessionSummaryStorage([f.file, missing, directory, large]), {
    files: 2, bytes: Buffer.byteLength("invalid-private-cache-私密") + 1024 * 1024, missing: 1, unsafe: 1, unreadable: [],
  }, "oversized or invalid caches still occupy bytes; this is not content validation");
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), before);
});

test("summary storage isolates metadata errors and source disappearance without exposing paths", async (t) => {
  const f = await fixture(t);
  const removed = path.join(path.dirname(f.file), "removed.jsonl");
  const original = fs.lstat.bind(fs);
  t.mock.method(fs, "lstat", async (file: Parameters<typeof fs.lstat>[0]) => {
    if (String(file) === f.summary) throw Object.assign(new Error(`private-cache-canary ${f.summary}`), { code: "EACCES" });
    return original(file);
  });
  const result = await inspectSessionSummaryStorage([f.file, removed]);
  assert.deepEqual(result, { files: 0, bytes: 0, missing: 0, unsafe: 0, unreadable: [{ reason: "EACCES" }, { reason: "ENOENT" }] });
  assert.doesNotMatch(JSON.stringify(result), /private-cache-canary|sample|removed|xiu-summary/);
});

test("summary storage does not follow linked caches or wait on FIFOs", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await fs.symlink(f.file, f.summary);
  const pipeSource = path.join(path.dirname(f.file), "pipe.jsonl");
  await fs.writeFile(pipeSource, "");
  execFileSync("mkfifo", [`${pipeSource}.summary.json`]);
  const moduleUrl = new URL("../src/session-summary.ts", import.meta.url).href;
  const code = `const {inspectSessionSummaryStorage}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await inspectSessionSummaryStorage(${JSON.stringify([f.file, pipeSource])})));`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { timeout: 10_000, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), { files: 0, bytes: 0, missing: 0, unsafe: 2, unreadable: [] });
  assert.equal((await fs.lstat(f.summary)).isSymbolicLink(), true);
  assert.equal((await fs.lstat(`${pipeSource}.summary.json`)).isFIFO(), true);
});

test("summary survives a fresh read, preserves damage counts and contains no path or transcript", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.file, '{"type":"tool","result":"private-tool-canary"}\n');
  const uncached = await listSessionsWithIssues(f.cwd, { useSummary: false });
  assert.equal(await refreshSessionSummary(f.file), true);
  const cached = await readSessionSummary(f.file, await fs.stat(f.file));
  assert.deepEqual(cached, uncached.sessions[0]);
  assert.equal(cached!.damagedLines, 1);
  assert.deepEqual(await listSessionsWithIssues(f.cwd), uncached);
  const stored = await fs.readFile(f.summary, "utf8");
  assert.doesNotMatch(stored, /private-tool-canary/);
  assert.equal(stored.includes(f.cwd), false);
  if (process.platform !== "win32") assert.equal((await fs.stat(f.summary)).mode & 0o077, 0);
});

test("Agent writes display summaries, and cache write failure cannot turn a successful task into failure", async (t) => {
  const f = await fixture(t);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  const agent = new Agent({ config: { cwd: f.cwd, provider: "openai", providerId: "test", model: "test", language: "en-US", maxTurns: 3, autoApprove: false }, provider: { async complete() { return { text: "done", toolCalls: [], raw: {} }; } }, tools: [], approve: async () => false });
  await agent.run("first task");
  const file = path.join(f.cwd, ".xiu", "sessions", `${agent.status().sessionId}.jsonl`);
  assert.ok(await readSessionSummary(file, await fs.stat(file)));
  await fs.unlink(`${file}.summary.json`);
  await fs.mkdir(`${file}.summary.json`);
  await agent.run("second task");
  assert.equal(agent.status().outcome, "completed");
  assert.match(errors.flat().join(" "), /original log is saved/);
  assert.equal((await loadSession(f.cwd, agent.status().sessionId)).messages.some((message) => message.content === "second task"), true);
});

test("verification ledger counters are not restored as authority from a saved conversation", async (t) => {
  const f = await fixture(t);
  const options = { config: { cwd: f.cwd, provider: "openai" as const, providerId: "test", model: "test", maxTurns: 3, autoApprove: false }, provider: { async complete() { return { text: "done", toolCalls: [], raw: {} }; } }, tools: [], approve: async () => false };
  const agent = new Agent(options);
  assert.equal(agent.status().verification, undefined);
  await agent.run("answer only");
  assert.equal(agent.status().verification?.state, "not_run");
  const restored = await loadSession(f.cwd, agent.status().sessionId);
  const resumed = new Agent({ ...options, restored });
  assert.equal(resumed.status().verification, undefined);
  agent.clearConversation();
  assert.equal(agent.status().verification, undefined);
});

test("listing and doctor-style fresh scans never create a summary as a side effect", async (t) => {
  const f = await fixture(t);
  await listSessionsWithIssues(f.cwd);
  await listSessionsWithIssues(f.cwd, { useSummary: false });
  await assert.rejects(fs.stat(f.summary), { code: "ENOENT" });
});

test("explicit index rebuild preserves source logs and continues past unreadable logs", async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(f.file, "utf8");
  await fs.mkdir(path.join(path.dirname(f.file), "broken.jsonl"));
  assert.deepEqual(await rebuildSessionSummaries(f.cwd), { indexed: 1, skipped: 0, failed: 1 });
  assert.equal(await fs.readFile(f.file, "utf8"), original);
  assert.ok(await readSessionSummary(f.file, await fs.stat(f.file)));
  assert.deepEqual(await rebuildSessionSummaries(f.cwd), { indexed: 1, skipped: 0, failed: 1 });
});

test("deleting a session removes its summary without following a substituted summary link", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await refreshSessionSummary(f.file);
  const target = path.join(f.cwd, "unrelated.json");
  await fs.writeFile(target, "unrelated-user-data");
  await fs.unlink(f.summary);
  await fs.symlink(target, f.summary);
  assert.equal(await deleteSession(f.cwd, "sample"), true);
  await assert.rejects(fs.lstat(f.file), { code: "ENOENT" });
  await assert.rejects(fs.lstat(f.summary), { code: "ENOENT" });
  assert.equal(await fs.readFile(target, "utf8"), "unrelated-user-data");
});

test("appends and same-size rewrites invalidate the summary even with restored mtime", async (t) => {
  const f = await fixture(t);
  await refreshSessionSummary(f.file);
  await fs.appendFile(f.file, '{"type":"model_changed","model":"appended"}\n');
  assert.equal(await readSessionSummary(f.file, await fs.stat(f.file)), undefined);
  assert.equal((await listSessionsWithIssues(f.cwd)).sessions[0]!.model, "appended");
  await refreshSessionSummary(f.file);
  const previous = await fs.stat(f.file);
  // Ensure this also distinguishes changes on filesystems with coarse timestamps.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const text = await fs.readFile(f.file, "utf8");
  await fs.writeFile(f.file, text.replace("appended", "rewritten".slice(0, 8)));
  await fs.utimes(f.file, previous.atime, previous.mtime);
  assert.equal((await fs.stat(f.file)).size, previous.size);
  assert.equal(await readSessionSummary(f.file, await fs.stat(f.file)), undefined);
  assert.equal((await listSessionsWithIssues(f.cwd)).sessions[0]!.model, "rewritte");
});

test("corrupt, future, oversized and malformed summaries fall back to the original log", async (t) => {
  const f = await fixture(t);
  await refreshSessionSummary(f.file);
  const valid = JSON.parse(await fs.readFile(f.summary, "utf8"));
  for (const content of ["{broken", "null", JSON.stringify({ ...valid, version: 999 }), JSON.stringify({ ...valid, item: [] }), JSON.stringify({ ...valid, item: { ...valid.item, damagedLines: -1 } }), " ".repeat(70 * 1024)]) {
    await fs.writeFile(f.summary, content);
    assert.equal(await readSessionSummary(f.file, await fs.stat(f.file)), undefined);
    assert.equal((await listSessionsWithIssues(f.cwd)).sessions[0]!.firstTask, "original task");
  }
});

test("cached display metadata cannot choose a restored provider or model", async (t) => {
  const f = await fixture(t);
  await refreshSessionSummary(f.file);
  const value = JSON.parse(await fs.readFile(f.summary, "utf8"));
  value.item.providerId = "injected-provider";
  value.item.model = "injected-model";
  await fs.writeFile(f.summary, JSON.stringify(value));
  assert.equal((await listSessionsWithIssues(f.cwd)).sessions[0]!.model, "injected-model", "cache is display-only, not an authenticated record");
  const restored = await loadSession(f.cwd, "sample");
  assert.equal(restored.providerId, "original-provider");
  assert.equal(restored.model, "original-model");
});

test("a concurrent append prevents publishing a stale summary", async (t) => {
  const f = await fixture(t);
  const item = (await listSessionsWithIssues(f.cwd)).sessions[0]!;
  const saved = await writeSessionSummary(f.file, async () => {
    await fs.appendFile(f.file, '{"type":"assistant","text":"new result"}\n');
    return item;
  });
  assert.equal(saved, false);
  await assert.rejects(fs.stat(f.summary), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).filter((name) => name.endsWith(".tmp")), []);
});

test("linked summary objects and source directories are not used for cache writes", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await refreshSessionSummary(f.file);
  const target = path.join(f.cwd, "user-file.json");
  await fs.rename(f.summary, target);
  await fs.symlink(target, f.summary);
  assert.equal(await readSessionSummary(f.file, await fs.stat(f.file)), undefined);
  const linked = path.join(f.cwd, "linked");
  await fs.symlink(path.dirname(f.file), linked);
  await assert.rejects(refreshSessionSummary(path.join(linked, "sample.jsonl")), { code: "ELOOP" });
  assert.equal((await fs.readFile(target, "utf8")).includes("original task"), true);
});


test("a summary replaced with a FIFO during open falls back without blocking history", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await refreshSessionSummary(f.file);
  // Isolate the reader so a regression in open() is bounded even if its I/O blocks.
  const script = `
    import assert from "node:assert/strict";
    import fs from "node:fs/promises";
    import { execFileSync } from "node:child_process";
    import { listSessionsWithIssues } from ${JSON.stringify(new URL("../src/session.ts", import.meta.url).href)};
    const summary = ${JSON.stringify(f.summary)};
    const open = fs.open.bind(fs);
    let replaced = false;
    fs.open = async (...args) => {
      if (args[0] === summary && !replaced) {
        replaced = true;
        await fs.unlink(summary);
        execFileSync("mkfifo", [summary]);
      }
      return open(...args);
    };
    const listing = await listSessionsWithIssues(${JSON.stringify(f.cwd)});
    assert.equal(replaced, true);
    assert.equal(listing.sessions[0]?.firstTask, "original task");
    assert.deepEqual(listing.unreadable, []);
    console.log("fallback-completed");
  `;
  assert.equal(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 }).trim(), "fallback-completed");
});
