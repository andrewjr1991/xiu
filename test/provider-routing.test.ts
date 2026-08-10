import assert from "node:assert/strict";
import test from "node:test";
import { determineProviderRoutingPhase } from "../src/provider-routing.js";

test("provider routing classifies analysis implementation and verification with explicit reasons", () => {
  assert.deepEqual(determineProviderRoutingPhase({ turn: 1, planMode: false, completionGateActive: false }), {
    phase: "planning", reason: "initial_analysis",
  });
  assert.deepEqual(determineProviderRoutingPhase({ turn: 8, planMode: true, completionGateActive: false }), {
    phase: "planning", reason: "plan_mode",
  });
  assert.deepEqual(determineProviderRoutingPhase({ turn: 3, planMode: false, completionGateActive: false, activePlanStep: "运行类型检查和构建" }), {
    phase: "verification", reason: "verification_step",
  });
  assert.deepEqual(determineProviderRoutingPhase({ turn: 4, planMode: false, completionGateActive: true }), {
    phase: "verification", reason: "completion_gate",
  });
  assert.deepEqual(determineProviderRoutingPhase({ turn: 2, planMode: false, completionGateActive: false, activePlanStep: "修改 Provider 路由" }), {
    phase: "implementation", reason: "implementation",
  });
});
