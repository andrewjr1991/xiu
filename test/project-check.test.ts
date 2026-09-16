import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { discoverProjectChecks, projectCheckPreview, runProjectChecks } from "../src/commands/check.js";
import type { ApprovalRequest, ToolContext } from "../src/types.js";

async function workspace(t: TestContext, scripts?: Record<string, unknown>): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-project-check-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  if (scripts) await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "check-fixture", scripts }), "utf8");
  return cwd;
}

function context(cwd: string, approve: ToolContext["approve"] = async () => true): ToolContext {
  return { cwd, approve };
}

test("check discovery returns exact standard scripts and lifecycle hooks without running them", async (t) => {
  const cwd = await workspace(t, { typecheck: "  tsc --noEmit  ", pretypecheck: "node prepare.js", posttypecheck: "node finish.js", test: "node --test", publish: "node publish.js" });
  const result = await discoverProjectChecks(context(cwd, async () => { assert.fail("Discovery must not request execution approval"); }));
  assert.equal(result.error, undefined);
  assert.equal(result.packageName, "check-fixture");
  assert.deepEqual(result.checks.map(({ name, available }) => [name, available]), [["typecheck", true], ["lint", false], ["test", true], ["build", false]]);
  assert.equal(result.checks[0].script, "  tsc --noEmit  ");
  assert.equal(projectCheckPreview(result.checks[0]), "npm run typecheck\npretypecheck: node prepare.js\ntypecheck:   tsc --noEmit  \nposttypecheck: node finish.js");
  assert.deepEqual(await fs.readdir(cwd), ["package.json"]);
});

test("check discovery explains absent, broken, and invalid package metadata", async (t) => {
  const cwd = await workspace(t);
  assert.equal((await discoverProjectChecks(context(cwd))).packagePresent, false);
  await fs.writeFile(path.join(cwd, "package.json"), "{not valid JSON", "utf8");
  const broken = await discoverProjectChecks(context(cwd));
  assert.match(broken.error ?? "", /package\.json/);
  assert.ok(broken.checks.every((check) => !check.available));
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: ["node --test"] }), "utf8");
  const invalid = await discoverProjectChecks(context(cwd));
  assert.match(invalid.error ?? "", /scripts must be an object/);
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: 42, build: " ", lint: "node lint.js", prelint: 42 } }), "utf8");
  assert.ok((await discoverProjectChecks(context(cwd))).checks.every((check) => !check.available));
});

test("check rejects unsupported names instead of interpreting commands", async (t) => {
  const cwd = await workspace(t, { test: "node --test" });
  await assert.rejects(runProjectChecks("test && npm publish" as "test", context(cwd)), /Usage: \/check/);
});

test("Plan mode discovers checks but never approves or executes scripts", async (t) => {
  const cwd = await workspace(t, { test: "node test.js" });
  await fs.writeFile(path.join(cwd, "test.js"), "require('node:fs').writeFileSync('ran.txt', 'yes');", "utf8");
  const result = await runProjectChecks("all", context(cwd, async () => { assert.fail("Plan mode cannot request execution"); }), { planMode: true });
  assert.equal(result.status, "blocked");
  assert.equal(result.discovery.checks.find((check) => check.name === "test")?.available, true);
  assert.equal(result.counts.skipped, 4);
  assert.match(result.checks[0].output, /Plan mode/);
  await assert.rejects(fs.access(path.join(cwd, "ran.txt")));
});

test("denying a check stops the remaining checks and preserves script preview", async (t) => {
  const cwd = await workspace(t, { typecheck: "node typecheck.js", test: "node test.js" });
  const approvals: ApprovalRequest[] = [];
  const result = await runProjectChecks("all", context(cwd, async (request) => { approvals.push(request); return false; }));
  assert.equal(approvals.length, 1);
  assert.match(approvals[0].preview ?? "", /node typecheck\.js/);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.checks.map((check) => check.status), ["denied", "skipped", "skipped", "skipped"]);
  assert.equal(result.counts.denied, 1);
});

test("all runs actual npm checks in order and reports pass, failure, skip and elapsed time", async (t) => {
  const cwd = await workspace(t, { typecheck: "node typecheck.js", lint: "node lint.js", test: "node test.js" });
  for (const [name, code] of [["typecheck", 0], ["lint", 1], ["test", 0]] as const) {
    await fs.writeFile(path.join(cwd, `${name}.js`), `require('node:fs').appendFileSync('order.txt', '${name}\\n'); process.exit(${code});`, "utf8");
  }
  const events: string[] = [];
  const result = await runProjectChecks("all", context(cwd), {
    onCheckStart: (check) => { events.push(`start:${check.name}`); },
    onCheckResult: (check) => { events.push(`${check.status}:${check.name}`); },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.checks.map((check) => check.status), ["passed", "failed", "passed", "skipped"], JSON.stringify(result.checks));
  assert.deepEqual(result.counts, { passed: 2, failed: 1, cancelled: 0, denied: 0, skipped: 1 });
  assert.equal(await fs.readFile(path.join(cwd, "order.txt"), "utf8"), "typecheck\nlint\ntest\n");
  assert.ok(result.elapsedMs > 0);
  assert.ok(result.checks.every((check) => check.elapsedMs >= 0));
  assert.deepEqual(events, ["start:typecheck", "passed:typecheck", "start:lint", "failed:lint", "start:test", "passed:test", "skipped:build"]);
});

test("a missing requested script is unavailable and never asks for approval", async (t) => {
  const cwd = await workspace(t, { test: "node --test" });
  const result = await runProjectChecks("build", context(cwd, async () => { assert.fail("A missing script cannot execute"); }));
  assert.equal(result.status, "unavailable");
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].status, "skipped");
  assert.match(result.checks[0].output, /No build script/);
});

test("a cancelled signal prevents approvals and check processes", async (t) => {
  const cwd = await workspace(t, { test: "node test.js" });
  const controller = new AbortController();
  controller.abort();
  const result = await runProjectChecks("all", { ...context(cwd, async () => { assert.fail("Cancelled checks cannot approve"); }), signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.counts.cancelled, 1);
  assert.equal(result.counts.skipped, 3);
});

test("cancellation during approval never launches a script even if approval returns true", async (t) => {
  const cwd = await workspace(t, { test: "node test.js" });
  await fs.writeFile(path.join(cwd, "test.js"), "require('node:fs').writeFileSync('ran.txt', 'yes');", "utf8");
  const controller = new AbortController();
  const result = await runProjectChecks("test", {
    ...context(cwd, async () => { controller.abort(); return true; }),
    signal: controller.signal,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.checks[0].status, "cancelled");
  await assert.rejects(fs.access(path.join(cwd, "ran.txt")));
});

test("checks refresh script definitions changed by an earlier check", async (t) => {
  const cwd = await workspace(t, { typecheck: "node prepare.js", test: "node original.js" });
  await fs.writeFile(path.join(cwd, "prepare.js"), "const fs=require('node:fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); delete p.scripts.test; fs.writeFileSync('package.json',JSON.stringify(p));", "utf8");
  const result = await runProjectChecks("all", context(cwd));
  assert.equal(result.checks[0].status, "passed", result.checks[0].output);
  assert.equal(result.checks[2].status, "skipped");
  assert.match(result.checks[2].output, /No test script/);
});

test("discovery redacts known secrets while retaining useful script text", async (t) => {
  const secret = "opaque-check-secret-942852";
  const cwd = await workspace(t, { test: `node verify.js ${secret}` });
  const result = await discoverProjectChecks(context(cwd), { sensitiveValues: [secret] });
  assert.equal(result.checks[2].script, "node verify.js [REDACTED]");
  assert.ok(!JSON.stringify(result).includes(secret));
});
