export const VERSION: string;
export const BRANCH: string;
export interface ReleaseJob { name: string; head_sha: string; status: string; conclusion: string; }
export function validateJobs(jobs: ReleaseJob[], commit: string): void;
export function validateBundle(directory: string, kind: "cli" | "desktop", commit: string, runId: string, attempt: string): Promise<{ name: string; bytes: Buffer }>;
