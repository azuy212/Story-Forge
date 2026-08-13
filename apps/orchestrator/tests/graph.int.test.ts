import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { graph } from "../src/graph/index.js";

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

const ASSET_PROVIDER = {
  generateImage: () =>
    Promise.resolve({ url: "https://placeholder.local/scene.png" }),
  generateVideo: () =>
    Promise.resolve({ url: "https://placeholder.local/scene.mp4" }),
};

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
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "A remote island in the Pacific Ocean.",
                facts: FACTS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        model: "test-model",
      })
      // ResearchQA (approved)
      .mockResolvedValueOnce({
        choices: [
          {
            message: { content: JSON.stringify(makeResearchQAResponse(FACTS)) },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
        model: "test-model",
      })
      // ScriptPlanner (title/hook + story plan, single call)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  title: "The Country That Doesn't Exist",
                  hook: "What if a country officially wasn't real?",
                },
                storyType: "mystery",
                storySummary:
                  "A remote island that is one of the most isolated places on Earth.",
                storyBeats: STORY_BEATS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 13, completion_tokens: 26, total_tokens: 39 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  script: "Script text.",
                  narration: SCENE_NARRATIONS.join(" "),
                  callToAction: "Follow @UniverseDecoded for more.",
                  estimatedDurationSeconds: 42,
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", feedback: "" }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      // MetadataGenerator
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Test Title",
                description: "Test description.",
                tags: ["geography"],
                hashtags: ["geo"],
                category: "Education",
                pinnedComment: "Comment?",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      // ThumbnailGenerator
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                thumbnailPrompt: "High contrast aerial view",
                thumbnailText: "Doesn't Exist?",
                textPosition: "bottom-third",
                colorScheme: "cold blue and white",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 16, completion_tokens: 12, total_tokens: 28 },
        model: "test-model",
      })
      // VisualDirector (scenes + visual plans, single call)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scenes: SCENES,
                visualPlans: VISUAL_PLANS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ assets: ASSETS }) } }],
        usage: { prompt_tokens: 16, completion_tokens: 32, total_tokens: 48 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(makePromptQAResponse("approved", SCENES)),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", issues: [] }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
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

    expect(result.execution.currentNode).toBe("Publisher");

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

  it("terminates at ScriptQA when minor_revision retries exhausted", async () => {
    const FACTS = makeFacts(8);
    const BEATS = makeBeats(6);

    mockGenerate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ summary: "Summary.", facts: FACTS }),
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: { content: JSON.stringify(makeResearchQAResponse(FACTS)) },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: { title: "Title", hook: "Hook?" },
                storyType: "mystery",
                storySummary: "Summary.",
                storyBeats: BEATS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 13, completion_tokens: 26, total_tokens: 39 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  script: "Script.",
                  narration: "Narration.",
                  callToAction: "Subscribe.",
                  estimatedDurationSeconds: 45,
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        model: "test-model",
      })
      // First ScriptQA call — retries becomes 1
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "minor_revision",
                feedback: "Fix pacing.",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      // ScriptWriter runs again
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  script: "Script v2.",
                  narration: "Narration v2.",
                  callToAction: "Subscribe.",
                  estimatedDurationSeconds: 45,
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        model: "test-model",
      })
      // Second ScriptQA call — retries becomes 2
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "minor_revision",
                feedback: "Still bad pacing.",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      // ScriptWriter runs again
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  script: "Script v3.",
                  narration: "Narration v3.",
                  callToAction: "Subscribe.",
                  estimatedDurationSeconds: 45,
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        model: "test-model",
      })
      // Third ScriptQA call — retries becomes 3, router returns __end__
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "minor_revision",
                feedback: "Still bad pacing.",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Test" },
        branding: { channel: "C", creator: "", cta: "" },
        execution: { version: "0.1.0" },
      },
      {
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
        },
      } as any,
    );

    expect(result.scriptQA?.status).toBe("minor_revision");
    expect(result.scriptQA?.feedback).toContain("Still bad pacing");
    expect(result.execution.currentNode).toBe("ScriptQA");

    expect(result.production?.scenes).toHaveLength(0);
    expect(result.content?.callToAction).toBe(
      "Follow for more mysteries of the universe.",
    );
  }, 30000);

  it("promptQA revise loops back to ImagePromptGenerator then proceeds on approval", async () => {
    const SCENES = makeScenes(SCENE_NARRATIONS, [8, 8, 8, 8, 8, 8]);
    const VISUAL_PLANS = makeVisualPlans(SCENES);
    const ASSETS = makeAssets(SCENES);

    mockGenerate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Summary.",
                facts: makeFacts(8),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(makeResearchQAResponse(makeFacts(8))),
            },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: { title: "Title", hook: "Hook?" },
                storyType: "mystery",
                storySummary: "Summary.",
                storyBeats: makeBeats(6),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 13, completion_tokens: 26, total_tokens: 39 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  script: "Script.",
                  narration: SCENE_NARRATIONS.join(" "),
                  callToAction: "Subscribe.",
                  estimatedDurationSeconds: 48,
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", feedback: "" }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "T",
                description: "D",
                tags: ["geography"],
                hashtags: [],
                category: "Education",
                pinnedComment: "C",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                thumbnailPrompt: "P",
                thumbnailText: "T",
                textPosition: "center",
                colorScheme: "blue",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 16, completion_tokens: 12, total_tokens: 28 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scenes: SCENES,
                visualPlans: VISUAL_PLANS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ assets: ASSETS }) } }],
        usage: { prompt_tokens: 16, completion_tokens: 32, total_tokens: 48 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(
                makePromptQAResponse("minor_revision", SCENES),
              ),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                assets: ASSETS.map((a) => ({
                  ...a,
                  generationPrompt: a.generationPrompt + " (revised)",
                })),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 16, completion_tokens: 32, total_tokens: 48 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(makePromptQAResponse("approved", SCENES)),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", issues: [] }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
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
    expect(result.execution.currentNode).toBe("Publisher");
  }, 30000);

  it("promptQA major_revision loops back to VisualDirector then proceeds on approval", async () => {
    const SCENES = makeScenes(SCENE_NARRATIONS, [8, 8, 8, 8, 8, 8]);
    const VISUAL_PLANS = makeVisualPlans(SCENES);
    const ASSETS = makeAssets(SCENES);

    mockGenerate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Summary.",
                facts: makeFacts(8),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(makeResearchQAResponse(makeFacts(8))),
            },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: { title: "Title", hook: "Hook?" },
                storyType: "mystery",
                storySummary: "Summary.",
                storyBeats: makeBeats(6),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 13, completion_tokens: 26, total_tokens: 39 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  script: "Script.",
                  narration: SCENE_NARRATIONS.join(" "),
                  callToAction: "Subscribe.",
                  estimatedDurationSeconds: 48,
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", feedback: "" }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "T",
                description: "D",
                tags: ["geography"],
                hashtags: [],
                category: "Education",
                pinnedComment: "C",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                thumbnailPrompt: "P",
                thumbnailText: "T",
                textPosition: "center",
                colorScheme: "blue",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 16, completion_tokens: 12, total_tokens: 28 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scenes: SCENES,
                visualPlans: VISUAL_PLANS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ assets: ASSETS }) } }],
        usage: { prompt_tokens: 16, completion_tokens: 32, total_tokens: 48 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(
                makePromptQAResponse("major_revision", SCENES),
              ),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      // VisualDirector re-runs
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scenes: SCENES,
                visualPlans: VISUAL_PLANS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ assets: ASSETS }) } }],
        usage: { prompt_tokens: 16, completion_tokens: 32, total_tokens: 48 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(makePromptQAResponse("approved", SCENES)),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", issues: [] }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
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
    expect(result.execution.currentNode).toBe("Publisher");
  }, 30000);

  it("terminates at PromptQA when promptQA retries exhausted with revise status", async () => {
    const SCENES = makeScenes(SCENE_NARRATIONS, [8, 8, 8, 8, 8, 8]);
    const VISUAL_PLANS = makeVisualPlans(SCENES);
    const ASSETS = makeAssets(SCENES);

    mockGenerate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Summary.",
                facts: makeFacts(8),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(makeResearchQAResponse(makeFacts(8))),
            },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: { title: "Title", hook: "Hook?" },
                storyType: "mystery",
                storySummary: "Summary.",
                storyBeats: makeBeats(6),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 13, completion_tokens: 26, total_tokens: 39 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  script: "Script.",
                  narration: SCENE_NARRATIONS.join(" "),
                  callToAction: "Subscribe.",
                  estimatedDurationSeconds: 48,
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", feedback: "" }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "T",
                description: "D",
                tags: ["geography"],
                hashtags: [],
                category: "Education",
                pinnedComment: "C",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                thumbnailPrompt: "P",
                thumbnailText: "T",
                textPosition: "center",
                colorScheme: "blue",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 16, completion_tokens: 12, total_tokens: 28 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scenes: SCENES,
                visualPlans: VISUAL_PLANS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ assets: ASSETS }) } }],
        usage: { prompt_tokens: 16, completion_tokens: 32, total_tokens: 48 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(
                makePromptQAResponse("minor_revision", SCENES),
              ),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Test" },
        branding: { channel: "C", creator: "", cta: "" },
        execution: {
          version: "0.1.0",
          retryCount: { ImagePromptGenerator: 2 },
        },
      },
      {
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
          assetProvider: ASSET_PROVIDER,
        },
      } as any,
    );

    expect(result.production?.promptQA?.status).toBe("minor_revision");
    expect(result.production?.promptQA?.globalFeedback).toBe("Fix consistency");
    expect(result.execution.currentNode).toBe("PromptQA");

    expect(result.production?.scenes![0].assetId).toBeUndefined();
    expect(result.production?.scenes![0].assetUrl).toBeUndefined();
  }, 30000);

  it("terminates at PromptQA when major_revision retries exhausted", async () => {
    const SCENES = makeScenes(SCENE_NARRATIONS, [8, 8, 8, 8, 8, 8]);
    const VISUAL_PLANS = makeVisualPlans(SCENES);
    const ASSETS = makeAssets(SCENES);

    mockGenerate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Summary.",
                facts: makeFacts(8),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(makeResearchQAResponse(makeFacts(8))),
            },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: { title: "Title", hook: "Hook?" },
                storyType: "mystery",
                storySummary: "Summary.",
                storyBeats: makeBeats(6),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 13, completion_tokens: 26, total_tokens: 39 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  script: "Script.",
                  narration: SCENE_NARRATIONS.join(" "),
                  callToAction: "Subscribe.",
                  estimatedDurationSeconds: 48,
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", feedback: "" }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "T",
                description: "D",
                tags: ["geography"],
                hashtags: [],
                category: "Education",
                pinnedComment: "C",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                thumbnailPrompt: "P",
                thumbnailText: "T",
                textPosition: "center",
                colorScheme: "blue",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 16, completion_tokens: 12, total_tokens: 28 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scenes: SCENES,
                visualPlans: VISUAL_PLANS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ assets: ASSETS }) } }],
        usage: { prompt_tokens: 16, completion_tokens: 32, total_tokens: 48 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(
                makePromptQAResponse("major_revision", SCENES),
              ),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      });

    const result = await graph.invoke(
      {
        project: { pillar: "Geography", topic: "Test" },
        branding: { channel: "C", creator: "", cta: "" },
        execution: { version: "0.1.0", retryCount: { VisualDirector: 2 } },
      },
      {
        configurable: {
          createModel: mockCreateModel,
          loadPrompt: mockLoadPrompt,
          assetProvider: ASSET_PROVIDER,
        },
      } as any,
    );

    expect(result.production?.promptQA?.status).toBe("major_revision");
    expect(result.execution.currentNode).toBe("PromptQA");
    expect(result.production?.scenes![0].assetId).toBeUndefined();
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
    const LONG_PROMPT =
      "Aerial drone footage of remote island in Pacific Ocean. Endless blue water surrounding tiny landmass. Cinematic documentary style.";
    const ASSETS = makeAssets(SCENES, LONG_PROMPT);

    mockGenerate
      // 1. ResearchAgent
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Remote island in Pacific.",
                facts: FACTS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        model: "test-model",
      })
      // 1b. ResearchQA (approved)
      .mockResolvedValueOnce({
        choices: [
          {
            message: { content: JSON.stringify(makeResearchQAResponse(FACTS)) },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
        model: "test-model",
      })
      // 2. ScriptPlanner
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  title: "Mystery Island",
                  hook: "What if a country wasn't real?",
                },
                storyType: "mystery",
                storySummary: "Mystery Island story.",
                storyBeats: BEATS_ADJUSTED,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 13, completion_tokens: 26, total_tokens: 39 },
        model: "test-model",
      })
      // 3. ScriptWriter
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  script: "Script body.",
                  narration: NARRATIONS.join(" "),
                  callToAction: "Subscribe!",
                  estimatedDurationSeconds: 50,
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        model: "test-model",
      })
      // 4. ScriptQA (approved)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", feedback: "" }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      // 5. MetadataGenerator
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Mystery Island Video",
                description: "Explore the mystery.",
                tags: ["geography"],
                hashtags: ["#mystery"],
                category: "Education",
                pinnedComment: "What do you think?",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      // 6. ThumbnailGenerator
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                thumbnailPrompt: "Mysterious island aerial",
                thumbnailText: "Doesn't Exist?",
                textPosition: "bottom-third",
                colorScheme: "cold blue",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 16, completion_tokens: 12, total_tokens: 28 },
        model: "test-model",
      })
      // 7. VisualDirector (scenes + visual plans)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scenes: SCENES,
                visualPlans: VISUAL_PLANS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      // 8. ImagePromptGenerator
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ assets: ASSETS }) } }],
        usage: { prompt_tokens: 16, completion_tokens: 32, total_tokens: 48 },
        model: "test-model",
      })
      // 9. PromptQA (approved)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify(makePromptQAResponse("approved", SCENES)),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      // 10. ReleaseReview (approved)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", issues: [] }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
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
                publishUrl: "https://youtube.com/watch?v=abc123",
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
    expect(result.publishing?.results![0].publishUrl).toBe(
      "https://youtube.com/watch?v=abc123",
    );
    expect(result.publishing?.results![0].status).toBe("published");
    expect(result.publishing?.publishedAt).toBeDefined();

    expect(result.execution.currentNode).toBe("Publisher");
    expect(result.diagnostics?.errors).toHaveLength(0);
    expect(result.diagnostics?.warnings).toHaveLength(0);
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
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Remote island in Pacific.",
                facts: FACTS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        model: "test-model",
      })
      // 1b. ResearchQA (approved)
      .mockResolvedValueOnce({
        choices: [
          {
            message: { content: JSON.stringify(makeResearchQAResponse(FACTS)) },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
        model: "test-model",
      })
      // 2. ScriptPlanner
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  title: "Mystery Island",
                  hook: "What if a country wasn't real?",
                },
                storyType: "mystery",
                storySummary: "Mystery Island story.",
                storyBeats: BEATS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 13, completion_tokens: 26, total_tokens: 39 },
        model: "test-model",
      })
      // 3. ScriptWriter
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: {
                  script: "Script body.",
                  narration: NARRATIONS.join(" "),
                  callToAction: "Subscribe!",
                  estimatedDurationSeconds: 50,
                },
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        model: "test-model",
      })
      // 4. ScriptQA (approved)
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "approved", feedback: "" }),
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        model: "test-model",
      })
      // 5. MetadataGenerator
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Mystery Island Video",
                description: "Explore the mystery.",
                tags: ["geography"],
                hashtags: ["#mystery"],
                category: "Education",
                pinnedComment: "What do you think?",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      // 6. ThumbnailGenerator
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                thumbnailPrompt: "Mysterious island aerial",
                thumbnailText: "Doesn't Exist?",
                textPosition: "bottom-third",
                colorScheme: "cold blue",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 16, completion_tokens: 12, total_tokens: 28 },
        model: "test-model",
      })
      // 7..9. VisualDirector: structural failure with feedback, retried by the
      // router until the retry budget (3) is exhausted.
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scenes: SCENES,
                visualPlans: BAD_PLANS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scenes: SCENES,
                visualPlans: BAD_PLANS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scenes: SCENES,
                visualPlans: BAD_PLANS,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 28, total_tokens: 42 },
        model: "test-model",
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
                publishUrl: "https://youtube.com/watch?v=abc123",
                status: "published",
                publishedAt: new Date().toISOString(),
              }),
          },
        },
      } as any,
    );

    // Spine died at VisualDirector after exhausting its retry budget:
    // 7 calls upstream + 3 VisualDirector attempts.
    expect(mockGenerate).toHaveBeenCalledTimes(10);

    // No scenes produced downstream.
    expect(result.production?.scenes).toEqual([]);
    expect(result.production?.directorReview?.status).toBe("minor_revision");
    expect(result.audio).toEqual({});
    expect(result.subtitles).toEqual({});
    expect(result.video?.videoUrl).toBeUndefined();
    expect(result.releaseValidation).toBeUndefined();
    expect(result.releaseReview).toBeUndefined();

    // Publisher still joined (via Metadata/Thumbnail branches) but no-oped.
    expect(result.publishing?.results).toHaveLength(0);
    expect(result.publishing?.publishedAt).toBeUndefined();

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
});
