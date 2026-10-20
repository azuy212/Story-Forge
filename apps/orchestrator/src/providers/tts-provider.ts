export interface SynthesizeOptions {
  text: string;
  voice?: string;
  speed?: number;
  parameters?: Record<string, unknown>;
  filename?: string;
  runId?: string;
  runLogSink?: import("../utils/run-log.js").RunLogSink | null;
  /**
   * Video profile of the run. Providers use this to skip post-processing
   * (e.g. WPM normalization) that only applies to short-form output.
   */
  videoProfile?: "short" | "long";
  /**
   * Skip the provider's words-per-minute tempo normalization. The story
   * pipeline measures true per-chunk durations and must not have them altered
   * by a Shorts-pipeline pacing target. Default false keeps historical
   * behaviour for every existing caller.
   */
  skipWpmNormalization?: boolean;
}

export interface SynthesizeResult {
  audioUrl: string;
  durationMs: number;
}

export interface TTSProvider {
  synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult>;
  /** Fingerprint provider behavior not represented by SynthesizeOptions. */
  cacheFingerprint?(): string;
}
