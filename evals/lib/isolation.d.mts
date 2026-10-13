// Type declarations for isolation.mjs, used when TypeScript tests import it.

export interface EvalIsolation {
  root: string;
  workspace: string;
  home: string;
  cleanup(): Promise<void>;
}

export declare function createIsolation(taskDirectory: string): Promise<EvalIsolation>;
