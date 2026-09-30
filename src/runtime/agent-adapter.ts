import type { Agent } from "../agent.js";
import type { RuntimeTaskDriver } from "./xiu-runtime.js";

/** Thin adapter: Agent remains the execution authority; XiuRuntime owns UI state. */
export class AgentRuntimeAdapter implements RuntimeTaskDriver {
  constructor(private readonly agent: Agent) {}

  run(task: string): Promise<string> { return this.agent.run(task); }
  cancel(): boolean { return this.agent.cancel(); }
  steer(text: string): boolean { return this.agent.steer(text); }
  status(): ReturnType<Agent["status"]> { return this.agent.status(); }
}
