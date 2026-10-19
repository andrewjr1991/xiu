import assert from "node:assert/strict";
import test from "node:test";
import { runDoctorCommand, serializeDoctorReport } from "../src/commands/doctor-command.js";
import type { DoctorReport } from "../src/doctor.js";

function report(status: DoctorReport["status"] = "pass"): DoctorReport {
  return {
    version: "0.21.0", generatedAt: "2026-10-19T12:00:00.000Z", status,
    sections: [
      { id: "installation", titleZh: "安装与运行环境", titleEn: "Installation", items: [
        { id: "runtime", level: "pass", labelZh: "Node.js", labelEn: "Node.js", summaryZh: "Node.js 22.12.0", summaryEn: "Node.js 22.12.0" },
      ] },
      { id: "proxy", titleZh: "代理与证书", titleEn: "Proxy and certificates", items: [
        { id: "tls", level: status === "failure" ? "failure" : "pass", labelZh: "TLS", labelEn: "TLS", summaryZh: "证书校验已关闭", summaryEn: "Certificate verification is off", detailZh: "去掉 NODE_TLS_REJECT_UNAUTHORIZED=0。", detailEn: "Remove NODE_TLS_REJECT_UNAUTHORIZED=0." },
      ] },
    ],
  };
}

function run(args: string[], options: { status?: DoctorReport["status"]; language?: "zh-CN" | "en-US"; collected?: number[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runDoctorCommand(args, {
    language: options.language ?? "en-US",
    collect: async () => { options.collected?.push(1); return report(options.status); },
    stdout: (text) => out.push(text), stderr: (text) => err.push(text),
  });
  return code.then((exitCode) => ({ exitCode, out, err }));
}

test("xiu doctor prints the formatted report in the chosen language and exits 0 without a failure", async () => {
  const zh = await run([], { language: "zh-CN" });
  assert.equal(zh.exitCode, 0);
  assert.equal(zh.err.length, 0);
  assert.match(zh.out[0]!, /^Xiu 诊断报告/m);
  assert.match(zh.out[0]!, /\[安装与运行环境\]\n✓ Node\.js: Node\.js 22\.12\.0/);
  const en = await run([]);
  assert.match(en.out[0]!, /\[Installation\]\n✓ Node\.js: Node\.js 22\.12\.0/);
});

test("xiu doctor json prints the whole report as one JSON document, both languages, and exits by status", async () => {
  const collected: number[] = [];
  const passed = await run(["json"], { collected });
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.err.length, 0);
  assert.equal(passed.out.length, 1);
  assert.equal(collected.length, 1, "the report is collected once");
  const parsed = JSON.parse(passed.out[0]!) as DoctorReport;
  assert.deepEqual(parsed, report(), "the JSON is the redacted report as collected");
  assert.equal(passed.out[0], serializeDoctorReport(report()));
  assert.equal(parsed.sections[1]!.items[0]!.detailEn, "Remove NODE_TLS_REJECT_UNAUTHORIZED=0.");
  assert.equal(parsed.sections[1]!.items[0]!.detailZh, "去掉 NODE_TLS_REJECT_UNAUTHORIZED=0。");

  const failed = await run(["JSON"], { status: "failure", language: "zh-CN" });
  assert.equal(failed.exitCode, 1, "a failure exits 1 in JSON mode too, so CI can gate on it");
  assert.equal((JSON.parse(failed.out[0]!) as DoctorReport).status, "failure");
  assert.equal(failed.err.length, 0);
});

test("xiu doctor refuses any other word with the usage line instead of running it as a task", async () => {
  const collected: number[] = [];
  for (const args of [["jsno"], ["json", "json"], ["--verbose"], ["json", "txt"]]) {
    const result = await run(args, { collected });
    assert.equal(result.exitCode, 1, args.join(" "));
    assert.equal(result.out.length, 0, "nothing on stdout");
    assert.match(result.err[0]!, /^Usage: xiu doctor \[json\]/);
  }
  assert.equal(collected.length, 0, "the report is not collected on a usage error");
  const zh = await run(["x"], { language: "zh-CN" });
  assert.match(zh.err[0]!, /^用法：xiu doctor \[json\]/);
});
