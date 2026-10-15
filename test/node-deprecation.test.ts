import assert from "node:assert/strict";
import test from "node:test";
import { nodeDeprecationNotice } from "../src/node-runtime.js";

test("Node 20 gets a one-line end-of-life notice; other majors get nothing", () => {
  assert.match(nodeDeprecationNotice("20.18.1", "zh-CN")!, /^提示：当前 Node\.js 20\.18\.1 已于 2026-04-30 停止维护。Xiu 0\.22 起要求 Node\.js 22\.12/);
  assert.match(nodeDeprecationNotice("v20.20.2", "en-US")!, /^Notice: Node\.js v20\.20\.2 reached end of life on 2026-04-30\. Xiu 0\.22 will require Node\.js 22\.12/);
  assert.equal(nodeDeprecationNotice("22.12.0", "zh-CN"), undefined);
  assert.equal(nodeDeprecationNotice("24.1.0", "en-US"), undefined);
  assert.equal(nodeDeprecationNotice("18.20.0", "en-US"), undefined, "below the minimum the update doctor already reports a hard failure");
  assert.ok(!nodeDeprecationNotice("20.18.1", "zh-CN")!.includes("\n"), "one line");
});
