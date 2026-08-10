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
  useRealProviders: (): boolean => read("USE_REAL_PROVIDERS") === "true",
  artifactStoreEnabled: (): boolean =>
    read("ARTIFACT_STORE_ENABLED") === "true",
  artifactStoreDir: (): string => read("ARTIFACT_STORE_DIR") ?? "runs",
  enableScriptQA: (): boolean =>
    read("ENABLE_SCRIPT_QA") === "true" || read("ENABLE_QA") === "true",
  enableResearchQA: (): boolean =>
    read("ENABLE_RESEARCH_QA") === "true" || read("ENABLE_QA") === "true",
  enablePromptQA: (): boolean =>
    read("ENABLE_PROMPT_QA") === "true" || read("ENABLE_QA") === "true",
  enableReleaseQA: (): boolean =>
    read("ENABLE_RELEASE_QA") === "true" || read("ENABLE_QA") === "true",
  supportsVideoAssets: (): boolean => read("ENABLE_VIDEO_ASSETS") === "true",
};
