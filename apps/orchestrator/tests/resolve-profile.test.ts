import { describe, it, expect, afterEach, beforeEach } from "@jest/globals";
import { resolveProfileNode } from "../src/agents/resolve-profile.node.js";
import { resolveVideoProfile } from "../src/utils/video-profile.js";
import type { ProjectState } from "../src/types/index.js";
import type { VideoProfileConfig } from "../src/schemas/video-profile.js";

const ENV_KEYS = [
  "VIDEO_PROFILE",
  "TARGET_DURATION_SEC",
  "DURATION_TOLERANCE_SEC",
  "WORDS_PER_MINUTE",
  "NARRATION_TARGET_WPM",
];

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Mirrors what LangGraph hands the first node: annotation defaults are already
// materialized, so `videoProfile` is a fully resolved SHORT profile unless the
// run asked for something else.
function stateWith(overrides: {
  project?: Partial<ProjectState["project"]>;
  videoProfile?: Partial<VideoProfileConfig>;
}): ProjectState {
  return {
    project: {
      pillar: "Mystery",
      topic: "The Mary Celeste",
      ...overrides.project,
    },
    videoProfile: {
      ...resolveVideoProfile({}),
      ...overrides.videoProfile,
    },
    execution: { version: "0.1.0" },
  } as ProjectState;
}

async function resolve(
  state: ProjectState,
  configurable: Record<string, unknown> = {},
) {
  const result = await resolveProfileNode(state, {
    configurable,
  } as never);
  return result.videoProfile;
}

describe("resolveProfileNode", () => {
  it("honors project.videoProfile=long over the short annotation default", async () => {
    const profile = await resolve(
      stateWith({ project: { videoProfile: "long" } }),
    );
    expect(profile.profile).toBe("long");
    expect(profile.aspectRatio).toBe("16:9");
    expect(profile.videoSize).toEqual({ width: 1920, height: 1080 });
    expect(profile.targetDurationSec).toBe(
      resolveVideoProfile({ videoProfile: "long" }).targetDurationSec,
    );
    expect(profile.explicit).toBe(true);
  });

  it("honors project.videoProfile=short explicitly", async () => {
    const profile = await resolve(
      stateWith({ project: { videoProfile: "short" } }),
    );
    expect(profile.profile).toBe("short");
    expect(profile.explicit).toBe(true);
  });

  it("honors an explicit targetDurationSec from the project", async () => {
    const profile = await resolve(
      stateWith({ project: { targetDurationSec: 420 } }),
    );
    expect(profile.targetDurationSec).toBe(420);
    expect(profile.explicit).toBe(true);
  });

  it("falls back to env defaults when the project requests nothing", async () => {
    process.env.VIDEO_PROFILE = "long";
    const profile = await resolve(stateWith({}));
    expect(profile.profile).toBe("long");
    expect(profile.explicit).toBe(false);
  });

  it("defaults to short when neither the project nor the env asks", async () => {
    const profile = await resolve(stateWith({}));
    expect(profile.profile).toBe("short");
    expect(profile.aspectRatio).toBe("9:16");
    expect(profile.explicit).toBe(false);
  });

  it("prefers an injected override over the project request", async () => {
    const injected = resolveVideoProfile({ videoProfile: "short" });
    const profile = await resolve(
      stateWith({ project: { videoProfile: "long" } }),
      { videoProfile: injected },
    );
    expect(profile).toBe(injected);
  });

  it("keeps a profile already resolved upstream from an explicit request", async () => {
    const resolved = resolveVideoProfile({ videoProfile: "long" });
    const profile = await resolve(
      stateWith({ videoProfile: resolved as Partial<VideoProfileConfig> }),
    );
    expect(profile).toEqual(resolved);
  });
});
