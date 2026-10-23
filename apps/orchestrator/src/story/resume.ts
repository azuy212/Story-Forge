import { PipelineError } from "../utils/errors.js";
import type { StoryCliOverrides } from "./config.js";
import type { ResolvedStoryConfig } from "./types.js";

/**
 * Resume semantics: a resumed job replays the configuration stored in its
 * manifest.
 *
 * Why this exists: stage fingerprints are hashes of the config fields that
 * shape each stage. Re-resolving the config from the environment on every run
 * meant that a forgotten flag (or a changed `.env` value) silently produced new
 * fingerprints, and a "resume" re-ran paid LLM stages. That is exactly what
 * happened once: `story --from S6_audio` without `--duration 45` re-authored a
 * 45 s job at 150 s.
 *
 * The rule now: stored values win; an explicitly passed flag that disagrees
 * with them is an error, not an invalidation. Starting a genuinely different
 * run means a different `--job-id`.
 */

/**
 * Config fields each CLI override controls. `duration` and `resolution` are the
 * two flags whose names do not match the field they set.
 */
const OVERRIDE_FIELDS = {
  topic: ["topic"],
  duration: ["targetDurationSec"],
  language: ["language"],
  tone: ["tone"],
  style: ["style"],
  jobId: ["jobId"],
  outputDir: ["outputDir"],
  wpm: ["wpm"],
  fps: ["fps"],
  resolution: ["width", "height"],
  imageConcurrency: ["imageConcurrency"],
  sceneGapMs: ["sceneGapMs"],
} as const satisfies Record<
  keyof StoryCliOverrides,
  readonly (keyof ResolvedStoryConfig)[]
>;

/**
 * Overrides that change where or how the work runs, never what a stage
 * produces. They are allowed to change on resume:
 * - `jobId` / `outputDir` are how the manifest was found in the first place;
 * - `imageConcurrency` does invalidate S5's stage record, but S5 reuses every
 *   still by prompt hash, so it costs no paid call.
 */
const NON_CONTENT_OVERRIDES: ReadonlySet<keyof StoryCliOverrides> = new Set([
  "jobId",
  "outputDir",
  "imageConcurrency",
]);

const FLAG_LABELS: Partial<Record<keyof StoryCliOverrides, string>> = {
  topic: "topic",
  jobId: "--job-id",
  outputDir: "--out-dir",
  duration: "--duration",
  imageConcurrency: "--image-concurrency",
  sceneGapMs: "--scene-gap-ms",
};

function flagLabel(key: keyof StoryCliOverrides): string {
  const explicit = FLAG_LABELS[key];
  if (explicit) return explicit;
  return `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "unset";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

export interface ResumeConfigInput {
  /** The manifest's stored config; partial because manifests predate fields. */
  stored: Partial<ResolvedStoryConfig> | undefined;
  /** What this invocation resolved from flags, environment and defaults. */
  requested: ResolvedStoryConfig;
  /** The raw CLI overrides this invocation passed (not env-derived). */
  overrides: StoryCliOverrides;
}

/**
 * Merge the stored configuration over the requested one and refuse explicit
 * flags that would change it.
 *
 * Keys the stored config does not have (a manifest written before the field
 * existed) fall back to the requested value, so adding a config field never
 * makes old jobs unresumable.
 */
export function reconcileResumeConfig({
  stored,
  requested,
  overrides,
}: ResumeConfigInput): ResolvedStoryConfig {
  const effective: ResolvedStoryConfig = { ...requested };
  if (stored) {
    for (const key of Object.keys(stored) as (keyof ResolvedStoryConfig)[]) {
      if (stored[key] !== undefined) {
        (effective as unknown as Record<string, unknown>)[key] = stored[key];
      }
    }
  }

  // Location keys follow the caller: they are how this job was located, and a
  // moved job directory must stay resumable.
  effective.jobId = requested.jobId;
  effective.outputDir = requested.outputDir;

  // Execution-only overrides are allowed to change, so adopt the requested
  // value rather than the stored one.
  for (const key of NON_CONTENT_OVERRIDES) {
    if (overrides[key] === undefined) continue;
    for (const field of OVERRIDE_FIELDS[key]) {
      (effective as unknown as Record<string, unknown>)[field] =
        requested[field];
    }
  }

  const conflicts: string[] = [];
  for (const key of Object.keys(
    OVERRIDE_FIELDS,
  ) as (keyof StoryCliOverrides)[]) {
    if (overrides[key] === undefined) continue;
    if (NON_CONTENT_OVERRIDES.has(key)) continue;
    for (const field of OVERRIDE_FIELDS[key]) {
      const requestedValue = requested[field];
      const effectiveValue = effective[field];
      if (requestedValue !== effectiveValue) {
        conflicts.push(
          `${flagLabel(key)} (manifest: ${formatValue(effectiveValue)}, requested: ${formatValue(requestedValue)})`,
        );
      }
    }
  }

  if (conflicts.length > 0) {
    throw new PipelineError(
      `Refusing to resume job ${effective.jobId || "(unknown)"} with changed flags: ${conflicts.join("; ")}. ` +
        "A resume replays the configuration stored in the manifest so stage fingerprints, " +
        "and therefore the work already paid for, stay valid. " +
        "Rerun with the stored value, or start a different run with a new --job-id.",
      "STORY_CONFIG_CONFLICT",
    );
  }

  return effective;
}
