import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecurityAuditLog } from "../src/security-audit.js";

test("security audit records only bounded semantic approval and credential fields", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-audit-"));
  const filename = path.join(directory, "audit.jsonl");
  const audit = new SecurityAuditLog(filename, "D:/workspace");
  await audit.record({ category: "approval", action: "tool-request", outcome: "allowed", risk: "write", source: "prompted", scope: "workspace-files:write" });
  await audit.record({ category: "credential", action: "provider-migrate", outcome: "succeeded", subject: "demo" });
  const result = await audit.read({ limit: 10 });
  assert.equal(result.invalidLines, 0);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0]?.workspace.length, 16);
  assert.equal(result.records[1]?.subject, "demo");
  assert.doesNotMatch(await fs.readFile(filename, "utf8"), /D:\/workspace/i);
});

test("security audit redacts runtime secrets and ignores corrupted lines", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-audit-redact-"));
  const filename = path.join(directory, "audit.jsonl");
  const audit = new SecurityAuditLog(filename, directory);
  await audit.record({ category: "credential", action: "provider-test", outcome: "failed", subject: "canary-secret" }, ["canary-secret"]);
  await fs.appendFile(filename, "not-json\n", "utf8");
  const result = await audit.read();
  assert.equal(result.invalidLines, 1);
  assert.equal(result.records.length, 1);
  assert.doesNotMatch(await fs.readFile(filename, "utf8"), /canary-secret/);
  assert.equal(result.records[0]?.subject, "[REDACTED]");
});

test("security audit rotates at a bounded size and serializes concurrent writes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-audit-rotate-"));
  const filename = path.join(directory, "audit.jsonl");
  const audit = new SecurityAuditLog(filename, directory, 700);
  await Promise.all(Array.from({ length: 12 }, (_, index) => audit.record({ category: "approval", action: `request-${index}`, outcome: "allowed", source: "automatic" })));
  const current = await audit.read({ limit: 500 });
  assert.ok(current.records.length > 0);
  assert.equal(current.invalidLines, 0);
  assert.ok((await fs.stat(filename)).size <= 900);
  assert.equal((await fs.stat(`${filename}.1`)).isFile(), true);
});

test("security audit write failures are reported without throwing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-audit-failure-"));
  const filename = path.join(directory, "audit.jsonl");
  await fs.mkdir(filename);
  const audit = new SecurityAuditLog(filename, directory);
  const result = await audit.record({ category: "approval", action: "tool-request", outcome: "denied" });
  assert.equal(result.written, false);
  assert.match(result.error ?? "", /regular file/i);
  assert.equal(audit.status().healthy, false);
});

test("security audit can isolate records to the current workspace", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-audit-workspace-"));
  const filename = path.join(directory, "audit.jsonl");
  const first = new SecurityAuditLog(filename, path.join(directory, "first"));
  const second = new SecurityAuditLog(filename, path.join(directory, "second"));
  await first.record({ category: "approval", action: "first", outcome: "allowed" });
  await second.record({ category: "approval", action: "second", outcome: "denied" });
  const result = await first.read({ limit: 10, workspaceOnly: true });
  assert.deepEqual(result.records.map((record) => record.action), ["first"]);
});
