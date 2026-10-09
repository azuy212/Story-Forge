import type { RunnableConfig } from "@langchain/core/runnables";
import type { ProjectState, Diagnostics, Execution } from "../types/index.js";
import { resolveVideoProfile } from "../utils/video-profile.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import { AgentModel } from "../models/agent-model.js";

export const RESOLVE_PROFILE_VERSION = "1";

export async function resolveProfileNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  videoProfile: ReturnType<typeof resolveVideoProfile>;
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const startedAt = Date.now();
  const label = nodeLabel(AgentModel.ResolveProfile);
  logger.nodeStart(label);

  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  const override = inject.videoProfile as
    ReturnType<typeof resolveVideoProfile> | undefined;

  // The `videoProfile` state channel defaults to a FULLY RESOLVED SHORT
  // profile (state.ts: `default: () => resolveVideoProfile({})`), so
  // `state.videoProfile` is never empty and testing it for presence pins
  // every run to short — including `--profile long` backlog runs. Decide from
  // the run's explicit project request instead; `explicit` is the flag that
  // distinguishes "resolved from a request" from "env/default fallback".
  const requested = !!(
    state.project?.videoProfile ?? state.project?.targetDurationSec
  );

  let profile: ReturnType<typeof resolveVideoProfile>;
  if (override) {
    profile = override;
    logger.nodePhase(label, "using injected profile override");
  } else if (requested) {
    profile = resolveVideoProfile({
      videoProfile: state.project?.videoProfile,
      targetDurationSec: state.project?.targetDurationSec,
    });
    logger.nodePhase(label, `resolved ${profile.profile} from project request`);
  } else if (state.videoProfile?.explicit) {
    // Already resolved upstream from an explicit request.
    profile = state.videoProfile;
    logger.nodePhase(label, "using resolved profile from state");
  } else {
    profile = resolveVideoProfile({});
    logger.nodePhase(label, `resolved ${profile.profile}`);
  }

  logger.nodeDone(label, Date.now() - startedAt);

  return {
    videoProfile: profile,
    diagnostics: {
      telemetry: {
        [AgentModel.ResolveProfile]: {
          model: "deterministic",
          durationMs: Date.now() - startedAt,
          retries: 0,
          agentVersion: RESOLVE_PROFILE_VERSION,
        },
      },
    },
    execution: { currentNode: AgentModel.ResolveProfile },
  };
}
