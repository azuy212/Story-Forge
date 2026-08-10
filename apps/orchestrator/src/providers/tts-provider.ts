export interface SynthesizeOptions {
  text: string;
  voice?: string;
  speed?: number;
  filename?: string;
  runId?: string;
}

export interface SynthesizeResult {
  audioUrl: string;
  durationMs: number;
}

export interface TTSProvider {
  synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult>;
}
