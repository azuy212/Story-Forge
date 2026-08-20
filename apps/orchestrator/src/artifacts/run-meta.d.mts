export interface RunMeta {
  threadId: string;
  topic: string;
  pillar?: string;
  projectId?: string;
  createdAt: string;
  threadHistory: string[];
}

export function runMetaPath(runsDir: string, runId: string): string;
export function createOrAppendRunMeta(
  runsDir: string,
  runId: string,
  meta: {
    threadId: string;
    topic: string;
    pillar?: string;
    projectId?: string;
  },
): RunMeta;
