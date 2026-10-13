// Type declarations for tools.mjs, used when TypeScript tests import it.

export interface EvaluationTool {
  name: string;
  description: string;
  risk: "read" | "write" | "execute";
  replaySafety: "safe" | "idempotent";
  changesWorkspace?: boolean;
  inputSchema: Record<string, unknown>;
  describe(input: Record<string, unknown>): string;
  execute(input: Record<string, unknown>, context: unknown): Promise<string>;
}

export declare function evaluationToolFailureCode(error: unknown): string;
export declare function createEvaluationTools(workspace: string, options?: { allowedChanges?: readonly string[] }): EvaluationTool[];
