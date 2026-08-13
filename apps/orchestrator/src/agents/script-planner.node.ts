import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ProjectState,
  Content,
  Diagnostics,
  Execution,
} from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { runAgent, type AgentInject } from "./run-agent.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { ScriptPlannerOutputSchema } from "../schemas/script-planner-output.js";
import type { ScriptPlannerOutput } from "../schemas/script-planner-output.js";

function formatFacts(
  facts: {
    id: string;
    fact: string;
    confidence: string;
    classification?: string;
  }[],
): string {
  return facts
    .map((f) => {
      const cls = f.classification ? ` (${f.classification})` : "";
      return `- ${f.id}${cls} (${f.confidence}): ${f.fact}`;
    })
    .join("\n");
}

function validateStoryPlan(
  data: ScriptPlannerOutput,
  approvedFactIds: string[],
): string[] {
  const warnings: string[] = [];

  // beatId contiguity, exact duration sums, and the final/non-final
  // curiosityQuestion contract are enforced by the schema (deterministic
  // structural invariants); the composer normalizes timing anyway. Only
  // semantic checks that code cannot repair are kept here.

  const referencedIds = new Set(
    data.storyBeats.flatMap((b) => b.referencedFacts),
  );
  const approvedSet = new Set(approvedFactIds);

  for (const rid of referencedIds) {
    if (!approvedSet.has(rid)) {
      warnings.push(
        `StoryPlanner: beat references fact "${rid}" which is not in approved facts`,
      );
    }
  }

  const unusedIds = approvedFactIds.filter((id) => !referencedIds.has(id));
  if (unusedIds.length > 0) {
    warnings.push(
      `StoryPlanner: approved facts never referenced in any beat: [${unusedIds.join(", ")}]`,
    );
  }

  return warnings;
}

export async function scriptPlannerNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  content: Partial<Content>;
  storyPlan: {
    storyType: ScriptPlannerOutput["storyType"];
    storySummary: string;
    storyBeats: ScriptPlannerOutput["storyBeats"];
  };
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const { pillar, topic } = state.project;
  const research = state.research;
  const inject = (config.configurable ?? {}) as AgentInject;

  if (!research?.summary || !research?.facts || research.facts.length === 0) {
    return {
      content: {},
      storyPlan: { storyType: "mystery", storySummary: "", storyBeats: [] },
      diagnostics: {
        errors: [
          `${AgentModel.ScriptPlanner}: research is required before script planning.`,
        ],
      },
      execution: { currentNode: AgentModel.ScriptPlanner },
    };
  }

  const estimatedDurationSeconds =
    state.content?.estimatedDurationSeconds ?? 50;

  const result = await runAgent<ScriptPlannerOutput>({
    agent: AgentModel.ScriptPlanner,
    promptPath: PromptPaths.ScriptPlanner,
    schema: ScriptPlannerOutputSchema,
    variables: {
      pillar: pillar ?? "",
      topic: topic ?? "",
      researchSummary: research.summary ?? "",
      approvedFacts: formatFacts(research.facts),
      estimatedDurationSeconds: String(estimatedDurationSeconds),
    },
    inject,
    configurable: config.configurable as Record<string, unknown>,
    generateOptions: {
      temperature: 0.5,
      responseFormat: { type: "json_object" },
    },
  });

  if (result.error || !result.data) {
    return {
      content: {},
      storyPlan: { storyType: "mystery", storySummary: "", storyBeats: [] },
      diagnostics: {
        errors: [`${AgentModel.ScriptPlanner}: ${result.error}`],
        telemetry: { [AgentModel.ScriptPlanner]: result.telemetry },
      },
      execution: { currentNode: AgentModel.ScriptPlanner },
    };
  }

  const { content, storyType, storySummary, storyBeats } = result.data;

  const approvedFactIds = research.facts.map((f) => f.id);
  const warnings = validateStoryPlan(result.data, approvedFactIds);

  return {
    content: { title: content.title.trim(), hook: content.hook.trim() },
    storyPlan: { storyType, storySummary, storyBeats },
    diagnostics: {
      warnings,
      telemetry: { [AgentModel.ScriptPlanner]: result.telemetry },
    },
    execution: { currentNode: AgentModel.ScriptPlanner },
  };
}
