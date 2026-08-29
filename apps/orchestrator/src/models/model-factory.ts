import OpenAI from "openai";
import { config } from "../utils/config.js";
import { AgentModel } from "./agent-model.js";
import { normalizeUsage, type LLMResult } from "./usage.js";
import { appendRunLogEvent, type RunLogSink } from "../utils/run-log.js";

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
  [AgentModel.ImagePromptRepair]: "EDITORIAL",
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
  [AgentModel.ThumbnailQA]: "QA",
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

export interface CreateModelOptions {
  runLogSink?: RunLogSink | null;
  promptPath?: string;
  promptVersion?: string;
  promptHash?: string;
  runId?: string;
  invocationId?: string;
  attempt?: number;
  fromCache?: boolean;
}

export function createModel(
  agent: AgentModel,
  options: CreateModelOptions = {},
) {
  const client = getClient();
  const model = resolveModel(agent);
  const sink = options.runLogSink ?? null;
  const includeMessages = config.runLogIncludeMessages();

  return {
    model,
    setCallContext(ctx: { attempt?: number; invocationId?: string }): void {
      if (ctx.attempt !== undefined) options.attempt = ctx.attempt;
      if (ctx.invocationId !== undefined) {
        options.invocationId = ctx.invocationId;
      }
    },
    async generate(
      messages: OpenAI.Chat.ChatCompletionMessageParam[],
      generateOptions?: GenerateOptions,
    ): Promise<LLMResult<string>> {
      const timeoutMs = generateOptions?.timeoutMs ?? 600_000; // Default to 10 minutes
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      const startedAt = Date.now();
      const requestBody = {
        model,
        messages,
        temperature: generateOptions?.temperature ?? 0.7,
        max_tokens: generateOptions?.maxTokens,
        response_format: generateOptions?.responseFormat,
      };
      const requestBodyBytes = Buffer.byteLength(
        JSON.stringify(requestBody),
        "utf-8",
      );
      let responseBytes: number | undefined;
      let responseText: string | undefined;
      let responseStatus: number | undefined;
      let responseId: string | undefined;
      let normalizedUsage: ReturnType<typeof normalizeUsage>;
      let errorPayload: Record<string, unknown> | undefined;

      try {
        const response = await client.chat.completions.create(
          {
            model,
            messages,
            temperature: generateOptions?.temperature ?? 0.7,
            max_tokens: generateOptions?.maxTokens,
            response_format: generateOptions?.responseFormat,
          },
          { signal: controller.signal },
        );
        responseStatus = 200;
        responseId = response.id;
        responseText = response.choices?.[0]?.message?.content ?? "";
        responseBytes = Buffer.byteLength(responseText, "utf-8");
        normalizedUsage = normalizeUsage(response.usage, {
          model: response.model ?? model,
          requestId: response.id,
        });
        return {
          output: responseText,
          usage: normalizedUsage,
        };
      } catch (err) {
        const status =
          typeof err === "object" && err !== null && "status" in err
            ? (err as { status?: unknown }).status
            : undefined;
        responseStatus = typeof status === "number" ? status : undefined;
        errorPayload = {
          name: (err as Error)?.name,
          message: (err as Error)?.message ?? String(err),
          status,
          timedOut,
        };
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
        appendRunLogEvent(sink, {
          event: "llm_call",
          agent,
          model,
          promptPath: options.promptPath,
          promptVersion: options.promptVersion,
          promptHash: options.promptHash,
          runId: options.runId,
          invocationId: options.invocationId,
          attempt: options.attempt ?? 1,
          fromCache: options.fromCache ?? false,
          temperature: generateOptions?.temperature ?? 0.7,
          maxTokens: generateOptions?.maxTokens,
          responseFormat: generateOptions?.responseFormat,
          requestBodyBytes,
          requestBody: includeMessages
            ? requestBody
            : {
                _omitted: true,
                messageCount: messages.length,
                requestBodyBytes,
              },
          responseStatus,
          responseId,
          responseBytes,
          responseText: includeMessages ? responseText : undefined,
          messages: includeMessages ? messages : undefined,
          messageCount: messages.length,
          usage: normalizedUsage ?? undefined,
          requestDurationMs: Date.now() - startedAt,
          error: errorPayload,
        });
      }
    },
  };
}
