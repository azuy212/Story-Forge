export interface ComposeSceneInput {
  sceneId: number;
  assetUrl: string;
  startSecond: number;
  endSecond: number;
  durationSeconds: number;
}

export interface ComposeOptions {
  scenes: ComposeSceneInput[];
  narrationUrl: string;
  srt: string;
  totalDurationSeconds: number;
  branding: {
    channel?: string;
    logo?: string;
  };
  runId?: string;
}

export interface ComposeResult {
  videoUrl: string;
  durationMs: number;
  resolution: string;
}

export interface ComposerProvider {
  compose(opts: ComposeOptions): Promise<ComposeResult>;
  configFingerprint?(): string;
}
