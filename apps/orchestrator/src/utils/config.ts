function read(name: string): string | undefined {
  return process.env[name];
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
  isDebug: (): boolean => read("NODE_ENV") !== "production",
  imageProviderUrl: (): string =>
    read("IMAGE_PROVIDER_URL") ?? "http://localhost:8020",
  ttsUrl: (): string => read("TTS_URL") ?? "http://localhost:8010",
  transcriberUrl: (): string =>
    read("TRANSCRIBER_URL") ?? "http://localhost:8030",
  ffmpegPath: (): string | undefined => read("FFMPEG_PATH"),
  ffprobePath: (): string | undefined => read("FFPROBE_PATH"),
  useRealProviders: (): boolean => read("USE_REAL_PROVIDERS") === "true",
  artifactStoreEnabled: (): boolean =>
    read("ARTIFACT_STORE_ENABLED") === "true",
  artifactStoreDir: (): string => read("ARTIFACT_STORE_DIR") ?? "runs",
  sourceAssetCacheDir: (): string =>
    read("SOURCE_ASSET_CACHE_DIR") ?? "cache/source-assets",
  storySheetEnabled: (): boolean => read("STORY_SHEET_ENABLED") === "true",
  storySheetId: (): string | undefined => read("STORY_SHEET_ID"),
  storySheetGid: (): number => {
    const value = Number(read("STORY_SHEET_GID") ?? "0");
    return Number.isInteger(value) && value >= 0 ? value : 0;
  },
  storySheetHeaderRow: (): number => {
    const value = Number(read("STORY_SHEET_HEADER_ROW") ?? "1");
    return Number.isInteger(value) && value > 0 ? value : 1;
  },
  googleClientId: (): string | undefined => read("GOOGLE_CLIENT_ID"),
  googleClientSecret: (): string | undefined => read("GOOGLE_CLIENT_SECRET"),
  googleRefreshToken: (): string | undefined => read("GOOGLE_REFRESH_TOKEN"),
  youtubeUploadEnabled: (): boolean =>
    read("YOUTUBE_UPLOAD_ENABLED") === "true",
  youtubePrivacyStatus: (): "private" | "unlisted" | "public" => {
    const value = read("YOUTUBE_PRIVACY_STATUS");
    return value === "public" || value === "unlisted" ? value : "private";
  },
  youtubeCategoryId: (): string => read("YOUTUBE_CATEGORY_ID") ?? "27",
  youtubeMadeForKids: (): boolean | undefined => {
    const value = read("YOUTUBE_MADE_FOR_KIDS");
    if (value === undefined) return undefined;
    return value === "true";
  },
  youtubeContainsSyntheticMedia: (): boolean | undefined => {
    const value = read("YOUTUBE_CONTAINS_SYNTHETIC_MEDIA");
    if (value === undefined) return undefined;
    return value === "true";
  },
  enableScriptQA: (): boolean =>
    read("ENABLE_SCRIPT_QA") === "true" || read("ENABLE_QA") === "true",
  enableResearchQA: (): boolean =>
    read("ENABLE_RESEARCH_QA") === "true" || read("ENABLE_QA") === "true",
  enablePromptQA: (): boolean =>
    read("ENABLE_PROMPT_QA") === "true" || read("ENABLE_QA") === "true",
  enableReleaseQA: (): boolean =>
    read("ENABLE_RELEASE_QA") === "true" || read("ENABLE_QA") === "true",
  supportsVideoAssets: (): boolean => read("ENABLE_VIDEO_ASSETS") === "true",
  narrativeHoldSeconds: (): number => {
    const value = Number(read("NARRATIVE_HOLD_SECONDS") ?? "0.5");
    return Number.isFinite(value) && value >= 0 ? value : 0.5;
  },
  narrationTargetWpm: (): number | undefined => {
    const value = read("NARRATION_TARGET_WPM");
    if (!value) return undefined;
    const wpm = Number(value);
    return Number.isFinite(wpm) && wpm > 0 ? wpm : undefined;
  },
};
