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
  // ResolveProfile is non-LLM (deterministic) — see resolve-profile.node.ts.
  // Listed here for type completeness; never resolves to a real model.
  [AgentModel.ResolveProfile]: "SYSTEM",
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
  /** Test seam: inject an OpenAI client instead of the shared singleton. */
  client?: OpenAI;
}

export type StreamedLlmResponse = {
  text: string;
  id?: string;
  model?: string;
  usage?: unknown;
};

export type LlmStreamTimeoutOptions = {
  firstTokenTimeoutMs: number;
  streamInactivityTimeoutMs: number;
};

type TimeoutPhase = "firstToken" | "inactivity";

function timeoutMessage(
  phase: TimeoutPhase,
  timeouts: LlmStreamTimeoutOptions,
): string {
  if (phase === "firstToken") {
    return `Model request timed out waiting for first token after ${timeouts.firstTokenTimeoutMs}ms`;
  }
  return `Model stream stalled after ${timeouts.streamInactivityTimeoutMs}ms without stream data`;
}

/**
 * Consume a streamed chat-completions response with two-phase timeout handling:
 * a first-token timer that aborts if no chunk arrives, and an inactivity timer
 * that resets on every chunk so a live stream can run as long as needed. No
 * absolute cap is imposed on total generation length.
 */
export async function generateWithStreamTimeouts(
  createStream: (
    signal: AbortSignal,
  ) => Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>,
  timeouts: LlmStreamTimeoutOptions,
): Promise<StreamedLlmResponse> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutPhase: TimeoutPhase = "firstToken";
  let firstTokenTimer: NodeJS.Timeout | undefined;
  let inactivityTimer: NodeJS.Timeout | undefined;

  const clearTimers = (): void => {
    if (firstTokenTimer !== undefined) clearTimeout(firstTokenTimer);
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    firstTokenTimer = inactivityTimer = undefined;
  };

  const abortOnTimeout = (phase: TimeoutPhase): void => {
    timedOut = true;
    timeoutPhase = phase;
    controller.abort();
  };

  try {
    firstTokenTimer = setTimeout(
      () => abortOnTimeout("firstToken"),
      timeouts.firstTokenTimeoutMs,
    );

    const stream = await createStream(controller.signal);

    let text = "";
    let id: string | undefined;
    let streamModel: string | undefined;
    let usage: unknown;

    for await (const chunk of stream) {
      if (firstTokenTimer !== undefined) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = undefined;
      }
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => abortOnTimeout("inactivity"),
        timeouts.streamInactivityTimeoutMs,
      );

      id ??= chunk.id;
      streamModel ??= chunk.model;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
      if (chunk.usage) usage = chunk.usage;
    }

    return { text, id, model: streamModel, usage };
  } catch (err) {
    if (timedOut) {
      const timeoutError = new Error(timeoutMessage(timeoutPhase, timeouts));
      timeoutError.name = "TimeoutError";
      (timeoutError as Error & { cause?: unknown }).cause = err;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimers();
  }
}

export function createModel(
  agent: AgentModel,
  options: CreateModelOptions = {},
) {
  const client = options.client ?? getClient();
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
      const firstTokenTimeoutMs = config.llmFirstTokenTimeoutMs();
      const streamInactivityTimeoutMs = config.llmStreamInactivityTimeoutMs();

      const startedAt = Date.now();
      const requestBody: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        model,
        messages,
        temperature: generateOptions?.temperature ?? 0.7,
        max_tokens: generateOptions?.maxTokens,
        response_format: generateOptions?.responseFormat,
        stream: true,
        stream_options: { include_usage: true },
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
        const {
          text,
          id,
          model: responseModel,
          usage,
        } = await generateWithStreamTimeouts(
          (signal) => client.chat.completions.create(requestBody, { signal }),
          {
            firstTokenTimeoutMs,
            streamInactivityTimeoutMs,
          },
        );
        responseStatus = 200;
        responseId = id;
        responseText = text;
        responseBytes = Buffer.byteLength(responseText, "utf-8");
        normalizedUsage = normalizeUsage(usage, {
          model: responseModel ?? model,
          requestId: id,
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
        const isTimeout =
          typeof err === "object" &&
          err !== null &&
          "name" in err &&
          (err as { name?: unknown }).name === "TimeoutError";
        responseStatus = typeof status === "number" ? status : undefined;
        errorPayload = {
          name: (err as Error)?.name,
          message: (err as Error)?.message ?? String(err),
          status,
          timedOut: isTimeout,
        };
        throw err;
      } finally {
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
