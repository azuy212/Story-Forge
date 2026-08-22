import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { graph } from "../src/graph/index.js";
import {
  ImageGenerationProviderError,
  normalizeImageGenerationError,
} from "../src/providers/image-generation-error.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const mockCreateModel = jest
  .fn<(...args: any[]) => { model: string; generate: typeof mockGenerate }>()
  .mockReturnValue({ model: "test-model", generate: mockGenerate });

const MOCK_GUIDELINES = "Editorial guidelines for testing.";
const MOCK_AGENT_PROMPT = "System.\n---\nUser.";

const mockLoadPrompt = jest
  .fn<(...args: any[]) => Promise<string>>()
  .mockImplementation((path: string) => {
    if (path.includes("editorial-guidelines"))
      return Promise.resolve(MOCK_GUIDELINES);
    return Promise.resolve(MOCK_AGENT_PROMPT);
  });

const SCENE_NARRATIONS = [
  "What if a country officially was not real? This land appears on every map. Yet it has no borders.",
  "The nation has no formal territory. It has no legal standing in the international community.",
  "It is one of the most isolated places on Earth. Open ocean surrounds it for thousands of miles.",
  "No one lives here permanently. The few visitors who come each year need special approval to come ashore.",
  "Its ecosystem is unique. It has plant and animal species found nowhere else in the world.",
  "Access requires special permission. Even then, the journey across the open sea takes several days.",
];

const STORY_BEATS = [
  {
    beatId: 1,
    purpose: "Hook with central question",
    viewerQuestion: "What if a country wasn't real?",
    curiosityQuestion: "So how can a place like this exist?",
    keyMessage: "This place defies normal geography.",
    referencedFacts: ["fact-001"],
    priority: "high",
    estimatedDurationSeconds: 4,
  },
  {
    beatId: 2,
    purpose: "Reveal surprising fact",
    viewerQuestion: "Where is it?",
    curiosityQuestion: "How remote is it, really?",
    keyMessage: "The nearest land is over 2,000 km away.",
    referencedFacts: ["fact-001", "fact-002"],
    priority: "high",
    estimatedDurationSeconds: 6,
  },
  {
    beatId: 3,
    purpose: "Show scale of isolation",
    viewerQuestion: "How remote is it?",
    curiosityQuestion: "Does anyone live there?",
    keyMessage: "One of the most isolated places on the planet.",
    referencedFacts: ["fact-002"],
    priority: "medium",
    estimatedDurationSeconds: 8,
  },
  {
    beatId: 4,
    purpose: "Reveal population fact",
    viewerQuestion: "Does anyone live there?",
    curiosityQuestion: "Why does it matter?",
    keyMessage: "It has no permanent population.",
    referencedFacts: ["fact-003"],
    priority: "medium",
    estimatedDurationSeconds: 8,
  },
  {
    beatId: 5,
    purpose: "Highlight ecological significance",
    viewerQuestion: "Why does it matter?",
    curiosityQuestion: "Can I visit?",
    keyMessage: "Its ecosystem is found nowhere else.",
    referencedFacts: ["fact-005"],
    priority: "medium",
    estimatedDurationSeconds: 8,
  },
  {
    beatId: 6,
    purpose: "Deliver final payoff",
    viewerQuestion: "Can I visit?",
    curiosityQuestion:
      "And there's still one mystery left: what would you see there today?",
    keyMessage: "Access requires special permission.",
    referencedFacts: ["fact-007"],
    priority: "high",
    estimatedDurationSeconds: 8,
  },
];

function makeFacts(count: number): {
  id: string;
  fact: string;
  confidence: "high" | "medium" | "low";
  sourceType: "general-knowledge";
}[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `fact-${String(i + 1).padStart(3, "0")}`,
    fact: `Fact number ${i + 1}.`,
    confidence: "high" as const,
    sourceType: "general-knowledge" as const,
  }));
}

function makeResearchQAResponse(facts: ReturnType<typeof makeFacts>) {
  return {
    status: "approved",
    feedback: "",
    issues: [],
    factsToRegenerate: 0,
    factVerdicts: facts.map((f) => ({
      factId: f.id,
      verdict: "keep",
      reason: `Accepted: ${f.fact}`,
    })),
  };
}

const RELEASE_PROBE = {
  width: 1080,
  height: 1920,
  duration: 42,
  hasVideo: true,
  hasAudio: true,
  fps: 30,
};

function makeBeats(
  count: number,
  durationPerBeat = 8,
): {
  beatId: number;
  purpose: string;
  viewerQuestion: string;
  curiosityQuestion: string;
  keyMessage: string;
  referencedFacts: string[];
  priority: "high";
  estimatedDurationSeconds: number;
}[] {
  return Array.from({ length: count }, (_, i) => ({
    beatId: i + 1,
    purpose: "Hook",
    viewerQuestion: "Q?",
    curiosityQuestion: "What comes next?",
    keyMessage: "K.",
    referencedFacts: [`fact-${String(i + 1).padStart(3, "0")}`],
    priority: "high" as const,
    estimatedDurationSeconds: durationPerBeat,
  }));
}

const EMOTIONAL_BEATS = [
  "mystery",
  "discovery",
  "tension",
  "awe",
  "payoff",
  "reflection",
] as const;

function makeScenes(narration: string[], durations: number[]) {
  const ends = [0];
  for (const d of durations) ends.push(ends.at(-1)! + d);
  return Array.from({ length: durations.length }, (_, i) => ({
    sceneId: i + 1,
    startSecond: ends[i],
    endSecond: ends[i + 1],
    durationSeconds: durations[i],
    narration: narration[i],
    sceneGoal: "Hook",
    visualDescription: "Aerial view of remote island",
    sceneType: "landscape" as const,
    cameraShot: "aerial" as const,
    cameraMotion: "drone-flyover" as const,
    transition: "cut" as const,
    emphasis: "high" as const,
    emotionalBeat: EMOTIONAL_BEATS[i % EMOTIONAL_BEATS.length],
    assetType: (i % 2 === 0 ? "video" : "image") as "video" | "image",
    references: [`fact-${String(i + 1).padStart(3, "0")}`],
  }));
}

function makeVisualPlans(scenes: ReturnType<typeof makeScenes>) {
  return scenes.map((s) => ({
    sceneId: s.sceneId,
    renderStyle: "photorealistic" as const,
    colorMood: "cold blue",
    lighting: "soft diffused",
    composition: "rule-of-thirds",
  }));
}

function makeAssets(
  scenes: ReturnType<typeof makeScenes>,
  prompt = "Aerial drone footage of remote island in Pacific Ocean. Endless blue water surrounding tiny landmass. Cinematic documentary style.",
) {
  return scenes.map((s) => ({
    sceneId: s.sceneId,
    assetType: s.assetType,
    generationPrompt: prompt,
  }));
}

function makePromptQAResponse(
  status: "approved" | "minor_revision" | "major_revision",
  scenes: ReturnType<typeof makeScenes>,
) {
  const verdict = status === "approved" ? "pass" : "revise";
  return {
    status,
    globalFeedback: status === "approved" ? "" : "Fix consistency",
    sceneResults: scenes.map((s) => ({
      sceneId: s.sceneId,
      verdict,
      feedback: "",
    })),
  };
}

/**
 * Queue the standard happy-path LLM mock chain (research → release review).
 * `scriptWriterRuns` controls how many ScriptWriter responses are queued (for
 * revision loops), `scriptQA` is the ordered list of ScriptQA responses, and
 * `promptQA` overrides the single PromptQA verdict.
 */
function queueHappyPathMocks(
  options: {
    scriptWriterRuns?: number;
    scriptQA?: Record<string, unknown>[];
    promptQA?: "approved" | "minor_revision" | "major_revision";
  } = {},
) {
  const {
    scriptWriterRuns = 1,
    scriptQA = [{ status: "approved", feedback: "" }],
    promptQA = "approved",
  } = options;
  const FACTS = makeFacts(8);
  const BEATS = makeBeats(6);
  const NARRATIONS = SCENE_NARRATIONS;
  const SCENES = makeScenes(NARRATIONS, [8, 8, 8, 8, 8, 10]);
  const VISUAL_PLANS = makeVisualPlans(SCENES);
  const ASSETS = makeAssets(SCENES, LONG_PROMPT);

  mockGenerate
    // 1. ResearchAgent
    .mockResolvedValueOnce({
      output: JSON.stringify({
        summary: "Remote island in Pacific.",
        facts: FACTS,
      }),
      usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
    })
    // 2. ResearchQA
    .mockResolvedValueOnce({
      output: JSON.stringify(makeResearchQAResponse(FACTS)),
      usage: { promptTokens: 9, completionTokens: 6, totalTokens: 15 },
    })
    // 3. ScriptPlanner
    .mockResolvedValueOnce({
      output: JSON.stringify({
        content: {
          title: "Mystery Island",
          hook: "What if a country wasn't real?",
        },
        storyType: "mystery",
        storySummary: "Mystery Island story.",
        storyBeats: BEATS,
      }),
      usage: { promptTokens: 13, completionTokens: 26, totalTokens: 39 },
    });

  // ScriptWriter and ScriptQA alternate (writer → QA → writer → QA) for
  // revision loops, so the responses are queued interleaved.
  const writer = (i: number) => ({
    output: JSON.stringify({
      content: {
        script: `Script body v${i + 1}.`,
        narration: NARRATIONS.join(" "),
        callToAction: "Subscribe!",
        estimatedDurationSeconds: 50,
      },
    }),
    usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
  });

  const rounds = Math.max(scriptWriterRuns, scriptQA.length);
  for (let i = 0; i < rounds; i++) {
    if (i < scriptWriterRuns) {
      mockGenerate.mockResolvedValueOnce(writer(i));
    }
    if (i < scriptQA.length) {
      mockGenerate.mockResolvedValueOnce({
        output: JSON.stringify(scriptQA[i]),
        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      });
    }
  }

  mockGenerate
    // 5. MetadataGenerator
    .mockResolvedValueOnce({
      output: JSON.stringify({
        title: "Mystery Island Video",
        description: "Explore the mystery.",
        tags: ["geography"],
        hashtags: ["#mystery"],
        category: "Education",
        pinnedComment: "What do you think?",
      }),
      usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
    })
    // 6. ThumbnailGenerator
    .mockResolvedValueOnce({
      output: JSON.stringify({
        thumbnailPrompt: "Mysterious island aerial",
        thumbnailText: "Doesn't Exist?",
        textPosition: "bottom-third",
        colorScheme: "cold blue",
      }),
      usage: { promptTokens: 16, completionTokens: 12, totalTokens: 28 },
    })
    // 7. VisualDirector
    .mockResolvedValueOnce({
      output: JSON.stringify({ scenes: SCENES, visualPlans: VISUAL_PLANS }),
      usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
    })
    // 8. ImagePromptGenerator
    .mockResolvedValueOnce({
      output: JSON.stringify({ assets: ASSETS }),
      usage: { promptTokens: 16, completionTokens: 32, totalTokens: 48 },
    })
    // 9. PromptQA
    .mockResolvedValueOnce({
      output: JSON.stringify(makePromptQAResponse(promptQA, SCENES)),
      usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
    })
    // 10. ReleaseReview
    .mockResolvedValueOnce({
      output: JSON.stringify({ status: "approved", issues: [] }),
      usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
    });

  return { SCENES, NARRATIONS };
}

/** Full provider config needed for a complete end-to-end run. */
function happyPathConfigurable() {
  return {
    createModel: mockCreateModel,
    loadPrompt: mockLoadPrompt,
    assetProvider: ASSET_PROVIDER,
    ttsProvider: TTS_PROVIDER,
    audioConcatenator: AUDIO_CONCATENATOR.concat,
    sceneSubtitleProvider: SCENE_SUBTITLE_PROVIDER,
    composerProvider: COMPOSER_PROVIDER,
    probe: () => Promise.resolve(RELEASE_PROBE),
    publisherProvider: {
      publish: () =>
        Promise.resolve({
          platform: "youtube",
          platformVideoId: "abc123",
          url: "https://youtube.com/watch?v=abc123",
          status: "published",
          publishedAt: new Date().toISOString(),
        }),
    },
  };
}

const ASSET_PROVIDER = {
  generateImage: () =>
    Promise.resolve({ url: "https://placeholder.local/scene.png" }),
  generateVideo: () =>
    Promise.resolve({ url: "https://placeholder.local/scene.mp4" }),
};

const REPAIRED_PROMPT_1 =
  "An original fictional elderly female psychologist, vertical portrait 9:16.";
const REPAIRED_PROMPT_2 =
  "A nondescript elderly woman reading in a study, vertical portrait 9:16.";
const LONG_PROMPT =
  "Aerial drone footage of remote island in Pacific Ocean. Endless blue water surrounding tiny landmass. Cinematic documentary style.";

/**
 * Provider that rejects the first image generation with a content-policy
 * error (or every generation when rejectAlways), then succeeds. Tracks the
 * number of image generation calls.
 */
function makeRepairProvider(options: { rejectAlways?: boolean } = {}) {
  const provider: {
    sceneImageCalls: number;
    generateImage: (args?: {
      sceneId?: number;
      prompt?: string;
    }) => Promise<{ url: string }>;
    generateVideo: () => Promise<{ url: string }>;
  } = {
    sceneImageCalls: 0,
    generateImage: (args) => {
      // The thumbnail node shares this provider but calls with sceneId 0;
      // only scene generation is counted and rejected.
      const isSceneCall = (args?.sceneId ?? 0) >= 1;
      if (isSceneCall) provider.sceneImageCalls += 1;
      if (
        isSceneCall &&
        (options.rejectAlways || provider.sceneImageCalls === 1)
      ) {
        return Promise.reject(
          new ImageGenerationProviderError(
            normalizeImageGenerationError({
              provider: "gemini",
              type: "content_policy",
              message:
                "There are a lot of people I can help with, but I can't depict some public figures.",
              originalPrompt: LONG_PROMPT,
              sceneId: 1,
            }),
          ),
        );
      }
      return Promise.resolve({ url: "https://placeholder.local/scene.png" });
    },
    generateVideo: () =>
      Promise.resolve({ url: "https://placeholder.local/scene.mp4" }),
  };
  return provider;
}

const TTS_PROVIDER = {
  synthesize: (opts: { filename?: string }) =>
    Promise.resolve({
      audioUrl: `https://placeholder.local/${opts.filename ?? "scene.wav"}`,
      durationMs: 7000,
    }),
};

const AUDIO_CONCATENATOR = {
  concat: (inputs: Array<{ durationMs?: number }>) =>
    Promise.resolve({
      audioPath: "https://placeholder.local/narration.wav",
      durationMs: inputs.reduce(
        (sum, input) => sum + (input.durationMs ?? 0),
        0,
      ),
    }),
};

const SCENE_SUBTITLE_PROVIDER = {
  generateSceneSubtitles: () =>
    Promise.resolve({
      srt: `1\n00:00:00,000 --> 00:00:42,000\n${SCENE_NARRATIONS.join(" ")}`,
      ass: "Dialogue: 0,0:00:00.00,0:00:42.00,Default,,0,0,0,,What if",
      wordTimestamps: [
        { word: "What", start: 0.0, end: 1.5 },
        { word: "if", start: 1.5, end: 3.0 },
      ],
    }),
};

const COMPOSER_PROVIDER = {
  compose: () =>
    Promise.resolve({
      videoUrl: "https://placeholder.local/final.mp4",
      durationMs: 42000,
      resolution: "1080x1920",
    }),
};

beforeEach(() => {
  mockGenerate.mockReset();
});

describe("Graph", () => {
  it("flows pillar/topic through all agents to asset plan", async () => {
    const FACTS = makeFacts(8);
    const SCENES = makeScenes(SCENE_NARRATIONS, [4, 6, 8, 8, 8, 8]);
    const VISUAL_PLANS = makeVisualPlans(SCENES);
    const ASSETS = makeAssets(SCENES);

    mockGenerate
      // ResearchAgent
      .mockResolvedValueOnce({
        output: JSON.stringify({
          summary: "A remote island in the Pacific Ocean.",
          facts: FACTS,
        }),

        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      })
      // ResearchQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify(makeResearchQAResponse(FACTS)),

        usage: { promptTokens: 9, completionTokens: 6, totalTokens: 15 },
      })
      // ScriptPlanner (title/hook + story plan, single call)
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            title: "The Country That Doesn't Exist",
            hook: "What if a country officially wasn't real?",
          },
          storyType: "mystery",
          storySummary:
            "A remote island that is one of the most isolated places on Earth.",
          storyBeats: STORY_BEATS,
        }),

        usage: { promptTokens: 13, completionTokens: 26, totalTokens: 39 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            script: "Script text.",
            narration: SCENE_NARRATIONS.join(" "),
            callToAction: "Follow @UniverseDecoded for more.",
            estimatedDurationSeconds: 42,
          },
        }),

        usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", feedback: "" }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      // MetadataGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({
          title: "Test Title",
          description: "Test description.",
          tags: ["geography"],
          hashtags: ["geo"],
          category: "Education",
          pinnedComment: "Comment?",
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      // ThumbnailGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({
          thumbnailPrompt: "High contrast aerial view",
          thumbnailText: "Doesn't Exist?",
          textPosition: "bottom-third",
          colorScheme: "cold blue and white",
        }),

        usage: { promptTokens: 16, completionTokens: 12, totalTokens: 28 },
      })
      // VisualDirector (scenes + visual plans, single call)
      .mockResolvedValueOnce({
        output: JSON.stringify({
          scenes: SCENES,
          visualPlans: VISUAL_PLANS,
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ assets: ASSETS }),
        usage: { promptTokens: 16, completionTokens: 32, totalTokens: 48 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify(makePromptQAResponse("approved", SCENES)),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", issues: [] }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Unrecognized Countries" },
        branding: {
          channel: "Universe Decoded",
          creator: "",
          cta: "",
          style: "Documentary",
          colorPalette: "Cold blue",
          logo: "UD logo",
        },
        execution: { version: "0.1.0" },
      },
      {
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
          assetProvider: ASSET_PROVIDER,
          ttsProvider: TTS_PROVIDER,
          audioConcatenator: AUDIO_CONCATENATOR.concat,
          sceneSubtitleProvider: SCENE_SUBTITLE_PROVIDER,
          composerProvider: COMPOSER_PROVIDER,
          probe: () => Promise.resolve(RELEASE_PROBE),
        },
      } as any,
    );

    expect(result.project.pillar).toBe("Geography");
    expect(result.project.topic).toBe("Unrecognized Countries");
    expect(result.content.title).toBe("The Country That Doesn't Exist");
    expect(result.content.hook).toBe(
      "What if a country officially wasn't real?",
    );

    expect(result.research?.summary).toBe(
      "A remote island in the Pacific Ocean.",
    );
    expect(result.research?.facts).toHaveLength(8);
    expect(result.research?.facts![0].id).toBe("fact-001");

    expect(result.storyPlan?.storySummary).toBe(
      "A remote island that is one of the most isolated places on Earth.",
    );
    expect(result.storyPlan?.storyBeats).toHaveLength(6);
    expect(result.storyPlan?.storyBeats![0].purpose).toBe(
      "Hook with central question",
    );

    expect(result.content.script).toBe("Script text.");
    expect(result.content.narration).toBe(SCENE_NARRATIONS.join(" "));
    expect(result.content.callToAction).toBe(
      "Follow for more mysteries of the universe.",
    );
    expect(result.content.estimatedDurationSeconds).toBe(42);

    expect(result.scriptQA?.status).toBe("approved");

    expect(result.production?.scenes).toHaveLength(6);
    const s = result.production?.scenes!;
    expect(s[0].sceneId).toBe(1);
    expect(s[0].sceneGoal).toBe("Hook");
    expect(s[0].visualDescription).toBe("Aerial view of remote island");
    expect(s[0].sceneType).toBe("landscape");
    expect(s[0].cameraShot).toBe("aerial");
    expect(s[0].cameraMotion).toBe("drone-flyover");
    expect(s[0].transition).toBe("cut");
    expect(s[0].emphasis).toBe("high");
    expect(s[0].assetType).toBe("video");
    expect(s[0].references).toEqual(["fact-001"]);
    expect(s[0].generationPrompt).toContain("Aerial drone footage");
    // Timestamps are derived in code from narration word counts — they must
    // start at 0, be contiguous, sum to the target, and be proportional to
    // each scene's share of the narration (not the LLM's numbers).
    expect(s[0].durationSeconds).toBeGreaterThan(0);
    expect(s[1].generationPrompt).toContain("Aerial drone footage");
    expect(s[1].assetType).toBe("image");
    expect(s[1].references).toEqual(["fact-002"]);
    expect(s[1].durationSeconds).toBeGreaterThan(0);

    expect(s[0].startSecond).toBe(0);
    expect(s[0].endSecond!).toBe(
      (s[0].startSecond ?? 0) + (s[0].durationSeconds ?? 0),
    );
    expect(s[1].startSecond).toBe(s[0].endSecond);
    // The composer frame-quantizes scene durations upward (whole 30fps
    // frames), so the total is >= the narration target, never shorter.
    expect(s[5].endSecond).toBeGreaterThanOrEqual(42);
    expect(s[5].endSecond).toBeLessThan(42.5);
    const totalDerived = s.reduce(
      (acc, sc) => acc + (sc.durationSeconds ?? 0),
      0,
    );
    expect(totalDerived).toBeGreaterThanOrEqual(42);

    // AssetGenerator deterministic fields (folded buildPlan)
    expect(s[0].provider).toBe("runway");
    expect(s[0].generationMode).toBe("generate");
    expect(s[0].filename).toBe("scene-001.mp4");
    expect(s[0].extension).toBe("mp4");
    expect(s[0].assetId).toBe("asset-scene-001");
    expect(s[1].provider).toBe("gpt-image");
    expect(s[1].filename).toBe("scene-002.png");
    expect(s[1].assetId).toBe("asset-scene-002");

    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.execution.status).toBe("complete");

    expect(result.publishing?.results).toBeDefined();
    expect(result.publishing?.results).toHaveLength(1);
    expect(result.publishing?.results![0].platform).toBe("youtube");
    expect(result.publishing?.results![0].status).toBe("published");
    expect(result.publishing?.publishedAt).toBeDefined();

    const scenesWithUrls = result.production?.scenes?.filter(
      (sc: any) => sc.assetUrl,
    );
    expect(scenesWithUrls).toHaveLength(6);
    expect(scenesWithUrls![0].assetUrl).toBe(
      "https://placeholder.local/scene.mp4",
    );
    expect(scenesWithUrls![0].assetGeneratedAt).toBeDefined();

    expect(result.audio?.narrationUrl).toBe(
      "https://placeholder.local/narration.wav",
    );
    expect(result.audio?.narrationDurationMs).toBe(42000);
    expect(result.audio?.voice).toBe("narrator");
    expect(result.audio?.generatedAt).toBeDefined();

    expect(result.subtitles?.srt).toContain("1");
    expect(result.subtitles?.ass).toBeDefined();
    expect(result.subtitles?.wordTimestamps).toBeDefined();
    expect(result.subtitles?.wordTimestamps!.length).toBeGreaterThan(0);

    expect(result.video?.videoUrl).toBe("https://placeholder.local/final.mp4");
    expect(result.video?.resolution).toBe("1080x1920");
    expect(result.video?.durationMs).toBe(42000);

    expect(result.releaseReview?.status).toBe("approved");

    expect(result.metadataOutput?.title).toBeDefined();
    expect(result.metadataOutput?.category).toBe("Education");
    expect(result.thumbnail?.thumbnailPrompt).toBeDefined();
    expect(result.thumbnail?.thumbnailText).toBeDefined();
    expect(result.thumbnail?.textPosition).toBe("bottom-third");
  }, 30000);

  it("continues and completes when ScriptQA minor_revision budget is exhausted", async () => {
    // Seed the producer counter so the FIRST minor_revision is already past
    // the one-revision budget: the router must accept the best script and
    // continue rather than regenerate or terminate.
    queueHappyPathMocks({
      scriptQA: [
        {
          status: "minor_revision",
          feedback: "Improve pacing.",
          issues: ["Beat 2 could be stronger"],
        },
      ],
    });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Mystery Island" },
        branding: { channel: "TestChannel", creator: "", cta: "Subscribe" },
        execution: { version: "0.1.0", retryCount: { ScriptWriter: 2 } },
      },
      {
        recursionLimit: 100,
        configurable: happyPathConfigurable(),
      } as any,
    );

    // Actual terminal state: accepted best script and the run completed.
    expect(result.execution.status).toBe("complete");
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.scriptQA?.status).toBe("minor_revision");
    // One real writer run (2 seeded + 1); the router did NOT route back, so the
    // revision counter did not increment again.
    expect(result.execution.retryCount?.ScriptWriter).toBe(3);
    expect(result.publishing?.results![0].status).toBe("published");
  }, 30000);

  it("accepts immediately when ScriptQA returns repeated minor feedback", async () => {
    // Identical feedback twice: after one revision the second round repeats, so
    // the router must accept the best result instead of regenerating a third
    // time.
    const minor = {
      status: "minor_revision",
      feedback: "Same pacing issue.",
      issues: ["Pacing is off"],
    };
    queueHappyPathMocks({ scriptWriterRuns: 2, scriptQA: [minor, minor] });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Mystery Island" },
        branding: { channel: "TestChannel", creator: "", cta: "Subscribe" },
        execution: { version: "0.1.0" },
      },
      {
        recursionLimit: 100,
        configurable: happyPathConfigurable(),
      } as any,
    );

    expect(result.execution.status).toBe("complete");
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.scriptQA?.status).toBe("minor_revision");
    expect(result.scriptQA?.repeated).toBe(true);
    // Exactly 2 writer runs (initial + 1 revision); the repeated round never
    // routed back to the producer.
    expect(result.execution.retryCount?.ScriptWriter).toBe(2);
    expect(result.publishing?.results![0].status).toBe("published");
  }, 30000);

  it("fails the run when ResearchQA returns fail past its budget", async () => {
    // Research is unusable (fail verdict) with the producer already at its
    // budget: the run must terminate failed, not loop or continue.
    mockGenerate
      .mockResolvedValueOnce({
        output: JSON.stringify({
          summary: "Summary.",
          facts: makeFacts(8),
        }),
        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          status: "fail",
          feedback: "No usable facts for script generation.",
          issues: ["Fewer than 5 facts survive review"],
          factsToRegenerate: 0,
          factVerdicts: makeFacts(8).map((f) => ({
            factId: f.id,
            verdict: "remove",
            reason: "Unsupported",
          })),
        }),
        usage: { promptTokens: 9, completionTokens: 6, totalTokens: 15 },
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Mystery Island" },
        branding: { channel: "TestChannel", creator: "", cta: "Subscribe" },
        execution: { version: "0.1.0", retryCount: { ResearchAgent: 3 } },
      },
      {
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
        },
      } as any,
    );

    expect(result.execution.status).toBe("failed");
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.researchQA?.status).toBe("fail");
    expect(result.diagnostics?.errors?.join("\n")).toContain(
      "No usable facts for script generation",
    );
    // Script was never produced.
    expect(result.content?.script).toBeUndefined();
  }, 30000);

  it("promptQA revise loops back to ImagePromptGenerator then proceeds on approval", async () => {
    const SCENES = makeScenes(SCENE_NARRATIONS, [8, 8, 8, 8, 8, 8]);
    const VISUAL_PLANS = makeVisualPlans(SCENES);
    const ASSETS = makeAssets(SCENES);

    mockGenerate
      .mockResolvedValueOnce({
        output: JSON.stringify({
          summary: "Summary.",
          facts: makeFacts(8),
        }),

        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify(makeResearchQAResponse(makeFacts(8))),

        usage: { promptTokens: 9, completionTokens: 6, totalTokens: 15 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: { title: "Title", hook: "Hook?" },
          storyType: "mystery",
          storySummary: "Summary.",
          storyBeats: makeBeats(6),
        }),

        usage: { promptTokens: 13, completionTokens: 26, totalTokens: 39 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            script: "Script.",
            narration: SCENE_NARRATIONS.join(" "),
            callToAction: "Subscribe.",
            estimatedDurationSeconds: 48,
          },
        }),

        usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", feedback: "" }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          title: "T",
          description: "D",
          tags: ["geography"],
          hashtags: [],
          category: "Education",
          pinnedComment: "C",
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          thumbnailPrompt: "P",
          thumbnailText: "T",
          textPosition: "center",
          colorScheme: "blue",
        }),

        usage: { promptTokens: 16, completionTokens: 12, totalTokens: 28 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          scenes: SCENES,
          visualPlans: VISUAL_PLANS,
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ assets: ASSETS }),
        usage: { promptTokens: 16, completionTokens: 32, totalTokens: 48 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify(makePromptQAResponse("minor_revision", SCENES)),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          assets: ASSETS.map((a) => ({
            ...a,
            generationPrompt: a.generationPrompt + " (revised)",
          })),
        }),

        usage: { promptTokens: 16, completionTokens: 32, totalTokens: 48 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify(makePromptQAResponse("approved", SCENES)),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", issues: [] }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Test" },
        branding: { channel: "C", creator: "", cta: "" },
        execution: { version: "0.1.0" },
      },
      {
        recursionLimit: 100,
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
          assetProvider: ASSET_PROVIDER,
          ttsProvider: TTS_PROVIDER,
          audioConcatenator: AUDIO_CONCATENATOR.concat,
          sceneSubtitleProvider: SCENE_SUBTITLE_PROVIDER,
          composerProvider: COMPOSER_PROVIDER,
          probe: () => Promise.resolve(RELEASE_PROBE),
        },
      } as any,
    );

    expect(result.production?.promptQA?.status).toBe("approved");
    expect(result.production?.scenes).toHaveLength(6);
    expect(result.production?.scenes![0].generationPrompt).toContain(
      "(revised)",
    );
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.execution.status).toBe("complete");
  }, 30000);

  it("promptQA major_revision loops back to VisualDirector then proceeds on approval", async () => {
    const SCENES = makeScenes(SCENE_NARRATIONS, [8, 8, 8, 8, 8, 8]);
    const VISUAL_PLANS = makeVisualPlans(SCENES);
    const ASSETS = makeAssets(SCENES);

    mockGenerate
      .mockResolvedValueOnce({
        output: JSON.stringify({
          summary: "Summary.",
          facts: makeFacts(8),
        }),

        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify(makeResearchQAResponse(makeFacts(8))),

        usage: { promptTokens: 9, completionTokens: 6, totalTokens: 15 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: { title: "Title", hook: "Hook?" },
          storyType: "mystery",
          storySummary: "Summary.",
          storyBeats: makeBeats(6),
        }),

        usage: { promptTokens: 13, completionTokens: 26, totalTokens: 39 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            script: "Script.",
            narration: SCENE_NARRATIONS.join(" "),
            callToAction: "Subscribe.",
            estimatedDurationSeconds: 48,
          },
        }),

        usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", feedback: "" }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          title: "T",
          description: "D",
          tags: ["geography"],
          hashtags: [],
          category: "Education",
          pinnedComment: "C",
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          thumbnailPrompt: "P",
          thumbnailText: "T",
          textPosition: "center",
          colorScheme: "blue",
        }),

        usage: { promptTokens: 16, completionTokens: 12, totalTokens: 28 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          scenes: SCENES,
          visualPlans: VISUAL_PLANS,
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ assets: ASSETS }),
        usage: { promptTokens: 16, completionTokens: 32, totalTokens: 48 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify(makePromptQAResponse("major_revision", SCENES)),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      // VisualDirector re-runs
      .mockResolvedValueOnce({
        output: JSON.stringify({
          scenes: SCENES,
          visualPlans: VISUAL_PLANS,
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ assets: ASSETS }),
        usage: { promptTokens: 16, completionTokens: 32, totalTokens: 48 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify(makePromptQAResponse("approved", SCENES)),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", issues: [] }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Test" },
        branding: { channel: "C", creator: "", cta: "" },
        execution: { version: "0.1.0" },
      },
      {
        recursionLimit: 100,
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
          assetProvider: ASSET_PROVIDER,
          ttsProvider: TTS_PROVIDER,
          audioConcatenator: AUDIO_CONCATENATOR.concat,
          sceneSubtitleProvider: SCENE_SUBTITLE_PROVIDER,
          composerProvider: COMPOSER_PROVIDER,
          probe: () => Promise.resolve(RELEASE_PROBE),
        },
      } as any,
    );

    expect(result.production?.promptQA?.status).toBe("approved");
    expect(result.production?.visualPlan).toBeDefined();
    expect(result.production?.visualPlan).toHaveLength(6);
    expect(result.execution?.retryCount?.VisualDirector).toBe(2);
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.execution.status).toBe("complete");
  }, 30000);

  it("continues and completes when PromptQA minor_revision budget is exhausted", async () => {
    // Seed the ImagePromptGenerator counter so the first minor_revision is
    // past its budget: the router accepts the best prompts and continues.
    queueHappyPathMocks({ promptQA: "minor_revision" });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Mystery Island" },
        branding: { channel: "TestChannel", creator: "", cta: "Subscribe" },
        execution: {
          version: "0.1.0",
          retryCount: { ImagePromptGenerator: 2 },
        },
      },
      {
        recursionLimit: 100,
        configurable: happyPathConfigurable(),
      } as any,
    );

    expect(result.execution.status).toBe("complete");
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.production?.promptQA?.status).toBe("minor_revision");
    // IPG ran once (2 seeded + 1); the router accepted without routing back.
    expect(result.execution.retryCount?.ImagePromptGenerator).toBe(3);
    expect(result.publishing?.results![0].status).toBe("published");
  }, 30000);

  it("fails the run when PromptQA major_revision budget is exhausted", async () => {
    // Seed the VisualDirector counter at the limit so the first
    // major_revision (blocking) fails the run through the shared terminal.
    queueHappyPathMocks({ promptQA: "major_revision" });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Mystery Island" },
        branding: { channel: "TestChannel", creator: "", cta: "Subscribe" },
        execution: {
          version: "0.1.0",
          retryCount: { VisualDirector: 3 },
        },
      },
      {
        recursionLimit: 100,
        configurable: happyPathConfigurable(),
      } as any,
    );

    expect(result.execution.status).toBe("failed");
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.production?.promptQA?.status).toBe("major_revision");
    // No assets were generated: the pipeline stopped before AssetGenerator.
    expect(result.production?.scenes![0].assetId).toBeUndefined();
    expect(result.publishing?.results).toHaveLength(0);
  }, 30000);

  it("complete pipeline produces all artifacts end-to-end", async () => {
    const FACTS = makeFacts(8);
    const BEATS = makeBeats(6);
    const BEATS_ADJUSTED = BEATS.map((b, i) => ({
      ...b,
      estimatedDurationSeconds: i === 5 ? 10 : b.estimatedDurationSeconds,
      referencedFacts:
        i === 0
          ? [...b.referencedFacts, "fact-007", "fact-008"]
          : b.referencedFacts,
    }));
    const NARRATIONS = SCENE_NARRATIONS;
    const SCENES = makeScenes(NARRATIONS, [8, 8, 8, 8, 8, 10]);
    const VISUAL_PLANS = makeVisualPlans(SCENES);
    const ASSETS = makeAssets(SCENES, LONG_PROMPT);

    mockGenerate
      // 1. ResearchAgent
      .mockResolvedValueOnce({
        output: JSON.stringify({
          summary: "Remote island in Pacific.",
          facts: FACTS,
        }),

        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      })
      // 1b. ResearchQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify(makeResearchQAResponse(FACTS)),

        usage: { promptTokens: 9, completionTokens: 6, totalTokens: 15 },
      })
      // 2. ScriptPlanner
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            title: "Mystery Island",
            hook: "What if a country wasn't real?",
          },
          storyType: "mystery",
          storySummary: "Mystery Island story.",
          storyBeats: BEATS_ADJUSTED,
        }),

        usage: { promptTokens: 13, completionTokens: 26, totalTokens: 39 },
      })
      // 3. ScriptWriter
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            script: "Script body.",
            narration: NARRATIONS.join(" "),
            callToAction: "Subscribe!",
            estimatedDurationSeconds: 50,
          },
        }),

        usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
      })
      // 4. ScriptQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", feedback: "" }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      // 5. MetadataGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({
          title: "Mystery Island Video",
          description: "Explore the mystery.",
          tags: ["geography"],
          hashtags: ["#mystery"],
          category: "Education",
          pinnedComment: "What do you think?",
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      // 6. ThumbnailGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({
          thumbnailPrompt: "Mysterious island aerial",
          thumbnailText: "Doesn't Exist?",
          textPosition: "bottom-third",
          colorScheme: "cold blue",
        }),

        usage: { promptTokens: 16, completionTokens: 12, totalTokens: 28 },
      })
      // 7. VisualDirector (scenes + visual plans)
      .mockResolvedValueOnce({
        output: JSON.stringify({
          scenes: SCENES,
          visualPlans: VISUAL_PLANS,
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      // 8. ImagePromptGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({ assets: ASSETS }),
        usage: { promptTokens: 16, completionTokens: 32, totalTokens: 48 },
      })
      // 9. PromptQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify(makePromptQAResponse("approved", SCENES)),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      // 10. ReleaseReview (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", issues: [] }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Mystery Island" },
        branding: {
          channel: "TestChannel",
          creator: "",
          cta: "Subscribe",
          style: "Documentary",
          colorPalette: "Cold blue",
        },
        execution: { version: "0.1.0" },
      },
      {
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
          assetProvider: ASSET_PROVIDER,
          ttsProvider: TTS_PROVIDER,
          audioConcatenator: AUDIO_CONCATENATOR.concat,
          sceneSubtitleProvider: SCENE_SUBTITLE_PROVIDER,
          composerProvider: COMPOSER_PROVIDER,
          probe: () => Promise.resolve(RELEASE_PROBE),
          publisherProvider: {
            publish: () =>
              Promise.resolve({
                platform: "youtube",
                platformVideoId: "abc123",
                url: "https://youtube.com/watch?v=abc123",
                status: "published",
                publishedAt: new Date().toISOString(),
              }),
          },
        },
      } as any,
    );

    expect(result.diagnostics?.errors).toHaveLength(0);
    expect(result.diagnostics?.warnings).toHaveLength(0);

    expect(result.content?.title).toBe("Mystery Island");
    expect(result.content?.hook).toBe("What if a country wasn't real?");
    expect(result.content?.script).toBe("Script body.");
    expect(result.content?.narration).toBe(NARRATIONS.join(" "));
    expect(result.content?.callToAction).toBe("Subscribe");
    expect(result.content?.estimatedDurationSeconds).toBe(50);

    expect(result.research?.summary).toBe("Remote island in Pacific.");
    expect(result.research?.facts).toHaveLength(8);

    expect(result.storyPlan?.storySummary).toBe("Mystery Island story.");
    expect(result.storyPlan?.storyBeats).toHaveLength(6);

    expect(result.scriptQA?.status).toBe("approved");

    expect(result.production?.scenes).toHaveLength(6);
    const s = result.production?.scenes![0];
    expect(s.sceneId).toBe(1);
    expect(s.visualDescription).toBe("Aerial view of remote island");
    expect(s.sceneType).toBe("landscape");
    expect(s.cameraShot).toBe("aerial");
    expect(s.cameraMotion).toBe("drone-flyover");
    expect(s.transition).toBe("cut");
    expect(s.emphasis).toBe("high");
    expect(s.assetType).toBe("video");
    expect(s.generationPrompt).toBe(LONG_PROMPT);
    expect(s.provider).toBe("runway");
    expect(s.filename).toBe("scene-001.mp4");
    expect(result.production?.visualPlan![0].renderStyle).toBe(
      "photorealistic",
    );
    expect(result.production?.visualPlan![0].colorMood).toBe("cold blue");
    expect(s.assetId).toBe("asset-scene-001");
    expect(s.assetUrl).toBe("https://placeholder.local/scene.mp4");
    expect(s.assetGeneratedAt).toBeDefined();

    expect(result.production?.promptQA?.status).toBe("approved");
    expect(result.production?.promptQA?.sceneResults).toHaveLength(6);
    expect(result.production?.promptQA?.sceneResults![0].verdict).toBe("pass");

    expect(result.audio?.narrationUrl).toBe(
      "https://placeholder.local/narration.wav",
    );
    expect(result.audio?.narrationDurationMs).toBe(42000);
    expect(result.audio?.voice).toBe("narrator");
    expect(result.audio?.generatedAt).toBeDefined();

    expect(result.subtitles?.srt).toContain("1");
    expect(result.subtitles?.ass).toBeDefined();
    expect(result.subtitles?.wordTimestamps).toBeDefined();
    expect(result.subtitles?.wordTimestamps!.length).toBeGreaterThan(0);
    expect(result.subtitles?.generatedAt).toBeDefined();

    expect(result.video?.videoUrl).toBe("https://placeholder.local/final.mp4");
    expect(result.video?.resolution).toBe("1080x1920");
    expect(result.video?.durationMs).toBe(42000);
    expect(result.video?.composedAt).toBeDefined();

    expect(result.releaseReview?.status).toBe("approved");

    expect(result.metadataOutput?.title).toBe("Mystery Island Video");
    expect(result.metadataOutput?.description).toBe("Explore the mystery.");
    expect(result.metadataOutput?.tags).toEqual(["geography"]);
    expect(result.metadataOutput?.category).toBe("Education");

    expect(result.thumbnail?.thumbnailPrompt).toBe("Mysterious island aerial");
    expect(result.thumbnail?.thumbnailText).toBe("Doesn't Exist?");
    expect(result.thumbnail?.textPosition).toBe("bottom-third");
    expect(result.thumbnail?.colorScheme).toBe("cold blue");

    expect(result.publishing?.results).toBeDefined();
    expect(result.publishing?.results).toHaveLength(1);
    expect(result.publishing?.results![0].platform).toBe("youtube");
    expect(result.publishing?.results![0].url).toBe(
      "https://youtube.com/watch?v=abc123",
    );
    expect(result.publishing?.results![0].status).toBe("published");
    expect(result.publishing?.publishedAt).toBeDefined();

    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.execution.status).toBe("complete");
    expect(result.diagnostics?.errors).toHaveLength(0);
    expect(result.diagnostics?.warnings).toHaveLength(0);
  }, 30000);

  it("repairs a provider-rejected prompt and regenerates the asset", async () => {
    const FACTS = makeFacts(8);
    const BEATS = makeBeats(6);
    const NARRATIONS = SCENE_NARRATIONS;
    const SCENES = makeScenes(NARRATIONS, [4, 6, 8, 8, 8, 8]).map((s) => ({
      ...s,
      assetType: "image" as const,
    }));
    const VISUAL_PLANS = makeVisualPlans(SCENES);
    const ASSETS = makeAssets(SCENES, LONG_PROMPT);
    const REPAIRED_PROMPT =
      "An original fictional elderly female psychologist with a non-identifiable appearance, vertical portrait 9:16.";
    const repairProvider = makeRepairProvider();

    mockGenerate
      // 1. ResearchAgent
      .mockResolvedValueOnce({
        output: JSON.stringify({
          summary: "Remote island in Pacific.",
          facts: FACTS,
        }),

        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      })
      // 2. ResearchQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify(makeResearchQAResponse(FACTS)),

        usage: { promptTokens: 9, completionTokens: 6, totalTokens: 15 },
      })
      // 3. ScriptPlanner
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            title: "Mystery Island",
            hook: "What if a country wasn't real?",
          },
          storyType: "mystery",
          storySummary: "Mystery Island story.",
          storyBeats: BEATS,
        }),

        usage: { promptTokens: 13, completionTokens: 26, totalTokens: 39 },
      })
      // 4. ScriptWriter
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            script: "Script body.",
            narration: NARRATIONS.join(" "),
            callToAction: "Subscribe!",
            estimatedDurationSeconds: 8,
          },
        }),

        usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
      })
      // 5. ScriptQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", feedback: "" }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      // 6. MetadataGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({
          title: "Mystery Island Video",
          description: "Explore the mystery.",
          tags: ["geography"],
          hashtags: ["#mystery"],
          category: "Education",
          pinnedComment: "What do you think?",
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      // 7. ThumbnailGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({
          thumbnailPrompt: "Mysterious island aerial",
          thumbnailText: "Doesn't Exist?",
          textPosition: "bottom-third",
          colorScheme: "cold blue",
        }),

        usage: { promptTokens: 16, completionTokens: 12, totalTokens: 28 },
      })
      // 8. VisualDirector
      .mockResolvedValueOnce({
        output: JSON.stringify({
          scenes: SCENES,
          visualPlans: VISUAL_PLANS,
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      // 9. ImagePromptGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({ assets: ASSETS }),
        usage: { promptTokens: 16, completionTokens: 32, totalTokens: 48 },
      })
      // 10. PromptQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify(makePromptQAResponse("approved", SCENES)),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      // 11. ImagePromptRepair (provider rejected the original prompt)
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT,
          changes: ["Removed reference-likeness language"],
          reason: "Provider rejects public-figure likenesses.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      // 12. ReleaseReview (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", issues: [] }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Mystery Island" },
        branding: {
          channel: "TestChannel",
          creator: "",
          cta: "Subscribe",
          style: "Documentary",
          colorPalette: "Cold blue",
        },
        execution: { version: "0.1.0" },
      },
      {
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
          assetProvider: repairProvider,
          ttsProvider: TTS_PROVIDER,
          audioConcatenator: AUDIO_CONCATENATOR.concat,
          sceneSubtitleProvider: SCENE_SUBTITLE_PROVIDER,
          composerProvider: COMPOSER_PROVIDER,
          probe: () => Promise.resolve(RELEASE_PROBE),
          publisherProvider: {
            publish: () =>
              Promise.resolve({
                platform: "youtube",
                platformVideoId: "abc123",
                url: "https://youtube.com/watch?v=abc123",
                status: "published",
                publishedAt: new Date().toISOString(),
              }),
          },
        },
      } as any,
    );

    const scene = result.production?.scenes![0];
    expect(scene?.generationStatus).toBe("complete");
    expect(scene?.assetUrl).toBe("https://placeholder.local/scene.png");
    expect(scene?.originalPrompt).toBe(LONG_PROMPT);
    expect(scene?.generationPrompt).toBe(REPAIRED_PROMPT);
    expect(scene?.repairedPrompt).toBe(REPAIRED_PROMPT);
    expect(scene?.repairCount).toBe(1);
    expect(scene?.promptAttempts).toHaveLength(2);
    expect(scene?.promptAttempts?.[0]).toMatchObject({
      attempt: 1,
      prompt: LONG_PROMPT,
      status: "rejected",
      errorType: "content_policy",
    });
    expect(scene?.promptAttempts?.[1]).toMatchObject({
      attempt: 2,
      status: "success",
    });
    // Unaffected scenes generated on the first pass.
    expect(result.production?.scenes![1].generationStatus).toBe("complete");
    expect(repairProvider.sceneImageCalls).toBe(7);
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.execution.status).toBe("complete");
    expect(result.diagnostics?.errors).toHaveLength(0);
  }, 30000);

  it("halts with unresolved_provider_rejection when repair budget is exhausted", async () => {
    const FACTS = makeFacts(8);
    const BEATS = makeBeats(6);
    const NARRATIONS = SCENE_NARRATIONS;
    const SCENES = makeScenes(NARRATIONS, [4, 6, 8, 8, 8, 8]).map((s) => ({
      ...s,
      assetType: "image" as const,
    }));
    const VISUAL_PLANS = makeVisualPlans(SCENES);
    const ASSETS = makeAssets(SCENES, LONG_PROMPT);
    const repairProvider = makeRepairProvider({ rejectAlways: true });

    mockGenerate
      // 1. ResearchAgent
      .mockResolvedValueOnce({
        output: JSON.stringify({
          summary: "Remote island in Pacific.",
          facts: FACTS,
        }),

        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      })
      // 2. ResearchQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify(makeResearchQAResponse(FACTS)),

        usage: { promptTokens: 9, completionTokens: 6, totalTokens: 15 },
      })
      // 3. ScriptPlanner
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            title: "Mystery Island",
            hook: "What if a country wasn't real?",
          },
          storyType: "mystery",
          storySummary: "Mystery Island story.",
          storyBeats: BEATS,
        }),

        usage: { promptTokens: 13, completionTokens: 26, totalTokens: 39 },
      })
      // 4. ScriptWriter
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            script: "Script body.",
            narration: NARRATIONS.join(" "),
            callToAction: "Subscribe!",
            estimatedDurationSeconds: 8,
          },
        }),

        usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
      })
      // 5. ScriptQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", feedback: "" }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      // 6. MetadataGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({
          title: "Mystery Island Video",
          description: "Explore the mystery.",
          tags: ["geography"],
          hashtags: ["#mystery"],
          category: "Education",
          pinnedComment: "What do you think?",
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      // 7. ThumbnailGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({
          thumbnailPrompt: "Mysterious island aerial",
          thumbnailText: "Doesn't Exist?",
          textPosition: "bottom-third",
          colorScheme: "cold blue",
        }),

        usage: { promptTokens: 16, completionTokens: 12, totalTokens: 28 },
      })
      // 8. VisualDirector
      .mockResolvedValueOnce({
        output: JSON.stringify({
          scenes: SCENES,
          visualPlans: VISUAL_PLANS,
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      // 9. ImagePromptGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({ assets: ASSETS }),
        usage: { promptTokens: 16, completionTokens: 32, totalTokens: 48 },
      })
      // 10. PromptQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify(makePromptQAResponse("approved", SCENES)),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      // 11-22. ImagePromptRepair: 6 scenes × 2 repair rounds (all rejected)
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_1,
          changes: ["Removed likeness language"],
          reason: "Content policy.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_1,
          changes: ["Removed likeness language"],
          reason: "Content policy.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_1,
          changes: ["Removed likeness language"],
          reason: "Content policy.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_1,
          changes: ["Removed likeness language"],
          reason: "Content policy.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_1,
          changes: ["Removed likeness language"],
          reason: "Content policy.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_1,
          changes: ["Removed likeness language"],
          reason: "Content policy.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_2,
          changes: ["Further de-identification"],
          reason: "Still rejected.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_2,
          changes: ["Further de-identification"],
          reason: "Still rejected.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_2,
          changes: ["Further de-identification"],
          reason: "Still rejected.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_2,
          changes: ["Further de-identification"],
          reason: "Still rejected.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_2,
          changes: ["Further de-identification"],
          reason: "Still rejected.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_2,
          changes: ["Further de-identification"],
          reason: "Still rejected.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          repairedPrompt: REPAIRED_PROMPT_2,
          changes: ["Further de-identification"],
          reason: "Still rejected.",
          shouldRetry: true,
        }),

        usage: { promptTokens: 16, completionTokens: 16, totalTokens: 32 },
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Mystery Island" },
        branding: {
          channel: "TestChannel",
          creator: "",
          cta: "Subscribe",
          style: "Documentary",
          colorPalette: "Cold blue",
        },
        execution: { version: "0.1.0" },
      },
      {
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
          assetProvider: repairProvider,
        },
      } as any,
    );

    const scene = result.production?.scenes![0];
    expect(scene?.generationStatus).toBe("failed");
    expect(scene?.failureType).toBe("unresolved_provider_rejection");
    expect(scene?.repairCount).toBe(2);
    // The budget counts LLM repairs; each repaired prompt was attempted, so
    // three distinct prompts were rejected before the scene failed.
    expect(scene?.promptAttempts).toHaveLength(3);
    expect(scene?.promptAttempts?.every((a) => a.status === "rejected")).toBe(
      true,
    );
    // Every distinct prompt in the repair chain survives: the original
    // (never generated), repair #1, and the final attempted prompt.
    expect(scene?.promptAttempts?.[0].prompt).toBe(LONG_PROMPT);
    expect(scene?.promptAttempts?.[1].prompt).toBe(REPAIRED_PROMPT_1);
    expect(scene?.promptAttempts?.[2].prompt).toBe(REPAIRED_PROMPT_2);
    expect(scene?.generationPrompt).toBe(REPAIRED_PROMPT_2);
    expect(scene?.repairedPrompt).toBe(REPAIRED_PROMPT_2);
    expect(scene?.originalPrompt).toBe(LONG_PROMPT);
    expect(scene?.assetUrl).toBeUndefined();
    // Every other scene also failed closed after two repairs.
    expect(
      result.production?.scenes?.every((s) => s.generationStatus === "failed"),
    ).toBe(true);
    expect(repairProvider.sceneImageCalls).toBe(18);
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.execution.status).toBe("failed");
    expect(result.diagnostics?.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unresolved_provider_rejection"),
      ]),
    );
  }, 30000);

  it("retries VisualDirector on structural failure then stops when budget exhausted", async () => {
    const FACTS = makeFacts(8);
    const BEATS = makeBeats(6);
    const NARRATIONS = SCENE_NARRATIONS;
    const SCENES = makeScenes(NARRATIONS, [4, 6, 8, 8, 8, 8]);
    // One visual plan missing — a structural failure that code cannot repair.
    // (Timing deviations are no longer failures: timestamps are code-derived.)
    const BAD_PLANS = makeVisualPlans(SCENES).slice(0, -1);

    mockGenerate
      // 1. ResearchAgent
      .mockResolvedValueOnce({
        output: JSON.stringify({
          summary: "Remote island in Pacific.",
          facts: FACTS,
        }),

        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      })
      // 1b. ResearchQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify(makeResearchQAResponse(FACTS)),

        usage: { promptTokens: 9, completionTokens: 6, totalTokens: 15 },
      })
      // 2. ScriptPlanner
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            title: "Mystery Island",
            hook: "What if a country wasn't real?",
          },
          storyType: "mystery",
          storySummary: "Mystery Island story.",
          storyBeats: BEATS,
        }),

        usage: { promptTokens: 13, completionTokens: 26, totalTokens: 39 },
      })
      // 3. ScriptWriter
      .mockResolvedValueOnce({
        output: JSON.stringify({
          content: {
            script: "Script body.",
            narration: NARRATIONS.join(" "),
            callToAction: "Subscribe!",
            estimatedDurationSeconds: 50,
          },
        }),

        usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
      })
      // 4. ScriptQA (approved)
      .mockResolvedValueOnce({
        output: JSON.stringify({ status: "approved", feedback: "" }),

        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      })
      // 5. MetadataGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({
          title: "Mystery Island Video",
          description: "Explore the mystery.",
          tags: ["geography"],
          hashtags: ["#mystery"],
          category: "Education",
          pinnedComment: "What do you think?",
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      // 6. ThumbnailGenerator
      .mockResolvedValueOnce({
        output: JSON.stringify({
          thumbnailPrompt: "Mysterious island aerial",
          thumbnailText: "Doesn't Exist?",
          textPosition: "bottom-third",
          colorScheme: "cold blue",
        }),

        usage: { promptTokens: 16, completionTokens: 12, totalTokens: 28 },
      })
      // 7..8. VisualDirector: structural failure with feedback, retried by the
      // router until the minor budget (1 revision) is exhausted.
      .mockResolvedValueOnce({
        output: JSON.stringify({
          scenes: SCENES,
          visualPlans: BAD_PLANS,
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          scenes: SCENES,
          visualPlans: BAD_PLANS,
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      })
      .mockResolvedValueOnce({
        output: JSON.stringify({
          scenes: SCENES,
          visualPlans: BAD_PLANS,
        }),

        usage: { promptTokens: 14, completionTokens: 28, totalTokens: 42 },
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Mystery Island" },
        branding: {
          channel: "TestChannel",
          creator: "",
          cta: "Subscribe",
          style: "Documentary",
          colorPalette: "Cold blue",
        },
        execution: { version: "0.1.0" },
      },
      {
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
          assetProvider: ASSET_PROVIDER,
          ttsProvider: TTS_PROVIDER,
          audioConcatenator: AUDIO_CONCATENATOR.concat,
          sceneSubtitleProvider: SCENE_SUBTITLE_PROVIDER,
          composerProvider: COMPOSER_PROVIDER,
          publisherProvider: {
            publish: () =>
              Promise.resolve({
                platform: "youtube",
                platformVideoId: "abc123",
                url: "https://youtube.com/watch?v=abc123",
                status: "published",
                publishedAt: new Date().toISOString(),
              }),
          },
        },
      } as any,
    );

    // Spine died at VisualDirector after exhausting its retry budget:
    // 7 calls upstream + 2 VisualDirector attempts (minor budget: 1 revision).
    expect(mockGenerate).toHaveBeenCalledTimes(9);

    // No scenes produced downstream.
    expect(result.production?.scenes).toEqual([]);
    expect(result.production?.directorReview?.status).toBe("minor_revision");
    expect(result.audio).toEqual({});
    expect(result.subtitles).toEqual({});
    expect(result.video?.videoUrl).toBeUndefined();
    expect(result.releaseValidation).toBeUndefined();
    expect(result.releaseReview).toBeUndefined();

    // Publisher never fired: the package was never assembled.
    expect(result.publishing?.results).toHaveLength(0);
    expect(result.publishing?.publishedAt).toBeUndefined();

    // Shared terminal finalized the run as failed.
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.execution.status).toBe("failed");

    // The upstream error is preserved; downstream must not invent its own.
    expect(result.diagnostics?.errors!.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics?.errors![0]).toContain("VisualDirector");
    expect(result.diagnostics?.errors!.join("\n")).not.toContain(
      "No production scenes found",
    );
    expect(result.diagnostics?.errors!.join("\n")).not.toContain(
      "videoUrl is missing",
    );
    expect(result.diagnostics?.errors!.join("\n")).not.toContain(
      "composition failed",
    );
  }, 30000);

  it("PublishReady fan-in: premature firing dead-ends branch, spine continues, final PublishReady fires with full package", async () => {
    // This test verifies the fan-in semantics of PublishReady:
    // 1. Metadata/Thumbnail branch finishes first -> PublishReady fires prematurely (package incomplete)
    // 2. Router returns __end__ (dead-ends this branch, spine continues)
    // 3. Spine completes -> PublishReady fires again with full package
    // 4. Publisher fires exactly once -> Finalize executes exactly once
    queueHappyPathMocks();

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Fan-in Test" },
        branding: { channel: "TestChannel", creator: "", cta: "Subscribe" },
        execution: { version: "0.1.0" },
      },
      {
        recursionLimit: 100,
        configurable: happyPathConfigurable(),
      } as any,
    );

    // Verify the pipeline completed successfully
    expect(result.execution.status).toBe("complete");
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.publishing?.results![0].status).toBe("published");

    // The graph execution should have:
    // - One Publisher execution (not zero, not multiple)
    // - One Finalize execution (the final terminal)
    // - No early termination from premature PublishReady
    expect(result.execution.currentNode).toBe("Finalize");
    expect(result.execution.status).toBe("complete");
    expect(result.publishing?.results).toHaveLength(1);
    expect(result.publishing?.results![0].status).toBe("published");
  }, 30000);
});
