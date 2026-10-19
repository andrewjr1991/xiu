import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { buildExecutionReport } from "../src/execution-report.js";
import { collectExecutionReportInputs } from "../src/execution-report-query.js";
import { createWorkspaceAgentHost } from "../src/runtime/workspace-agent-host.js";
import { SecurityAuditLog } from "../src/security-audit.js";

/**
 * The desktop's shared workspace host writes every tool approval it decides to the same local
 * security-audit ledger the CLI writes, with the same fixed fields, so `/audit approvals` and the
 * execution report's security count cover desktop runs. Before, only the CLI recorded approvals.
 */

const profile = { id: "fixture", name: "Fixture", kind: "openai-compatible" as const, model: "offline", features: { text: true as const, tools: true, vision: false, image: false, video: false, audio: false } };

async function hostFixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xiu-host-audit-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const auditFile = path.join(root, "security-audit.jsonl");
  let calls = 0;
  // Two file writes, each needing a write-risk approval, then a plain answer.
  const host = await createWorkspaceAgentHost(workspace, {
    profile, journalRoot: path.join(root, "journal"), backgroundRoot: path.join(root, "background"), securityAuditFile: auditFile,
    provider: { async complete() {
      calls++;
      if (calls <= 2) return { text: "Writing", raw: {}, toolCalls: [{ id: `write-${calls}`, name: "write_file", input: { path: `note-${calls}-canary.txt`, content: "canary-content\n" } }] };
      return { text: "Done", toolCalls: [], raw: {} };
    } },
  });
  t.after(() => host.close?.());
  return { root, workspace, auditFile, host };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("automatic approvals of the desktop's workspace mode are recorded like the CLI's, without the tool's arguments", async (t) => {
  const { workspace, auditFile, host } = await hostFixture(t);
  host.setApprovalMode!("workspace");
  await host.runtime.createTask("write two notes");
  assert.ok(["completed", "unverified"].includes(host.runtime.snapshot().task?.state ?? ""), JSON.stringify(host.runtime.snapshot().task));
  assert.equal(await fs.readFile(path.join(workspace, "note-1-canary.txt"), "utf8"), "canary-content\n");

  const audit = new SecurityAuditLog(auditFile, workspace);
  const { records } = await audit.read({ category: "approval", workspaceOnly: true });
  assert.equal(records.length, 2, JSON.stringify(records));
  for (const record of records) {
    assert.equal(record.action, "tool-approval");
    assert.equal(record.outcome, "allowed");
    assert.equal(record.risk, "write");
    assert.equal(record.source, "automatic");
    assert.equal(record.scope, "workspace-files:write", "the narrow session scope of the tool, not its arguments");
  }
  const raw = await fs.readFile(auditFile, "utf8");
  assert.doesNotMatch(raw, /canary/, "neither the path nor the content of the write reaches the ledger");
  assert.doesNotMatch(raw, /write_file|Writing/, "no description or tool name either");

  const inputs = await collectExecutionReportInputs({ cwd: workspace, taskRunJournal: host.journal, securityAudit: audit });
  assert.ok(inputs);
  const report = buildExecutionReport(inputs);
  assert.equal(report.security.events, 2, "the execution report counts the desktop run's approvals");
  assert.equal(report.security.denied, 0);
});

test("prompted desktop decisions are recorded with their outcome and source", async (t) => {
  const { workspace, auditFile, host } = await hostFixture(t);
  const running = host.runtime.createTask("write two notes");
  const pending = () => host.runtime.snapshot().task?.pendingApproval;
  await waitFor(() => Boolean(pending()), "the first approval");
  const first = pending()!;
  host.runtime.decideApproval(first.id, false);
  await waitFor(() => Boolean(pending()) && pending()!.id !== first.id, "the second approval");
  host.runtime.decideApproval(pending()!.id, true);
  await running;
  await assert.rejects(fs.stat(path.join(workspace, "note-1-canary.txt")), { code: "ENOENT" }, "the denied write never happened");
  assert.equal(await fs.readFile(path.join(workspace, "note-2-canary.txt"), "utf8"), "canary-content\n");

  const { records } = await new SecurityAuditLog(auditFile, workspace).read({ category: "approval", workspaceOnly: true });
  assert.deepEqual(records.map((record) => [record.outcome, record.source, record.risk]), [["denied", "prompted", "write"], ["allowed", "prompted", "write"]]);
  const inputs = await collectExecutionReportInputs({ cwd: workspace, taskRunJournal: host.journal, securityAudit: new SecurityAuditLog(auditFile, workspace) });
  const report = buildExecutionReport(inputs!);
  assert.equal(report.security.events, 2);
  assert.equal(report.security.denied, 1);
});
