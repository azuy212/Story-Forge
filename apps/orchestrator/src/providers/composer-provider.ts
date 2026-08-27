export interface ComposeSceneInput {
  sceneId: number;
  assetUrl: string;
  startSecond: number;
  endSecond: number;
  durationSeconds: number;
}

export interface VideoSize {
  width: number;
  height: number;
}

export interface ComposeOptions {
  scenes: ComposeSceneInput[];
  narrationUrl: string;
  srt: string;
  ass?: string;
  totalDurationSeconds: number;
  narrativeHoldSeconds?: number;
  branding: {
    channel?: string;
    logo?: string;
    enabled?: boolean;
    outroAsset?: string;
    outroLongAsset?: string;
    ctaEnabled?: boolean;
    outroCta?: string;
    outroContainsCta?: boolean;
  };
  video?: VideoSize;
  runId?: string;
}

export interface ComposeResult {
  videoUrl: string;
  durationMs: number;
  resolution: string;
  timeline?: {
    narrativeDurationMs: number;
    narrativeHoldMs: number;
    outroDurationMs: number;
    durationMs: number;
    outroTransitionMs: number;
  };
}

export interface ComposerProvider {
  compose(opts: ComposeOptions): Promise<ComposeResult>;
  configFingerprint?(): string;
}
