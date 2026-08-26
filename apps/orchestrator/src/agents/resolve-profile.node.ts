import type { RunnableConfig } from "@langchain/core/runnables";
import type { ProjectState, Diagnostics, Execution } from "../types/index.js";
import { resolveVideoProfile } from "../utils/video-profile.js";
import { logger } from "../utils/logger.js";

export async function resolveProfileNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  videoProfile: ReturnType<typeof resolveVideoProfile>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  const override = inject.videoProfile as
    ReturnType<typeof resolveVideoProfile> | undefined;

  if (override) {
    logger.debug("ResolveProfile: using injected profile override");
    return {
      videoProfile: override,
      diagnostics: {},
      execution: { currentNode: "ResolveProfile" },
    };
  }

  const request = {
    videoProfile: state.project?.videoProfile,
    targetDurationSec: state.project?.targetDurationSec,
  };

  const profile = resolveVideoProfile(request);

  logger.debug("ResolveProfile resolved", {
    profile: profile.profile,
    targetDurationSec: profile.targetDurationSec,
    explicit: profile.explicit,
  });

  return {
    videoProfile: profile,
    diagnostics: {},
    execution: { currentNode: "ResolveProfile" },
  };
}
