export type SheetStatus =
  | "planned"
  | "scheduled"
  | "published"
  | "draft"
  | "failed"
  | string;

export type SheetRecord = {
  videoId: string;
  category: string;
  topic: string;
  title: string;
  status: SheetStatus;
  youtubeId: string;
  youtubeUrl: string;
  privacy: string;
  scheduledAt: string;
  scheduledAtLocal: string;
  publishedAt: string;
  publishedAtLocal: string;
  duration: string;
  llm: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    reasoningTokens: number | null;
    cachedTokens: number | null;
    costUsd: number | null;
  };
};

export type SheetProfile = "short" | "long";

export type SheetPayload = {
  sheetName: string;
  records: SheetRecord[];
  error?: string;
};

export type SheetSnapshot = {
  fetchedAt: string;
  short?: SheetPayload;
  long?: SheetPayload;
  stale?: boolean;
  staleError?: string | null;
  error?: string;
  message?: string;
};

export type NextInLine = {
  profile: SheetProfile;
  topic: string;
  category: string;
  videoId: string;
  scheduledAt: string;
  scheduledAtLocal: string;
  rowExists: boolean;
};