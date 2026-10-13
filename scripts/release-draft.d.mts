// Type declarations for release-draft.mjs, used when TypeScript tests import it.

export interface WorkflowRun { id: number; head_sha: string; head_branch: string; event: string; path: string; status: string; conclusion: string | null; created_at: string; run_attempt: number; html_url: string }
export interface WorkflowJob { name: string; status: string; conclusion: string | null }
export interface RunArtifact { name: string; expired: boolean }
export interface VerifiedCandidate { name: string; bytes: Buffer; manifestText: string }
export interface ReleaseAsset { name: string; bytes: Buffer }

export declare function assertCommit(value: unknown): string;
export declare function assertVersion(value: unknown): string;
export declare function selectCiRun<T extends WorkflowRun>(runs: T[], commit: string): T;
export declare function verifyJobs(jobs: WorkflowJob[]): number;
export declare function selectArtifact<T extends RunArtifact>(artifacts: T[], kind: "cli" | "desktop", version: string, commit: string): T;
export declare function sha256(bytes: Buffer): string;
export declare function verifyBundle(kind: "cli" | "desktop", bundle: Map<string, Buffer>, expected: { version: string; commit: string; runId: number }): VerifiedCandidate;
export declare function releaseAssets(version: string, cli: VerifiedCandidate, desktop: VerifiedCandidate): ReleaseAsset[];
export declare function releaseNotes(changelog: string, version: string, commit: string, run: Pick<WorkflowRun, "id" | "html_url">, jobCount: number): string;
export declare function createDraft(env?: Record<string, string | undefined>, root?: string): Promise<unknown>;
