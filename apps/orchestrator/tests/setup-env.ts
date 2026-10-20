process.env.ENABLE_SCRIPT_QA = "true";
process.env.ENABLE_RESEARCH_QA = "true";
process.env.ENABLE_PROMPT_QA = "true";
process.env.ENABLE_RELEASE_QA = "true";
process.env.ENABLE_VIDEO_ASSETS = "true";
process.env.USE_REAL_PROVIDERS = "false";
process.env.ENABLE_THUMBNAIL = "true";

// Pinned so `pnpm test` is reproducible on a clean checkout (CI never creates
// apps/orchestrator/.env). Several suites assert values derived from the
// narration pace; without this they see the 160 wpm fallback and fail.
process.env.NARRATION_TARGET_WPM = "140";
