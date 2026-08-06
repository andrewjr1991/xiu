import assert from "node:assert/strict";
import test from "node:test";
import { ActivityLog } from "../src/activity.js";

test("activity log keeps a bounded summary and complete detail", () => {
  const log = new ActivityLog(2);
  const first = log.start("tool", "read_file", "read a file");
  log.finish(first, "line\n".repeat(100));
  log.start("system", "middle", "middle");
  const last = log.start("agent", "review", "review code");
  assert.equal(log.list().length, 2);
  assert.equal(log.get(first), undefined);
  assert.equal(log.get(last)?.description, "review code");
  assert.ok((log.list()[1]?.summary?.length ?? 0) <= 180);
});
