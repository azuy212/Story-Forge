function read(name: string): string | undefined {
  return process.env[name];
}

function parsePublishAt(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : new Date(parsed).toISOString();
}

/** Parse a positive finite number, falling back when unset or malformed. */
function readPositiveNumber(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Parse a non-negative finite number, falling back when unset or malformed. */
function readNonNegativeNumber(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const config = {
  defaultModel: (): string => read("DEFAULT_MODEL") ?? "openai/gpt-4o-mini",
  openrouterApiKey: (): string => {
    const key = read("OPENROUTER_API_KEY");
    if (!key) {
      throw new Error(
        "OPENROUTER_API_KEY not set in environment. Add to .env file.",
      );
    }
    return key;
  },
  modelForAgent: (agentName: string): string | undefined =>
    read(`MODEL_${agentName.toUpperCase()}`),
  modelForRole: (roleName: string): string | undefined =>
    read(`MODEL_${roleName}`),
  llmFirstTokenTimeoutMs: (): number => {
    const value = Number(read("LLM_FIRST_TOKEN_TIMEOUT_MS") ?? "90000");
    return Number.isFinite(value) && value > 0 ? value : 90000;
  },
  llmStreamInactivityTimeoutMs: (): number => {
    const value = Number(read("LLM_STREAM_INACTIVITY_TIMEOUT_MS") ?? "120000");
    return Number.isFinite(value) && value > 0 ? value : 120000;
  },
  // --- Prompt version ---
  // Every prompt lives at `<agent>/v1.md`; a candidate rollout sits beside it
  // as v2. This selects which one loads, so an A/B is a single env var and a
  // revert never touches the active files. Inert until explicitly set.
  promptVersion: (): string => read("PROMPT_VERSION") || "v1",
  /** The raw PROMPT_VERSION value, distinguishing unset/empty from a pin. */
  promptVersionOverride: (): string | undefined => read("PROMPT_VERSION"),
  // DEBUG_LLM_PAYLOAD=1 dumps the full LLM request payload (messages +
  // options) to debug logs. Off by default: the payload can contain the whole
  // script under review.
  debugLlmPayload: (): boolean => read("DEBUG_LLM_PAYLOAD") === "1",
  isDebug: (): boolean => read("LOG_LEVEL") === "debug",
  logFormat: (): "pretty" | "json" => {
    const value = read("LOG_FORMAT");
    if (value === "pretty" || value === "json") return value;
    return process.stdout.isTTY ? "pretty" : "json";
  },
  imageProviderUrl: (): string =>
    read("IMAGE_PROVIDER_URL") ?? "http://localhost:8020",
  ttsUrl: (): string => read("TTS_URL") ?? "http://localhost:8010",
  transcriberUrl: (): string =>
    read("TRANSCRIBER_URL") ?? "http://localhost:8030",
  useRealProviders: (): boolean => read("USE_REAL_PROVIDERS") === "true",
  enableThumbnail: (): boolean => {
    const v = read("ENABLE_THUMBNAIL");
    if (v !== undefined) return v === "true";
    return read("ENABLE_QA") === "true";
  },
  thumbnailMode: (): "auto" | "full" | "overlay" => {
    const value = read("THUMBNAIL_MODE");
    return value === "full" || value === "overlay" ? value : "auto";
  },
  thumbnailQaEnabled: (): boolean => read("THUMBNAIL_QA") !== "false",
  thumbnailQaModel: (): string | undefined =>
    read("MODEL_THUMBNAILQA") ?? read("MODEL_THUMBNAIL_QA"),
  artifactStoreEnabled: (): boolean =>
    read("ARTIFACT_STORE_ENABLED") === "true",
  artifactStoreDir: (): string => read("ARTIFACT_STORE_DIR") ?? "runs",
  sourceAssetCacheDir: (): string =>
    read("SOURCE_ASSET_CACHE_DIR") ?? "cache/source-assets",
  unsplashAccessKey: (): string => read("UNSPLASH_ACCESS_KEY") ?? "",
  pexelsApiKey: (): string => read("PEXELS_API_KEY") ?? "",
  sourceAssetDeadlineMs: (): number => {
    const value = Number(read("SOURCE_ASSET_DEADLINE_MS") ?? "60000");
    return Number.isFinite(value) && value > 0 ? value : 60000;
  },
  enableScriptQA: (): boolean => {
    const v = read("ENABLE_SCRIPT_QA");
    if (v !== undefined) return v === "true";
    return read("ENABLE_QA") === "true";
  },
  enableResearchQA: (): boolean => {
    const v = read("ENABLE_RESEARCH_QA");
    if (v !== undefined) return v === "true";
    return read("ENABLE_QA") === "true";
  },
  enablePromptQA: (): boolean => {
    const v = read("ENABLE_PROMPT_QA");
    if (v !== undefined) return v === "true";
    return read("ENABLE_QA") === "true";
  },
  enableReleaseQA: (): boolean => {
    const v = read("ENABLE_RELEASE_QA");
    if (v !== undefined) return v === "true";
    return read("ENABLE_QA") === "true";
  },
  // --- Classifier layer (bounded QA decisions, e.g. TypeSafe/Jev) ---
  // Master switch, default off: existing LLM QA behavior is untouched until
  // CLASSIFIER_PROVIDER=typesafe is set. Auth reuses OPENROUTER_API_KEY and
  // routes through OpenRouter's System One endpoint; only the model and the
  // on/off switch are user-facing config.
  classifierProvider: (): "off" | "typesafe" => {
    const value = read("CLASSIFIER_PROVIDER");
    return value === "typesafe" ? "typesafe" : "off";
  },
  typesafeApiKey: (): string | undefined =>
    read("TYPESAFE_API_KEY") || read("OPENROUTER_API_KEY") || undefined,
  // OpenRouter hosts TypeSafe's System One API; the SDK appends /v1/systemone.
  typesafeBaseUrl: (): string =>
    read("TYPESAFE_BASE_URL") || "https://openrouter.ai/api",
  typesafeDefaultModel: (): string =>
    read("TYPESAFE_DEFAULT_MODEL") || "jev-latest",
  // Per-gate activation. Effective only when classifierProvider() !== "off";
  // defaults to enabled so a single master switch opts gates in together.
  classifierEnabledFor: (
    gate: "promptqa" | "researchqa" | "releasereview" | "scriptqa",
  ): boolean => {
    if (config.classifierProvider() === "off") return false;
    const value = read(`CLASSIFIER_${gate.toUpperCase()}`);
    return value !== "false";
  },
  // Per-gate confidence floor (0–1) for a classifier verdict to be trusted
  // without abstaining to the LLM path. Defaults ship conservative; tune per
  // gate from qa-eval replay results, never globally.
  classifierConfidenceMin: (
    gate: "promptqa" | "researchqa" | "releasereview" | "scriptqa",
  ): number => {
    const value = Number(
      read(`CLASSIFIER_${gate.toUpperCase()}_CONFIDENCE_MIN`),
    );
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.85;
  },
  supportsVideoAssets: (): boolean => read("ENABLE_VIDEO_ASSETS") === "true",
  narrativeHoldSeconds: (): number => {
    const value = Number(read("NARRATIVE_HOLD_SECONDS") ?? "0.5");
    return Number.isFinite(value) && value >= 0 ? value : 0.5;
  },
  videoProfile: (): "short" | "long" | undefined => {
    const value = read("VIDEO_PROFILE");
    return value === "short" || value === "long" ? value : undefined;
  },
  targetDurationSec: (): number | undefined => {
    const value = read("TARGET_DURATION_SEC");
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  },
  durationToleranceSec: (): number | undefined => {
    const value = read("DURATION_TOLERANCE_SEC");
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  },
  // Long-form video pacing target (used by the long video profile to plan
  // narration word counts). Distinct from `narrationTargetWpm`, which is
  // the TTS engine speed for the combined short-form pipeline.
  wordsPerMinute: (): number | undefined => {
    const value = read("WORDS_PER_MINUTE");
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  },
  narrationTargetWpm: (): number | undefined => {
    const value = read("NARRATION_TARGET_WPM");
    if (!value) return undefined;
    const wpm = Number(value);
    return Number.isFinite(wpm) && wpm > 0 ? wpm : undefined;
  },
  // --- Narration generation mode ---
  narrationGenerationMode: (): "complete" | "scene" => {
    const value = read("NARRATION_GENERATION_MODE");
    if (value === "scene" || value === "complete") return value;
    return config.ttsProviderType() === "openrouter" ? "complete" : "scene";
  },
  // --- OpenRouter TTS provider ---
  ttsProviderType: (): "chatterbox" | "openrouter" => {
    const value = read("TTS_PROVIDER");
    return value === "openrouter" ? "openrouter" : "chatterbox";
  },
  openRouterTTSModel: (): string =>
    read("OPENROUTER_TTS_MODEL") ?? "fish-audio/s2.1-pro-free",
  openRouterTTSVoice: (): string | undefined =>
    read("OPENROUTER_TTS_VOICE") || undefined,
  openRouterTTSResponseFormat: (): string =>
    read("OPENROUTER_TTS_RESPONSE_FORMAT") ?? "mp3",
  openRouterTTSTimeoutMs: (): number => {
    const value = Number(read("OPENROUTER_TTS_TIMEOUT_MS") ?? "300000");
    return Number.isFinite(value) && value > 0 ? value : 300_000;
  },
  // --- YouTube publishing ---
  // Real uploads require a dedicated opt-in; USE_REAL_PROVIDERS alone must not
  // start publishing to the internet while the pipeline is being validated.
  youtubePublishingEnabled: (): boolean =>
    read("YOUTUBE_PUBLISHING_ENABLED") === "true",
  youtubeClientId: (): string => read("YOUTUBE_CLIENT_ID") ?? "",
  youtubeClientSecret: (): string => read("YOUTUBE_CLIENT_SECRET") ?? "",
  youtubeRefreshToken: (): string => read("YOUTUBE_REFRESH_TOKEN") ?? "",
  // Optional; used later as a safety verification via channels.list(mine=true),
  // not passed into upload requests.
  youtubeChannelId: (): string => read("YOUTUBE_CHANNEL_ID") ?? "",
  youtubeCategoryId: (): string | undefined => {
    const value = read("YOUTUBE_CATEGORY_ID");
    return value && value.length > 0 ? value : undefined;
  },
  youtubeLanguage: (): string => read("YOUTUBE_LANGUAGE") ?? "en",
  youtubeMadeForKids: (): boolean => read("YOUTUBE_MADE_FOR_KIDS") === "true",
  youtubeContainsSyntheticMedia: (): boolean =>
    read("YOUTUBE_SYNTHETIC_MEDIA") !== "false",
  youtubePrivacyStatus: (): "private" | "unlisted" | "public" => {
    const value = read("YOUTUBE_PRIVACY_STATUS");
    if (value === "unlisted" || value === "public") return value;
    return "private";
  },
  youtubePublishAt: (state?: {
    project?: { youtubePublishAt?: string };
  }): string | undefined => {
    const value =
      state?.project?.youtubePublishAt ?? read("YOUTUBE_PUBLISH_AT");
    if (!value) return undefined;
    return parsePublishAt(value);
  },
  youtubePlaylistIds: (): string[] => {
    const value = read("YOUTUBE_PLAYLIST_IDS");
    if (!value) return [];
    return value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  },
  // --- Google Sheets sync ---
  // Sync is opt-in: set the spreadsheet ID to enable writing publish records
  // back to a sheet. Auth reuses the YouTube OAuth credentials and scopes.
  googleSheetsSpreadsheetId: (): string | undefined => {
    const value = read("GOOGLE_SHEETS_SPREADSHEET_ID");
    return value && value.length > 0 ? value : undefined;
  },
  googleSheetsSheetName: (): string =>
    read("GOOGLE_SHEETS_SHEET_NAME") || "Sheet1",
  // Dedicated sheet for seed-run launches so they don't pollute the run-next
  // backlog sheets. Override via GOOGLE_SHEETS_SHEET_NAME_SEED.
  googleSheetsSheetNameSeed: (): string =>
    read("GOOGLE_SHEETS_SHEET_NAME_SEED") || "Seed Runs",
  googleSheetsSheetNameForProfile: (profile?: string): string => {
    if (profile === "long") {
      return read("GOOGLE_SHEETS_SHEET_NAME_LONG") || "Long Videos";
    }
    return read("GOOGLE_SHEETS_SHEET_NAME") || "Sheet1";
  },
  // Resolves the Google Sheets tab for a run. Seed runs always land on the
  // dedicated seed sheet regardless of profile; everything else uses the
  // profile-based backlog sheet.
  googleSheetsSheetNameForSource: (
    source?: string,
    profile?: string,
  ): string => {
    if (source === "seed")
      return read("GOOGLE_SHEETS_SHEET_NAME_SEED") || "Seed Runs";
    if (profile === "long")
      return read("GOOGLE_SHEETS_SHEET_NAME_LONG") || "Long Videos";
    return read("GOOGLE_SHEETS_SHEET_NAME") || "Sheet1";
  },
  // --- Subtitle appearance (word-level karaoke rendering) ---
  // Subtitle styling is controlled here so it is configurable in one place
  // rather than hardcoded across the pipeline. Colors are ASS &HAABBGGRR.
  subtitleFontSize: (): number => {
    const value = Number(read("SUBTITLE_FONT_SIZE") ?? "48");
    return Number.isFinite(value) && value > 0 ? value : 48;
  },
  subtitleFontName: (): string => read("SUBTITLE_FONT_NAME") ?? "Noto Sans",
  // Bundled font file libass/fontconfig is pointed at via `fontsdir` so the
  // render does not silently substitute a system font of different metrics.
  subtitleFontPath: (): string =>
    read("SUBTITLE_FONT_PATH") ?? "assets/branding/NotoSans-Bold.ttf",
  subtitleMarginV: (): number => {
    const value = Number(read("SUBTITLE_MARGIN_V") ?? "70");
    return Number.isFinite(value) && value >= 0 ? value : 70;
  },
  subtitlePrimaryColor: (): string =>
    read("SUBTITLE_PRIMARY_COLOR") ?? "&H00FFFFFF",
  subtitleAccentColor: (): string =>
    read("SUBTITLE_ACCENT_COLOR") ?? "&H0000E0FF",
  subtitleOutline: (): number => {
    const value = Number(read("SUBTITLE_OUTLINE") ?? "2");
    return Number.isFinite(value) && value >= 0 ? value : 2;
  },
  // --- Story-Forge stickman storytelling pipeline -------------------------
  // A separate production mode behind its own entry point
  // (scripts/story-video.mjs). Every key is STORY_-prefixed so it can never
  // collide with, or be inherited from, the Shorts pipeline's variables —
  // e.g. NARRATION_GENERATION_MODE is deliberately NOT consulted here.
  storyModel: (): string | undefined => read("STORY_LLM_MODEL") || undefined,
  storyTargetDurationSec: (): number =>
    readPositiveNumber("STORY_TARGET_DURATION_SEC", 150),
  storyLanguage: (): string => read("STORY_LANGUAGE")?.trim() || "en",
  storyTone: (): string | undefined => read("STORY_TONE") || undefined,
  storyStyle: (): string => read("STORY_STYLE")?.trim() || "stickman-history",
  storyTtsWpm: (): number => readPositiveNumber("STORY_TTS_WPM", 150),
  // Gemini web automation is captcha/session sensitive, so the story pipeline
  // defaults to one in-flight image request; raise it deliberately.
  storyImageConcurrency: (): number =>
    Math.max(1, Math.floor(readPositiveNumber("STORY_IMAGE_CONCURRENCY", 1))),
  storySceneMinSec: (): number => readPositiveNumber("STORY_SCENE_MIN_SEC", 3),
  storySceneTargetMinSec: (): number =>
    readPositiveNumber("STORY_SCENE_TARGET_MIN_SEC", 6),
  storySceneTargetMaxSec: (): number =>
    readPositiveNumber("STORY_SCENE_TARGET_MAX_SEC", 12),
  storySceneSoftMaxSec: (): number =>
    readPositiveNumber("STORY_SCENE_SOFT_MAX_SEC", 15),
  storyResolution: (): string =>
    read("STORY_RESOLUTION")?.trim() || "1920x1080",
  storyFps: (): number =>
    Math.max(1, Math.floor(readPositiveNumber("STORY_FPS", 30))),
  storySceneGapMs: (): number =>
    Math.max(0, Math.floor(readNonNegativeNumber("STORY_SCENE_GAP_MS", 200))),
  // Provider output is variable; these are the acceptance gate for a single
  // scene still. DP4: a 1000x540 floor is reachable when the provider returns
  // ~1024x559, and 1080p is reached by a Lanczos cover-crop upscale at render.
  storyImageMinWidth: (): number =>
    Math.floor(readPositiveNumber("STORY_IMAGE_MIN_WIDTH", 1000)),
  storyImageMinHeight: (): number =>
    Math.floor(readPositiveNumber("STORY_IMAGE_MIN_HEIGHT", 540)),
  storyImageMinAspect: (): number =>
    readPositiveNumber("STORY_IMAGE_MIN_ASPECT", 1.6),
  storyImageMaxAspect: (): number =>
    readPositiveNumber("STORY_IMAGE_MAX_ASPECT", 1.9),
  storyTtsMaxChars: (): number =>
    Math.floor(readPositiveNumber("STORY_TTS_MAX_CHARS", 450)),
  // A fixed voice reference for every chunk: local per-chunk synthesis can
  // otherwise drift in voice between chunks.
  storyVoice: (): string => read("STORY_VOICE")?.trim() || "narrator",
  // Optional: generate one character sheet and pass it as a reference image to
  // every scene call (helps character consistency more than prompt text when
  // the image provider accepts references). Off by default.
  storyReferenceSheet: (): boolean => read("STORY_REFERENCE_SHEET") === "true",
  storySubtitleMaxCharsPerLine: (): number =>
    Math.floor(readPositiveNumber("STORY_SUBTITLE_MAX_CHARS_PER_LINE", 42)),
  storySubtitleMinDurationMs: (): number =>
    readPositiveNumber("STORY_SUBTITLE_MIN_DURATION_MS", 800),
  storyCrf: (): number => Math.floor(readPositiveNumber("STORY_CRF", 19)),
  storyPreset: (): string => read("STORY_PRESET")?.trim() || "medium",
  storyJobsDir: (): string => read("STORY_JOBS_DIR")?.trim() || "jobs",
  storyPromptsPath: (): string | undefined =>
    read("STORY_PROMPTS_PATH")?.trim() || undefined,
  storyReviewStoryTimeoutMs: (): number =>
    readPositiveNumber("STORY_REVIEW_STORY_TIMEOUT_MS", 0),
  // --- Run diagnostic log file ---
  runLogFileEnabled: (): boolean => read("ORCHESTRATOR_LOG_FILE") !== "false",
  runLogMaxLineBytes: (): number => {
    const value = Number(read("ORCHESTRATOR_LOG_MAX_LINE_BYTES") ?? "8388608");
    return Number.isFinite(value) && value >= 1024
      ? Math.floor(value)
      : 8388608;
  },
  runLogIncludeMessages: (): boolean =>
    read("ORCHESTRATOR_LOG_MESSAGES") !== "false",
};
