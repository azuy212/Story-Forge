import { config as configUtils } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { promptFileExists } from "../utils/load-prompt.js";

/**
 * Prompt file locations, resolved against the active prompt version.
 *
 * Every prompt ships as `<agent>/v1.md`. A candidate rollout is dropped in
 * alongside it as `<agent>/v2.md`, and `PROMPT_VERSION` selects which one the
 * pipeline loads — dropping a v2 file in does NOT switch versions by itself.
 * The default is v1, so the switch is inert until an A/B sets it explicitly,
 * and reverting is a single env change.
 */
export function promptPathsFor(version: string): Record<string, string> {
  const promptPath = (agent: string): string => `${agent}/${version}.md`;
  const paths = {
    ResearchAgent: promptPath("research-agent"),
    ResearchQA: promptPath("research-qa"),
    ScriptPlanner: promptPath("script-planner"),
    ScriptWriter: promptPath("script-writer"),
    ScriptQA: promptPath("script-qa"),
    VisualDirector: promptPath("visual-director"),
    ImagePromptGenerator: promptPath("image-prompt-generator"),
    PromptQA: promptPath("prompt-qa"),
    ImagePromptRepair: promptPath("image-prompt-repair"),
    ReleaseReview: promptPath("release-review"),
    MetadataGenerator: promptPath("metadata-generator"),
    ThumbnailGenerator: promptPath("thumbnail-generator"),
    ThumbnailQA: promptPath("thumbnail-qa"),
  };
  return paths;
}

/**
 * VisualDirector's unit-based prompt ships as `visual-director/v2.md`; the
 * narration-unit pipeline depends on it, so no prompt below v2 is available
 * (the older files were removed). A global `PROMPT_VERSION` pin of v2 or
 * higher is still honored — for every agent — but a pin below v2 is ignored
 * for VisualDirector with a warning instead of pointing at a missing file.
 */
const VISUAL_DIRECTOR_MIN_VERSION = 2;
const VISUAL_DIRECTOR_DEFAULT = "visual-director/v2.md";

function parseNumericVersion(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = /^v(\d+)$/i.exec(raw.trim());
  return match ? Number(match[1]) : null;
}

export interface VisualDirectorPromptResolverDeps {
  /** The pinned override, or undefined/"" for the unit-based default. */
  override: string | undefined;
  /** Whether a prompt file exists under the loader's prompts root. */
  fileExists: (agentPath: string) => boolean;
  warn: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * The unit pipeline depends on `visual-director/v2.md`; never resolve anything
 * (default, ignored pin, or missing pin) to a file that does not exist —
 * the run would only fail later with a load error.
 */
function assertUnitPromptShips(
  fileExists: VisualDirectorPromptResolverDeps["fileExists"],
): void {
  if (fileExists(VISUAL_DIRECTOR_DEFAULT)) return;
  throw new Error(
    `${VISUAL_DIRECTOR_DEFAULT} is missing from prompts root — the narration-unit pipeline requires it. Reinstall the package so prompts/ ship.`,
  );
}

/**
 * Resolve VisualDirector's prompt path from the `PROMPT_VERSION` pin:
 * the unit-based `visual-director/v2.md` is the floor, a pin below it is
 * ignored with a warning, and a pin whose file is missing falls back to v2 —
 * throwing instead when even the fallback is missing.
 */
export function resolveVisualDirectorPromptPath(
  deps: VisualDirectorPromptResolverDeps,
): string {
  const override = deps.override;
  if (!override || override.trim() === "") {
    assertUnitPromptShips(deps.fileExists);
    return VISUAL_DIRECTOR_DEFAULT;
  }
  const pinned = parseNumericVersion(override);
  if (
    pinned !== null &&
    pinned < VISUAL_DIRECTOR_MIN_VERSION &&
    deps.fileExists(VISUAL_DIRECTOR_DEFAULT)
  ) {
    deps.warn(
      "PROMPT_VERSION pin below VisualDirector's minimum ignored — using the unit-based prompt",
      { pinned: override, minimum: `v${VISUAL_DIRECTOR_MIN_VERSION}` },
    );
    return VISUAL_DIRECTOR_DEFAULT;
  }
  const candidate = promptPathsFor(override.trim()).VisualDirector;
  if (deps.fileExists(candidate)) return candidate;
  assertUnitPromptShips(deps.fileExists);
  deps.warn(
    "PROMPT_VERSION pin has no VisualDirector prompt file — using the unit-based prompt",
    { pinned: override, missing: candidate, using: VISUAL_DIRECTOR_DEFAULT },
  );
  return VISUAL_DIRECTOR_DEFAULT;
}

function visualDirectorPromptPath(): string {
  return resolveVisualDirectorPromptPath({
    override: configUtils.promptVersionOverride(),
    fileExists: promptFileExists,
    warn: logger.warn.bind(logger),
  });
}

export const PromptPaths = {
  ...promptPathsFor(configUtils.promptVersion() || "v1"),
  VisualDirector: visualDirectorPromptPath(),
} as {
  [K in keyof ReturnType<typeof promptPathsFor>]: string;
};

export type PromptPath = (typeof PromptPaths)[keyof typeof PromptPaths];
