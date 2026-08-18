function read(name: string): string | undefined {
  return process.env[name];
}

function parsePublishAt(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : new Date(parsed).toISOString();
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
  useRealProviders: (): boolean => read("USE_REAL_PROVIDERS") === "true",
  artifactStoreEnabled: (): boolean =>
    read("ARTIFACT_STORE_ENABLED") === "true",
  artifactStoreDir: (): string => read("ARTIFACT_STORE_DIR") ?? "runs",
  sourceAssetCacheDir: (): string =>
    read("SOURCE_ASSET_CACHE_DIR") ?? "cache/source-assets",
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
};
