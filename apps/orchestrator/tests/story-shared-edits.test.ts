import { afterEach, beforeEach, describe, it, expect } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type OpenAI from "openai";
import { staticScaleFilter } from "../src/providers/composer/ffmpeg/normalize.js";
import type { NormalizeOptions } from "../src/providers/composer/ffmpeg/normalize.js";
import {
  SCRIPT_COMPLEXITY_THRESHOLDS,
  validateScriptComplexity,
} from "../src/utils/script-complexity.js";
import { promptPathsFor } from "../src/models/prompt-paths.js";
import { AgentModel } from "../src/models/agent-model.js";
import { createModel } from "../src/models/model-factory.js";
import { config } from "../src/utils/config.js";
import { resolveStoryConfig, storyTtsMode } from "../src/story/config.js";
import { STORY_COMPLEXITY_THRESHOLDS } from "../src/story/lint.js";
import { packageRoot } from "../src/story/paths.js";

/**
 * One regression test per ADDITIVE shared-code edit. Each test proves the
 * pre-existing behaviour is byte-for-byte unchanged, so a future change to the
 * story pipeline cannot silently alter the Shorts pipeline.
 */

const ENV_KEYS = [
  "DEFAULT_MODEL",
  "STORY_LLM_MODEL",
  "MODEL_SCRIPTWRITER",
  "MODEL_RESEARCHAGENT",
  "MODEL_PREMIUM",
  "MODEL_QA",
  "MODEL_EDITORIAL",
  "MODEL_STORYAUTHOR",
  "MODEL_STORYVERIFIER",
  "MODEL_STORYSCENEPLANNER",
  "MODEL_STORYCHARACTERDESIGNER",
  "MODEL_STORYVISUALPLANNER",
  "NARRATION_TARGET_WPM",
  "TARGET_DURATION_SEC",
  "NARRATION_GENERATION_MODE",
  "TTS_PROVIDER",
  "STORY_TTS_WPM",
  "STORY_TARGET_DURATION_SEC",
  "STORY_STYLE",
  "STORY_JOBS_DIR",
  "PROMPT_VERSION",
];

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const CLIENT = {} as unknown as OpenAI;

const SCALE_OPTIONS: NormalizeOptions = {
  width: 1920,
  height: 1080,
  fps: 30,
  kenBurnsEnabled: false,
  kenBurnsMaxZoom: 1,
  encoder: { name: "shorts", encoder: "libx264", crf: 20, preset: "medium" },
};

describe("shared edit: normalize gained an optional cover-crop fit", () => {
  it("keeps the historical contain+pad filter byte-identical by default", () => {
    expect(staticScaleFilter(SCALE_OPTIONS)).toBe(
      "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p",
    );
  });

  it("is unaffected by an explicit contain or by scaleFlags alone", () => {
    expect(staticScaleFilter({ ...SCALE_OPTIONS, fit: "contain" })).toBe(
      staticScaleFilter(SCALE_OPTIONS),
    );
    expect(
      staticScaleFilter({ ...SCALE_OPTIONS, scaleFlags: "lanczos" }),
    ).toContain("force_original_aspect_ratio=decrease:flags=lanczos");
  });

  it("only switches to crop when the caller asks for cover", () => {
    expect(
      staticScaleFilter({
        ...SCALE_OPTIONS,
        fit: "cover",
        scaleFlags: "lanczos",
      }),
    ).toBe(
      "scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,setsar=1,fps=30,format=yuv420p",
    );
  });
});

describe("shared edit: validateScriptComplexity gained an optional thresholds argument", () => {
  it("keeps the historical Shorts thresholds", () => {
    expect(SCRIPT_COMPLEXITY_THRESHOLDS).toEqual({
      maxAverageSentenceWords: 15,
      maxSentenceWords: 25,
      maxReadingGrade: 8,
      targetSentenceMinWords: 8,
      targetSentenceMaxWords: 15,
    });
  });

  it("applies the historical thresholds when none are passed", () => {
    // One 23-word sentence plus four short ones: the average stays well inside
    // both threshold sets, so only the maximum sentence length differs.
    const long = Array.from({ length: 23 }, (_, index) => `word${index}`).join(
      " ",
    );
    const story = `${long}. One two. Three four. Five six. Seven eight.`;

    expect(validateScriptComplexity(story).issues).toEqual([]);
    expect(
      validateScriptComplexity(story, STORY_COMPLEXITY_THRESHOLDS).issues.map(
        (issue) => issue.code,
      ),
    ).toContain("maximum_sentence_length");
  });
});

describe("shared edit: promptPathsFor gained story-* keys", () => {
  it("returns the thirteen historical agents unchanged", () => {
    const paths = promptPathsFor("v1");
    expect({
      ResearchAgent: paths.ResearchAgent,
      ResearchQA: paths.ResearchQA,
      ScriptPlanner: paths.ScriptPlanner,
      ScriptWriter: paths.ScriptWriter,
      ScriptQA: paths.ScriptQA,
      VisualDirector: paths.VisualDirector,
      ImagePromptGenerator: paths.ImagePromptGenerator,
      PromptQA: paths.PromptQA,
      ImagePromptRepair: paths.ImagePromptRepair,
      ReleaseReview: paths.ReleaseReview,
      MetadataGenerator: paths.MetadataGenerator,
      ThumbnailGenerator: paths.ThumbnailGenerator,
      ThumbnailQA: paths.ThumbnailQA,
    }).toEqual({
      ResearchAgent: "research-agent/v1.md",
      ResearchQA: "research-qa/v1.md",
      ScriptPlanner: "script-planner/v1.md",
      ScriptWriter: "script-writer/v1.md",
      ScriptQA: "script-qa/v1.md",
      VisualDirector: "visual-director/v1.md",
      ImagePromptGenerator: "image-prompt-generator/v1.md",
      PromptQA: "prompt-qa/v1.md",
      ImagePromptRepair: "image-prompt-repair/v1.md",
      ReleaseReview: "release-review/v1.md",
      MetadataGenerator: "metadata-generator/v1.md",
      ThumbnailGenerator: "thumbnail-generator/v1.md",
      ThumbnailQA: "thumbnail-qa/v1.md",
    });
  });

  it("adds exactly five story agents under their own prefixes", () => {
    const paths = promptPathsFor("v1");
    expect({
      StoryAuthor: paths.StoryAuthor,
      StoryVerifier: paths.StoryVerifier,
      StoryScenePlanner: paths.StoryScenePlanner,
      StoryCharacterDesigner: paths.StoryCharacterDesigner,
      StoryVisualPlanner: paths.StoryVisualPlanner,
    }).toEqual({
      StoryAuthor: "story-story/v1.md",
      StoryVerifier: "story-verify/v1.md",
      StoryScenePlanner: "story-scenes/v1.md",
      StoryCharacterDesigner: "story-characters/v1.md",
      StoryVisualPlanner: "story-slots/v1.md",
    });
    expect(Object.keys(paths)).toHaveLength(18);
  });

  it("still honours a version pin for every key", () => {
    const paths = promptPathsFor("v2");
    expect(paths.ScriptQA).toBe("script-qa/v2.md");
    expect(paths.StoryAuthor).toBe("story-story/v2.md");
  });
});

describe("shared edit: AgentModel gained story members", () => {
  it("keeps every historical member and its string value", () => {
    const historical = [
      "ResearchAgent",
      "ResearchCollector",
      "ResearchQA",
      "ScriptPlanner",
      "ScriptWriter",
      "ScriptQA",
      "VisualDirector",
      "AssetStrategy",
      "ImagePromptGenerator",
      "PromptEngineer",
      "ImagePromptRepair",
      "NarrationPlanner",
      "PromptQA",
      "QAReviewer",
      "MetadataWriter",
      "AssetGenerator",
      "NarrationGenerator",
      "SubtitleGenerator",
      "VideoComposer",
      "ReleaseValidation",
      "ReleaseReview",
      "MetadataGenerator",
      "ThumbnailGenerator",
      "ThumbnailQA",
      "Publisher",
      "ResolveProfile",
    ];
    for (const member of historical) {
      expect(AgentModel[member as keyof typeof AgentModel]).toBe(member);
    }
    expect(Object.keys(AgentModel)).toHaveLength(historical.length + 5);
  });

  it("adds the five story members", () => {
    expect(AgentModel.StoryAuthor).toBe("StoryAuthor");
    expect(AgentModel.StoryVerifier).toBe("StoryVerifier");
    expect(AgentModel.StoryScenePlanner).toBe("StoryScenePlanner");
    expect(AgentModel.StoryCharacterDesigner).toBe("StoryCharacterDesigner");
    expect(AgentModel.StoryVisualPlanner).toBe("StoryVisualPlanner");
  });
});

describe("shared edit: STORY_LLM_MODEL is a story-only model fallback", () => {
  it("leaves the historical resolution chain untouched for Shorts agents", () => {
    expect(createModel(AgentModel.ScriptWriter, { client: CLIENT }).model).toBe(
      "openai/gpt-4o-mini",
    );

    process.env.STORY_LLM_MODEL = "story/model";
    expect(createModel(AgentModel.ScriptWriter, { client: CLIENT }).model).toBe(
      "openai/gpt-4o-mini",
    );
    expect(
      createModel(AgentModel.ResearchAgent, { client: CLIENT }).model,
    ).toBe("openai/gpt-4o-mini");
  });

  it("uses STORY_LLM_MODEL for story agents, between the role and the default", () => {
    process.env.STORY_LLM_MODEL = "story/model";
    expect(createModel(AgentModel.StoryAuthor, { client: CLIENT }).model).toBe(
      "story/model",
    );
    expect(
      createModel(AgentModel.StoryVisualPlanner, { client: CLIENT }).model,
    ).toBe("story/model");

    process.env.MODEL_PREMIUM = "role/premium";
    expect(createModel(AgentModel.StoryAuthor, { client: CLIENT }).model).toBe(
      "role/premium",
    );

    process.env.MODEL_STORYAUTHOR = "agent/override";
    expect(createModel(AgentModel.StoryAuthor, { client: CLIENT }).model).toBe(
      "agent/override",
    );
  });
});

describe("shared edit: the STORY_* config block is isolated", () => {
  it("does not change any Shorts-pipeline accessor", () => {
    process.env.STORY_TTS_WPM = "300";
    process.env.STORY_TARGET_DURATION_SEC = "999";
    process.env.STORY_STYLE = "other-style";

    expect(config.narrationTargetWpm()).toBeUndefined();
    expect(config.targetDurationSec()).toBeUndefined();
    expect(config.narrationGenerationMode()).toBe("scene");
    expect(config.narrationTargetWpm()).not.toBe(300);
  });

  it("exposes the story defaults behind their own accessors", () => {
    expect(config.storyTtsWpm()).toBe(175);
    expect(config.storyStyle()).toBe("stickman-history");
    expect(config.storyJobsDir()).toBe("jobs");
    expect(config.storyVoice()).toBe("narrator");
    expect(config.storyImageConcurrency()).toBe(1);
    expect(config.storyReferenceSheet()).toBe(false);

    const story = resolveStoryConfig({ topic: "x" });
    expect(story.wpm).toBe(175);
    expect(storyTtsMode()).toBe("scene");
  });
});

describe("shared edit: the jobs directory is git-ignored by an anchored path", () => {
  it("ignores /apps/orchestrator/jobs/ and not every directory named jobs", async () => {
    const gitignore = await readFile(
      resolve(packageRoot(), "..", "..", ".gitignore"),
      "utf-8",
    );
    const lines = gitignore.split("\n").map((line) => line.trim());
    expect(lines).toContain("/apps/orchestrator/jobs/");
    expect(lines).not.toContain("jobs/");
    expect(lines).not.toContain("jobs");
  });
});
