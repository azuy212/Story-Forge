import type { ComposerProvider, ComposeOptions, ComposeResult } from "./composer-provider.js";

export class StubComposerProvider implements ComposerProvider {
  async compose(opts: ComposeOptions): Promise<ComposeResult> {
    return {
      videoUrl: "https://placeholder.local/final.mp4",
      durationMs: opts.totalDurationSeconds * 1000,
      resolution: "1080x1920",
    };
  }
}
