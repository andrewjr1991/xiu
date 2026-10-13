// Type declarations for ci-artifacts.mjs, used when TypeScript tests import it.

export type CiArtifactKind = "cli" | "desktop";
export type CiCheckOutcome = "success" | "failure" | "cancelled" | "skipped" | "not-run";
type CiEnvironment = Record<string, string | undefined>;

export interface CiVerification {
  scope: string;
  status: "passed" | "failed" | "incomplete";
  checks: Record<string, CiCheckOutcome>;
}

export interface CiArtifactContext {
  kind: CiArtifactKind;
  version: string;
  commit: string;
  worktreeModified: boolean;
  platform: string;
  packageName: string;
  artifactName: string;
  directory: string;
  staging: string;
  /** Always set for the CLI; null for a desktop build outside Windows. */
  candidateName: string | null;
}

export interface CiManifest {
  schemaVersion: 1;
  package: { name: string; version: string };
  source: { commit: string; worktreeModified: boolean; event: string; ref: string | null; pullRequestHeadCommit: string | null };
  build: { createdAt: string; platform: string; architecture: string; node: string; runnerOs: string | null; runId: string | null; runAttempt: string | null; runUrl: string | null };
  candidate: { available: boolean; format: string; published: false; acceptance: "job-checks-passed" | "unaccepted-candidate" | "unavailable" };
  verification: CiVerification;
  files: Array<{ name: string; bytes: number; sha256: string }>;
}

export declare function verificationContext(kind: CiArtifactKind, platform: string, steps: Record<string, { outcome?: string } | undefined>): CiVerification;
export declare function artifactContext(root: string, kind: "cli", env?: CiEnvironment): Promise<CiArtifactContext & { kind: "cli"; candidateName: string }>;
export declare function artifactContext(root: string, kind: CiArtifactKind, env?: CiEnvironment): Promise<CiArtifactContext>;
export declare function prepareCandidate(root: string, kind: CiArtifactKind, env?: CiEnvironment): Promise<string>;
export declare function writeReport(root: string, kind: CiArtifactKind, env?: CiEnvironment): Promise<CiManifest>;
