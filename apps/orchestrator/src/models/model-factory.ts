import OpenAI from "openai";
import { config } from "../utils/config.js";
import { AgentModel } from "./agent-model.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const AGENT_ROLES: Record<AgentModel, string> = {
  [AgentModel.ResearchAgent]: "PREMIUM",
  [AgentModel.ResearchCollector]: "PREMIUM",
  [AgentModel.ResearchQA]: "QA",
  [AgentModel.ScriptPlanner]: "EDITORIAL",
  [AgentModel.ScriptWriter]: "PREMIUM",
  [AgentModel.ScriptQA]: "QA",
  [AgentModel.VisualDirector]: "EDITORIAL",
  [AgentModel.AssetStrategy]: "SYSTEM",
  [AgentModel.ImagePromptGenerator]: "EDITORIAL",
  [AgentModel.PromptEngineer]: "EDITORIAL",
  [AgentModel.NarrationPlanner]: "EDITORIAL",
  [AgentModel.PromptQA]: "QA",
  [AgentModel.QAReviewer]: "QA",
  [AgentModel.MetadataWriter]: "METADATA",
  [AgentModel.AssetGenerator]: "SYSTEM",
  [AgentModel.NarrationGenerator]: "SYSTEM",
  [AgentModel.SubtitleGenerator]: "SYSTEM",
  [AgentModel.VideoComposer]: "SYSTEM",
  [AgentModel.ReleaseValidation]: "QA",
  [AgentModel.ReleaseReview]: "QA",
  [AgentModel.MetadataGenerator]: "METADATA",
  [AgentModel.ThumbnailGenerator]: "METADATA",
  [AgentModel.Publisher]: "SYSTEM",
};

function resolveModel(agent: AgentModel): string {
  return (
    config.modelForAgent(agent) ??
    config.modelForRole(AGENT_ROLES[agent]) ??
    // Read lazily so env changes after module load take effect.
    config.defaultModel()
  );
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: config.openrouterApiKey(),
      baseURL: OPENROUTER_BASE_URL,
    });
  }
  return _client;
}

export type GenerateOptions = {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" } | { type: "text" };
  timeoutMs?: number;
};

export function createModel(agent: AgentModel) {
  const client = getClient();
  const model = resolveModel(agent);

  return {
    model,
    async generate(
      messages: OpenAI.Chat.ChatCompletionMessageParam[],
      options?: GenerateOptions,
    ) {
      const timeoutMs = options?.timeoutMs ?? 600_000; // Default to 10 minutes
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        return await client.chat.completions.create(
          {
            model,
            messages,
            temperature: options?.temperature ?? 0.7,
            max_tokens: options?.maxTokens,
            response_format: options?.responseFormat,
          },
          { signal: controller.signal },
        );
      } catch (err) {
        if (timedOut) {
          const timeoutError = new Error(
            `Model request timed out after ${timeoutMs}ms`,
          );
          timeoutError.name = "TimeoutError";
          (timeoutError as Error & { cause?: unknown }).cause = err;
          throw timeoutError;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
