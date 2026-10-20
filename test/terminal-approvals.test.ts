import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundApprovalRequiredError } from "../src/agent.js";
import type { SecurityAuditInput } from "../src/security-audit.js";
import { createTerminalApprovals, type ApprovalChoice, type TerminalApprovalsContext } from "../src/terminal-approvals.js";
import type { ApprovalRequest } from "../src/types.js";

const plain = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");

function harness(options: { autoApprove?: boolean; backgroundMode?: boolean; interactive?: boolean; language?: "zh-CN" | "en-US"; answers?: ApprovalChoice[] } = {}) {
  const audit: SecurityAuditInput[] = [];
  const logs: string[] = [];
  const calls: string[] = [];
  const prompts: Array<{ title: string; options: string[] }> = [];
  const answers = [...(options.answers ?? [])];
  const pendingSelects: Array<(choice: ApprovalChoice | undefined) => void> = [];
  const context: TerminalApprovalsContext = {
    config: { autoApprove: options.autoApprove ?? false, backgroundMode: options.backgroundMode },
    language: () => options.language ?? "en-US",
    securityAudit: { record: async (input) => { audit.push(input); return { written: true }; } },
    status: { stop: () => { calls.push("status:stop"); } },
    beforePrompt: () => { calls.push("beforePrompt"); },
    io: {
      interactive: () => options.interactive ?? true,
      log: (line) => { logs.push(plain(line)); },
      select: (title, selectOptions, language) => {
        prompts.push({ title: plain(title), options: selectOptions.map((item) => `${item.value}:${item.label}:${item.description}`) });
        calls.push(`select:${language}`);
        if (answers.length) return Promise.resolve(answers.shift());
        return new Promise((resolve) => { pendingSelects.push(resolve); });
      },
    },
  };
  return { approvals: createTerminalApprovals(context), audit, logs, calls, prompts, pendingSelects };
}

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ description: "write notes.txt", risk: "write", ...overrides });

test("-y approves write and execute requests automatically but never dangerous ones", async () => {
  const h = harness({ autoApprove: true, interactive: false });
  const write = request();
  assert.equal(await h.approvals.approve(write), true);
  assert.equal(write.decisionSource, "automatic");
  const execute = request({ risk: "execute", description: "run npm test" });
  assert.equal(await h.approvals.approve(execute), true);
  const dangerous = request({ risk: "dangerous", description: "delete keep-me" });
  assert.equal(await h.approvals.approve(dangerous), false, "no terminal can answer the dangerous prompt");
  assert.equal(dangerous.decisionSource, "prompted");
  assert.deepEqual(h.audit.map((entry) => [entry.outcome, entry.risk, entry.source, entry.scope]), [
    ["allowed", "write", "automatic", "unscoped"],
    ["allowed", "execute", "automatic", "unscoped"],
    ["denied", "dangerous", "prompted", "unscoped"],
  ]);
  assert.deepEqual(h.calls, [], "nothing is stopped or discarded when no prompt is shown");
});

test("without a terminal the request is denied, or raised as an error in background mode, and audited either way", async () => {
  const piped = harness({ interactive: false });
  assert.equal(await piped.approvals.approve(request()), false);
  assert.deepEqual(piped.audit.map((entry) => [entry.outcome, entry.source]), [["denied", "prompted"]]);
  assert.deepEqual(piped.prompts, []);

  const background = harness({ interactive: false, backgroundMode: true });
  await assert.rejects(background.approvals.approve(request({ description: "run the build" })), (error: unknown) =>
    error instanceof BackgroundApprovalRequiredError && error.description === "run the build");
  assert.deepEqual(background.audit.map((entry) => [entry.outcome, entry.source]), [["denied", "prompted"]]);
});

test("the prompt shows the preview and the risk, and 'once' allows without remembering anything", async () => {
  const h = harness({ answers: ["once", "deny"] });
  const first = request({ preview: "+hello" });
  assert.equal(await h.approvals.approve(first), true);
  assert.equal(first.decisionSource, "prompted");
  assert.deepEqual(h.calls, ["status:stop", "beforePrompt", "select:en-US"]);
  assert.deepEqual(h.logs, ["Proposed change:\n+hello\n"]);
  assert.deepEqual(h.prompts, [{
    title: "WRITE approval: allow Xiu to write notes.txt?",
    options: ["deny:No, deny:Do not run this operation", "once:Yes, allow once:write notes.txt"],
  }]);
  assert.equal(await h.approvals.approve(request()), false, "the same request prompts again and can be denied");
  assert.deepEqual(h.audit.map((entry) => [entry.outcome, entry.source]), [["allowed", "prompted"], ["denied", "prompted"]]);
});

test("'always allow this session' is offered only for scoped requests and is remembered until the process exits", async () => {
  const h = harness({ answers: ["session"] });
  const scoped = request({ risk: "execute", description: "run git status", sessionScope: "git:read" });
  assert.equal(await h.approvals.approve(scoped), true);
  assert.equal(h.prompts[0]?.options[2], "session:Yes, always allow this session:Remember only this operation family until Xiu exits");
  const again = request({ risk: "execute", description: "run git log", sessionScope: "git:read" });
  assert.equal(await h.approvals.approve(again), true);
  assert.equal(again.decisionSource, "remembered");
  assert.equal(h.prompts.length, 1, "the remembered scope is not prompted again");
  const other = request({ risk: "execute", description: "run git push", sessionScope: "git:write" });
  h.pendingSelects.length = 0;
  const pending = h.approvals.approve(other);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.prompts.length, 2, "a different scope prompts");
  h.pendingSelects.shift()?.("deny");
  assert.equal(await pending, false);
  assert.deepEqual(h.audit.map((entry) => [entry.outcome, entry.source, entry.scope]), [
    ["allowed", "prompted", "git:read"], ["allowed", "remembered", "git:read"], ["denied", "prompted", "git:write"],
  ]);
});

test("a cancelled menu (no selection) counts as denied", async () => {
  const h = harness();
  const pending = h.approvals.approve(request({ sessionScope: "fs:write" }));
  await new Promise((resolve) => setImmediate(resolve));
  h.pendingSelects.shift()?.(undefined);
  assert.equal(await pending, false);
  assert.deepEqual(h.audit.map((entry) => [entry.outcome, entry.scope]), [["denied", "fs:write"]]);
});

test("prompts are shown one at a time and activePrompt resolves once the current one is answered", async () => {
  const h = harness();
  const first = h.approvals.approve(request({ description: "first" }));
  const second = h.approvals.approve(request({ description: "second" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.prompts.length, 1, "the second prompt waits for the first");
  let active = false;
  void h.approvals.activePrompt().then(() => { active = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, false);
  h.pendingSelects.shift()?.("once");
  assert.equal(await first, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, true);
  assert.equal(h.prompts.length, 2);
  h.pendingSelects.shift()?.("deny");
  assert.equal(await second, false);
});

test("Chinese wording is used when the session language is zh-CN", async () => {
  const h = harness({ language: "zh-CN", answers: ["deny"] });
  await h.approvals.approve(request({ risk: "dangerous", description: "删除 keep-me", preview: "rm -rf keep-me", sessionScope: "billable-media:image" }));
  assert.deepEqual(h.logs, ["拟议修改：\nrm -rf keep-me\n"]);
  assert.deepEqual(h.prompts, [{
    title: "DANGEROUS 审批：允许 Xiu 删除 keep-me？",
    options: ["deny:否，拒绝:不执行此操作", "once:是，仅允许一次:删除 keep-me", "session:是，本次会话始终允许:仅记住这一类操作；重新启动 Xiu 后失效"],
  }]);
  assert.deepEqual(h.calls, ["status:stop", "beforePrompt", "select:zh-CN"]);
});
