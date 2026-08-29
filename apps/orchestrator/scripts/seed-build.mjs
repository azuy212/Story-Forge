// Shared seed normalization used by both `seed-run` (to build the initial
// graph input) and `resume` (to re-build the seed object for re-injection so
// the artifact cache input hashes stay stable across resumes).
//
// This function is the single source of truth for turning a raw seed JSON
// (or a persisted run.json.seed) into the canonical `{ pillar, topic,
// videoProfile, seed }` shape that the graph consumes. Keep the
// normalization in one place: any change here affects both fresh runs and
// resumes, and is what makes the artifact cache replay work after a TTS
// (or any other) failure.
import { readFileSync, existsSync } from "node:fs";

/**
 * Validate + normalize a raw seed object into graph-input channels.
 * Fail-closed: an incomplete seed is rejected here rather than silently
 * falling back to the full LLM flow.
 *
 * @param {object} raw  the parsed seed JSON (research + content + optional
 *                      pillar/topic/videoProfile at the top level)
 * @param {{ pillar?: string, topic?: string, profile?: "short"|"long" }} overrides
 * @returns {{ pillar: string, topic: string, videoProfile: "short"|"long", seed: { research: object, content: object } }}
 */
export function buildSeed(raw, overrides = {}) {
  const pillar = overrides.pillar || raw.pillar;
  const topic = overrides.topic || raw.topic;
  if (!pillar) throw new Error("seed: missing pillar (in file or --pillar)");
  if (!topic) throw new Error("seed: missing topic (in file or --topic)");

  const research = raw.research;
  if (!research || typeof research !== "object")
    throw new Error("seed: missing 'research' object");
  if (typeof research.summary !== "string" || !research.summary.trim())
    throw new Error("seed: research.summary must be a non-empty string");
  if (!Array.isArray(research.facts) || research.facts.length === 0)
    throw new Error("seed: research.facts must be a non-empty array");
  for (const [i, f] of research.facts.entries()) {
    if (!f || typeof f.id !== "string" || !f.id.trim())
      throw new Error(`seed: research.facts[${i}].id is required`);
    if (typeof f.fact !== "string" || !f.fact.trim())
      throw new Error(`seed: research.facts[${i}].fact is required`);
    if (typeof f.confidence !== "string" || !f.confidence.trim())
      throw new Error(
        `seed: research.facts[${i}].confidence is required`,
      );
  }

  const content = raw.content || {};
  const script = content.script;
  const narration = content.narration || script;
  if (typeof script !== "string" || !script.trim())
    throw new Error("seed: content.script is required (non-empty)");

  // If a seeded ending is present, guarantee the narration ends with its
  // exact text so VisualDirector's suffix check passes deterministically.
  const narrationTrimmed = narration.trim();
  const endingText = content.ending?.narration?.trim();
  const narrationWithEnding =
    endingText && !narrationTrimmed.endsWith(endingText)
      ? `${narrationTrimmed} ${endingText}`.trim()
      : narrationTrimmed;

  const seed = {
    research: {
      summary: research.summary,
      facts: research.facts.map((f) => ({
        id: f.id,
        fact: f.fact,
        confidence: f.confidence,
        ...(f.classification ? { classification: f.classification } : {}),
      })),
    },
    content: {
      script: script.trim(),
      narration: narrationWithEnding,
      ...(content.title ? { title: content.title } : {}),
      ...(content.hook ? { hook: content.hook } : {}),
      ...(content.ending ? { ending: content.ending } : {}),
    },
  };

  const videoProfile = overrides.profile || raw.videoProfile || "short";
  if (videoProfile !== "short" && videoProfile !== "long")
    throw new Error("seed: videoProfile must be 'short' or 'long'");

  return { pillar, topic, videoProfile, seed };
}

/**
 * Load a seed JSON file from disk and return the canonical seed payload.
 * Used by `resume --seed <path>` for legacy runs that predate the
 * persisted-seed feature, so the re-injected object is byte-identical to
 * the original seed-run injection (artifact cache input hash stable).
 *
 * @param {string} seedPath
 * @param {{ pillar?: string, topic?: string, profile?: "short"|"long" }} overrides
 * @returns {{ research: object, content: object }}
 */
export function loadSeedFromFile(seedPath, overrides = {}) {
  if (!existsSync(seedPath)) {
    throw new Error(`--seed file not found: ${seedPath}`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(seedPath, "utf-8"));
  } catch (e) {
    throw new Error(`--seed: failed to parse JSON: ${e.message}`);
  }
  return buildSeed(raw, overrides).seed;
}
