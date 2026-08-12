export interface SynthesizeOptions {
  text: string;
  voice?: string;
  speed?: number;
  parameters?: Record<string, unknown>;
  filename?: string;
  runId?: string;
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
