import type {
  ArtifactReference,
  ArtifactRecord,
  ArtifactType,
  CacheKey,
  Manifest,
} from "./types.js";

export type {
  ArtifactReference,
  ArtifactRecord,
  ArtifactType,
  CacheKey,
  Manifest,
};

export interface ArtifactStore {
  save<T>(
    runId: string,
    type: ArtifactType,
    value: T,
    meta: Record<string, unknown>,
    status?: "pending" | "complete" | "failed" | "invalid" | "superseded",
  ): Promise<ArtifactReference>;

  load<T>(ref: ArtifactReference): Promise<ArtifactRecord<T> | null>;

  exists(runId: string, type: ArtifactType): Promise<boolean>;

  latest<T>(
    runId: string,
    type: ArtifactType,
  ): Promise<ArtifactRecord<T> | null>;

  findCompleteByInputHash<T>(
    runId: string,
    type: ArtifactType,
    inputHash: string,
  ): Promise<{ record: ArtifactRecord<T>; ref: ArtifactReference } | null>;

  listVersions(
    runId: string,
    type: ArtifactType,
  ): Promise<
    Array<{
      version: number;
      status: string;
      createdAt: string;
      artifactId: string;
      inputHash: string;
    }>
  >;

  getManifest(runId: string): Promise<Manifest | null>;

  markStatus(
    runId: string,
    type: ArtifactType,
    version: number,
    status: "pending" | "complete" | "failed" | "invalid" | "superseded",
  ): Promise<void>;

  recordRef(runId: string, ref: ArtifactReference): Promise<void>;

  getRunId(
    config: Record<string, unknown>,
    state?: { execution?: { runId?: string }; project?: { topic?: string } },
  ): string | null;
}
