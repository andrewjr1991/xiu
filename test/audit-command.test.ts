import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAuditCommand } from "../src/commands/audit-command.js";
import { SecurityAuditLog } from "../src/security-audit.js";

interface Fixture { cwd: string; audit: SecurityAuditLog; out: string[]; err: string[] }

async function fixture(t: test.TestContext, records = 3): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-audit-command-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  const audit = new SecurityAuditLog(path.join(root, "security-audit.jsonl"), cwd);
  for (let index = 0; index < records; index++) {
    await audit.record({ category: "approval", action: "tool-approval", outcome: index === 1 ? "denied" : "allowed", risk: index === 1 ? "dangerous" : "write", source: index === 1 ? "prompted" : "automatic", scope: "workspace-files:write" });
  }
  if (records) await audit.record({ category: "credential", action: "provider-forget", outcome: "succeeded", subject: "openai sk-live-secret-1234567890abcdef", source: "command" });
  // A record of another workspace never shows here.
  await new SecurityAuditLog(audit.filename, path.join(root, "other")).record({ category: "approval", action: "tool-approval", outcome: "denied", risk: "dangerous", source: "prompted" });
  return { cwd, audit, out: [], err: [] };
}

function run(f: Fixture, args: string[], options: { trusted?: boolean; language?: "zh-CN" | "en-US"; audit?: Pick<SecurityAuditLog, "read" | "status"> } = {}): Promise<number> {
  return runAuditCommand(args, {
    cwd: f.cwd, language: options.language ?? "en-US",
    stdout: (text) => f.out.push(text), stderr: (text) => f.err.push(text),
    audit: options.audit ?? f.audit, isTrusted: async () => options.trusted ?? true,
  });
}

test("xiu audit lists this workspace's records newest last with the ledger's fixed fields only", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(f, []), 0);
  assert.equal(f.err.length, 0);
  const lines = f.out[0]!.split("\n");
  assert.match(lines[0]!, /^Local security audit of this workspace/);
  assert.equal(lines.length, 5, f.out[0]);
  assert.match(lines[1]!, /approval · tool-approval · allowed · write · automatic · workspace-files:write$/);
  assert.match(lines[2]!, /approval · tool-approval · denied · dangerous · prompted · workspace-files:write$/);
  assert.match(lines[4]!, /credential · provider-forget · succeeded · command · openai/);
  assert.doesNotMatch(f.out[0]!, /sk-live-secret/, "credential subjects are redacted by the ledger");
  assert.doesNotMatch(f.out[0]!, /other/, "another workspace's record never shows");
});

test("xiu audit filters by category, limits the count and prints a JSON document on request", async (t) => {
  const f = await fixture(t);
  assert.equal(await run(f, ["credentials"]), 0);
  assert.equal(f.out.at(-1)!.split("\n").length, 2);
  assert.match(f.out.at(-1)!, /provider-forget/);

  assert.equal(await run(f, ["approvals", "2"]), 0);
  const limited = f.out.at(-1)!.split("\n");
  assert.equal(limited.filter((line) => line.includes("tool-approval")).length, 2, "the two most recent approvals");
  assert.match(limited.at(-1)!, /Showing only the 2 most recent/);

  assert.equal(await run(f, ["json", "approval"]), 0);
  const document = JSON.parse(f.out.at(-1)!) as { category: string; limit: number; records: Array<{ outcome: string; action: string }>; truncated: boolean; invalidLines: number };
  assert.equal(document.category, "approval");
  assert.equal(document.limit, 50);
  assert.deepEqual(document.records.map((record) => record.outcome), ["allowed", "denied", "allowed"]);
  assert.equal(document.truncated, false);
  assert.equal(document.invalidLines, 0);
});

test("xiu audit says so when nothing matches, and refuses bad arguments, untrusted workspaces and an unreadable ledger", async (t) => {
  const empty = await fixture(t, 0);
  assert.equal(await run(empty, []), 0);
  assert.match(empty.out[0]!, /No matching records/);
  assert.equal(await run(empty, ["json"]), 0);
  assert.deepEqual((JSON.parse(empty.out.at(-1)!) as { records: unknown[] }).records, []);

  const f = await fixture(t);
  for (const bad of [["everything"], ["approvals", "credentials"], ["0"], ["501"], ["--json"], ["json", "json"]]) {
    f.err.length = 0;
    assert.equal(await run(f, bad), 1, bad.join(" "));
    assert.match(f.err[0]!, /^Usage: xiu audit/);
  }
  f.err.length = 0;
  assert.equal(await run(f, [], { trusted: false }), 1);
  assert.match(f.err[0]!, /not trusted yet/);
  f.err.length = 0;
  assert.equal(await run(f, [], { language: "zh-CN", trusted: false }), 1);
  assert.match(f.err[0]!, /工作区尚未信任/);

  f.err.length = 0;
  const broken = { read: async () => { throw new Error("Could not read security audit log: EACCES"); }, status: f.audit.status.bind(f.audit) };
  assert.equal(await run(f, [], { audit: broken }), 1);
  assert.match(f.err[0]!, /Could not read security audit: Could not read security audit log: EACCES/);
});
