import type { TTSProvider, SynthesizeOptions, SynthesizeResult } from "./tts-provider.js";

export class StubTTSProvider implements TTSProvider {
  async synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
    return {
      audioUrl: "https://placeholder.local/narration.wav",
      durationMs: Math.round(opts.text.length * 60),
    };
  }
}
