import type { AgentTool } from "./types.js";

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  note?: string;
}

export interface TaskPlan {
  goal: string;
  steps: PlanStep[];
  updatedAt: string;
}

export class TaskPlanManager {
  private current?: TaskPlan;
  private planMode = false;

  constructor(initial?: TaskPlan, planMode = false) {
    this.current = initial;
    this.planMode = planMode;
  }

  update(goal: string, steps: PlanStep[]): TaskPlan {
    if (!goal.trim()) throw new Error("plan goal must not be empty");
    if (!steps.length) throw new Error("plan must contain at least one step");
    const ids = new Set<string>();
    for (const step of steps) {
      if (!step.id.trim() || !step.title.trim()) throw new Error("every plan step needs an id and title");
      if (ids.has(step.id)) throw new Error(`duplicate plan step id: ${step.id}`);
      ids.add(step.id);
    }
    if (steps.filter((step) => step.status === "in_progress").length > 1) throw new Error("only one plan step may be in progress");
    this.current = { goal: goal.trim(), steps, updatedAt: new Date().toISOString() };
    return this.current;
  }

  restore(plan?: TaskPlan, mode = false): void {
    this.current = plan;
    this.planMode = mode;
  }

  setMode(enabled: boolean): void { this.planMode = enabled; }
  mode(): boolean { return this.planMode; }
  snapshot(): TaskPlan | undefined { return this.current ? structuredClone(this.current) : undefined; }

  format(): string {
    if (!this.current) return `${this.planMode ? "Plan mode: ON" : "Plan mode: OFF"}\nNo task plan yet.`;
    const icon: Record<PlanStepStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]", blocked: "[!]" };
    return [
      `Plan mode: ${this.planMode ? "ON (read-only)" : "OFF"}`,
      `Goal: ${this.current.goal}`,
      ...this.current.steps.map((step) => `${icon[step.status]} ${step.id} ${step.title}${step.note ? ` - ${step.note}` : ""}`),
    ].join("\n");
  }
}

export function createPlanTools(manager: TaskPlanManager): AgentTool[] {
  return [{
    name: "update_task_plan",
    description: "Create or update the visible task plan. Use for multi-step work and update statuses as work progresses. Keep at most one step in_progress.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        steps: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
              note: { type: "string" },
            },
            required: ["id", "title", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["goal", "steps"],
      additionalProperties: false,
    },
    describe: () => "update the visible task plan",
    async execute(input) {
      if (typeof input.goal !== "string" || !Array.isArray(input.steps)) throw new Error("goal and steps are required");
      const allowed = new Set<PlanStepStatus>(["pending", "in_progress", "completed", "blocked"]);
      const steps = input.steps.map((value) => {
        const step = value as Record<string, unknown>;
        if (typeof step.id !== "string" || typeof step.title !== "string" || typeof step.status !== "string" || !allowed.has(step.status as PlanStepStatus)) {
          throw new Error("invalid plan step");
        }
        return { id: step.id, title: step.title, status: step.status as PlanStepStatus, ...(typeof step.note === "string" ? { note: step.note } : {}) };
      });
      manager.update(input.goal, steps);
      return manager.format();
    },
  }];
}
