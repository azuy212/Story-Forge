import type {
  TTSProvider,
  SynthesizeOptions,
  SynthesizeResult,
} from "./tts-provider.js";

export class StubTTSProvider implements TTSProvider {
  cacheFingerprint(): string {
    return "stub-tts-v1";
  }

  async synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
    return {
      audioUrl: "https://placeholder.local/narration.wav",
      durationMs: Math.round(opts.text.length * 60),
    };
  }
}
