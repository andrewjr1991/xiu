// Type declarations for registry-artifact.mjs, used when TypeScript tests import it.

export interface ArtifactMetadata {
  packageName: string;
  version: string;
  integrity: string;
  tarball: string;
}

/** The subset of `fetch` that fetchArtifactMetadata uses. */
export type RegistryFetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export declare function fetchArtifactMetadata(packageName: string, version: string, fetchImpl?: RegistryFetch): Promise<ArtifactMetadata>;
