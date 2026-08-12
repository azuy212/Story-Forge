import { stableStringify } from "../artifacts/hash.js";
import type { SynthesizeOptions, TTSProvider } from "./tts-provider.js";

const CACHE_VERSION = 1;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

/** Builds canonical TTS identity without output-path or lifecycle fields. */
export function canonicalTTSFingerprint(
  opts: SynthesizeOptions,
  provider: TTSProvider,
): string {
  return stableStringify({
    cacheVersion: CACHE_VERSION,
    text: opts.text,
    voice: opts.voice ?? null,
    speed: opts.speed ?? null,
    parameters: canonicalValue(opts.parameters ?? {}),
    provider: provider.constructor.name,
    providerFingerprint: provider.cacheFingerprint?.() ?? null,
  });
}
