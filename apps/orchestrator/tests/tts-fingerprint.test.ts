import { describe, expect, it } from "@jest/globals";
import { canonicalTTSFingerprint } from "../src/providers/tts-fingerprint.js";
import type { TTSProvider } from "../src/providers/tts-provider.js";

const provider: TTSProvider = {
  synthesize: async () => ({ audioUrl: "audio.wav", durationMs: 1 }),
  cacheFingerprint: () => "provider-v1",
};

describe("canonicalTTSFingerprint", () => {
  it("is stable across parameter property ordering and undefined fields", () => {
    const first = canonicalTTSFingerprint(
      {
        text: "Hello",
        voice: "voice-a",
        speed: 1,
        filename: "scene-001.wav",
        runId: "run-a",
        parameters: { temperature: 0.5, seed: undefined },
      },
      provider,
    );
    const second = canonicalTTSFingerprint(
      {
        text: "Hello",
        voice: "voice-a",
        speed: 1,
        filename: "scene-999.wav",
        runId: "run-b",
        parameters: { seed: undefined, temperature: 0.5 },
      },
      provider,
    );

    expect(first).toBe(second);
  });

  it("changes when output-affecting options change", () => {
    const base = canonicalTTSFingerprint(
      { text: "Hello", voice: "voice-a", parameters: { seed: 1 } },
      provider,
    );
    const changed = canonicalTTSFingerprint(
      { text: "Hello", voice: "voice-a", parameters: { seed: 2 } },
      provider,
    );

    expect(changed).not.toBe(base);
  });
});
