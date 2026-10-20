import { describe, it, expect } from "@jest/globals";
import { AgentModel } from "../src/models/agent-model.js";
import { loadPrompt } from "../src/utils/load-prompt.js";
import { createStoryAgents } from "../src/story/agents.js";
import type { AgentInject } from "../src/agents/run-agent.js";
import {
  CharacterRegistrySchema,
  SceneGroupingSchema,
  SceneVisualSlotsSchema,
  StoryOutputSchema,
  StoryVerificationSchema,
} from "../src/story/types.js";

/**
 * Prompt-file contract tests (brief M3/M6).
 *
 * Each prompt is loaded through the real prompt loader and rendered by the
 * real `runAgent` path with a fake model, so these tests fail if a prompt
 * declares a placeholder that the story agent never supplies (the placeholder
 * would survive rendering) or if the two drift apart in either direction.
 */

type Captured = {
  agent: AgentModel;
  text: string;
};

/** A fake `createModel` that records the rendered messages and answers once. */
function captureInject(payload: unknown): {
  calls: Captured[];
  inject: AgentInject;
} {
  const calls: Captured[] = [];
  const inject: AgentInject = {
    createModel: ((agent: AgentModel) => ({
      model: "fake/model",
      setCallContext(): void {},
      async generate(messages: Array<{ role: string; content: string }>) {
        calls.push({
          agent,
          text: messages.map((message) => message.content).join("\n\n"),
        });
        return {
          output: JSON.stringify(payload),
          usage: {
            provider: "fake",
            model: "fake/model",
            timestamp: new Date().toISOString(),
            totalTokens: 2,
          },
        };
      },
    })) as unknown as AgentInject["createModel"],
  };
  return { calls, inject };
}

const DECLARED_VARIABLES: Record<string, string[]> = {
  "story-story/v1.md": [
    "averageSentenceWords",
    "feedback",
    "language",
    "maxSentenceWords",
    "maxWords",
    "minWords",
    "targetWords",
    "tone",
    "topic",
  ],
  "story-verify/v1.md": ["claims", "language", "story"],
  "story-scenes/v1.md": [
    "maxWords",
    "minWords",
    "sceneTargetMaxSec",
    "sceneTargetMinSec",
    "sentences",
    "wpm",
  ],
  "story-characters/v1.md": [
    "feedback",
    "language",
    "maxCues",
    "maxWords",
    "story",
  ],
  "story-slots/v1.md": [
    "characters",
    "language",
    "narration",
    "sceneId",
    "visualPurpose",
  ],
};

const STORY_PROMPT_FILES = Object.keys(DECLARED_VARIABLES);

describe("story prompt files", () => {
  it("ships every prompt as a two-part template with a system/user split", async () => {
    for (const path of STORY_PROMPT_FILES) {
      const template = await loadPrompt(path);
      const parts = template.split("\n---\n");
      expect(parts).toHaveLength(2);
      expect(parts[0].trim().length).toBeGreaterThan(40);
      expect(parts[1].trim().length).toBeGreaterThan(40);
      expect(template).not.toContain("*/");
    }
  });

  it("declares exactly the variables the story agents supply", async () => {
    for (const [path, expected] of Object.entries(DECLARED_VARIABLES)) {
      const template = await loadPrompt(path);
      const declared = [
        ...new Set(
          [...template.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]),
        ),
      ].sort();
      expect(declared).toEqual([...expected].sort());
    }
  });

  it("documents every key of the response schema it must return", async () => {
    const expectations: Array<{ path: string; keys: string[] }> = [
      {
        path: "story-story/v1.md",
        keys: Object.keys(StoryOutputSchema.shape),
      },
      {
        path: "story-verify/v1.md",
        keys: Object.keys(StoryVerificationSchema.shape),
      },
      {
        path: "story-scenes/v1.md",
        keys: Object.keys(SceneGroupingSchema.shape),
      },
      {
        path: "story-characters/v1.md",
        keys: Object.keys(CharacterRegistrySchema.shape),
      },
      {
        path: "story-slots/v1.md",
        keys: Object.keys(SceneVisualSlotsSchema.shape),
      },
    ];

    for (const { path, keys } of expectations) {
      const template = await loadPrompt(path);
      for (const key of keys) {
        expect(template).toContain(`"${key}"`);
      }
    }
  });
});

describe("story agent prompt rendering", () => {
  it("renders the writer prompt with no placeholder left and the real values inlined", async () => {
    const { calls, inject } = captureInject({
      title: "A title",
      story: "A story.",
      claims: [],
    });
    const agents = createStoryAgents({ inject });

    await agents.writeStory({
      topic: "TOPIC-MARKER",
      language: "en",
      tone: "TONE-MARKER",
      targetWords: 150,
      feedback: "FEEDBACK-MARKER",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe(AgentModel.StoryAuthor);
    expect(calls[0].text).not.toContain("{{");
    expect(calls[0].text).toContain("TOPIC-MARKER");
    expect(calls[0].text).toContain("TONE-MARKER");
    expect(calls[0].text).toContain("150");
    expect(calls[0].text).toContain("FEEDBACK-MARKER");
  });

  it("renders the verifier prompt with the claims ledger", async () => {
    const { calls, inject } = captureInject({ issues: [] });
    const agents = createStoryAgents({ inject });

    await agents.verifyStory({
      story: "STORY-MARKER",
      language: "en",
      claims: [
        { claim: "CLAIM-MARKER", status: "disputed", hedgeInNarration: true },
      ],
    });

    expect(calls[0].agent).toBe(AgentModel.StoryVerifier);
    expect(calls[0].text).not.toContain("{{");
    expect(calls[0].text).toContain("STORY-MARKER");
    expect(calls[0].text).toContain("CLAIM-MARKER");
    expect(calls[0].text).toContain("disputed");
  });

  it("renders the scene planner prompt with sentence ids and the word budget", async () => {
    const { calls, inject } = captureInject({
      scenes: [{ sceneId: 1, sentenceIds: ["s1"], visualPurpose: "Purpose." }],
    });
    const agents = createStoryAgents({ inject });

    await agents.planScenes({
      sentences: [
        { id: "s1", text: "First sentence." },
        { id: "s2", text: "Second sentence." },
      ],
      wpm: 150,
      sceneTargetMinSec: 6,
      sceneTargetMaxSec: 12,
    });

    expect(calls[0].agent).toBe(AgentModel.StoryScenePlanner);
    expect(calls[0].text).not.toContain("{{");
    expect(calls[0].text).toContain("s1: First sentence.");
    expect(calls[0].text).toContain("s2: Second sentence.");
    // 6 s * 150 / 60 = 15 words; 12 s * 150 / 60 = 30 words.
    expect(calls[0].text).toContain("15");
    expect(calls[0].text).toContain("30");
  });

  it("renders the character designer prompt from the story", async () => {
    const { calls, inject } = captureInject({
      characters: [
        {
          id: "columbus",
          name: "Columbus",
          role: "the captain",
          visualDescription: "A tall man.",
        },
      ],
    });
    const agents = createStoryAgents({ inject });

    await agents.designCharacters({ story: "STORY-MARKER", language: "en" });

    expect(calls[0].agent).toBe(AgentModel.StoryCharacterDesigner);
    expect(calls[0].text).not.toContain("{{");
    expect(calls[0].text).toContain("STORY-MARKER");
  });

  it("renders the slot planner with the registry description injected verbatim", async () => {
    const { calls, inject } = captureInject({
      sceneId: 3,
      action: "An action.",
      characters: [],
      setting: "A setting.",
      props: [],
      lighting: "Light.",
      composition: "Wide.",
      metaphor: false,
    });
    const agents = createStoryAgents({ inject });

    await agents.planSceneVisuals({
      sceneId: 3,
      narration: "NARRATION-MARKER",
      visualPurpose: "PURPOSE-MARKER",
      language: "en",
      characters: [
        {
          id: "columbus",
          name: "Columbus",
          role: "the captain",
          visualDescription: "VISUAL-MARKER",
        },
      ],
    });

    expect(calls[0].agent).toBe(AgentModel.StoryVisualPlanner);
    expect(calls[0].text).not.toContain("{{");
    expect(calls[0].text).toContain("NARRATION-MARKER");
    expect(calls[0].text).toContain("PURPOSE-MARKER");
    expect(calls[0].text).toContain("columbus");
    expect(calls[0].text).toContain("VISUAL-MARKER");
    expect(calls[0].text).toContain("3");
  });
});
