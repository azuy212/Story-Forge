import { describe, it, expect } from "@jest/globals";
import { z } from "zod";
import {
  buildRetryFeedback,
  classifyError,
  runAgent,
  type AgentInject,
} from "../src/agents/run-agent.js";
import type { createModel } from "../src/models/model-factory.js";
import { AgentModel } from "../src/models/agent-model.js";

describe("classifyError", () => {
  it("classifies model timeout as retryable timeout", () => {
    const error = new Error("request timed out");
    error.name = "TimeoutError";

    expect(classifyError(error, error.message)).toBe("timeout");
  });

  it("classifies external abort as permanent", () => {
    const error = new Error("request aborted");
    error.name = "AbortError";

    expect(classifyError(error, error.message)).toBe("permanent");
  });

  it.each([401, 403, 404, 422])("classifies HTTP %s as permanent", (status) => {
    expect(classifyError({ status }, `HTTP ${status}`)).toBe("permanent");
  });

  it.each([429, 500, 503])("classifies HTTP %s as transient", (status) => {
    expect(classifyError({ status }, `HTTP ${status}`)).toBe("transient");
  });

  it("keeps bare non-empty errors transient", () => {
    expect(classifyError(new Error("socket reset"), "socket reset")).toBe(
      "transient",
    );
  });

  it("classifies parse and schema failures before transport status", () => {
    expect(
      classifyError({ status: 500 }, "Invalid JSON in model response"),
    ).toBe("parse");
    expect(
      classifyError(
        { status: 500 },
        "Schema validation failed: title: Required",
      ),
    ).toBe("schema");
  });
});

describe("buildRetryFeedback", () => {
  it("attaches the rejected raw output verbatim", () => {
    const feedback = buildRetryFeedback(
      "Invalid JSON in model response",
      '{"broken":',
    );
    expect(feedback).toContain("Invalid JSON in model response");
    expect(feedback).toContain('Previous response:\n"""\n{"broken":\n"""');
    expect(feedback).toContain("Return ONLY corrected valid JSON");
  });

  it("attaches raw output for schema validation failures", () => {
    const feedback = buildRetryFeedback(
      "Schema validation failed: title: Required",
      '{"title":123}',
    );
    expect(feedback).toContain("Schema validation failed: title: Required");
    expect(feedback).toContain('{"title":123}');
  });

  it("omits the previous response block when no raw content is available", () => {
    const feedback = buildRetryFeedback("OpenRouter timeout", undefined);
    expect(feedback).toContain("OpenRouter timeout");
    expect(feedback).not.toContain("Previous response:");
    expect(feedback).toContain("Return ONLY corrected valid JSON");
  });

  it("omits the previous response block for empty raw content", () => {
    const feedback = buildRetryFeedback("Invalid JSON in model response", "");
    expect(feedback).not.toContain("Previous response:");
  });
});

describe("runAgent rejected payload passthrough", () => {
  const schema = z.object({ title: z.string().min(1) });

  function inject(
    generate: () => Promise<{ output: string; usage?: unknown }>,
  ): AgentInject {
    return {
      createModel: () =>
        ({
          model: "test-model",
          generate: async () => generate(),
        }) as unknown as ReturnType<typeof createModel>,
      loadPrompt: async (path: string) =>
        path.includes("editorial-guidelines")
          ? "Guidelines."
          : "Write JSON.\n---\nGo.",
    };
  }

  it("returns the parsed payload alongside the schema error", async () => {
    const payload = { title: 123, extra: "kept" };
    const result = await runAgent({
      agent: AgentModel.VisualDirector,
      promptPath: "visual-director/v1.md",
      schema,
      variables: {},
      maxRetries: 2,
      inject: inject(async () => ({
        output: JSON.stringify(payload),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      })),
    });

    expect(result.data).toBeNull();
    expect(result.error).toContain("Schema validation failed");
    // The caller needs the value to attempt a lenient recovery.
    expect(result.rejected).toEqual(payload);
  });

  it("returns the most recent rejected payload, not the first", async () => {
    const payloads = [{ title: "ok" }, { title: "also-ok-but-rejected", n: 2 }];
    let call = 0;
    const result = await runAgent({
      agent: AgentModel.VisualDirector,
      promptPath: "visual-director/v1.md",
      // `required` is absent from both payloads, so every attempt is rejected.
      schema: z.object({ title: z.string(), required: z.string() }),
      variables: {},
      maxRetries: 2,
      inject: inject(async () => ({
        output: JSON.stringify(payloads[call++]),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      })),
    });

    expect(result.data).toBeNull();
    expect(result.rejected).toEqual({ title: "also-ok-but-rejected", n: 2 });
  });

  it("leaves rejected undefined when no attempt parsed as JSON", async () => {
    const result = await runAgent({
      agent: AgentModel.VisualDirector,
      promptPath: "visual-director/v1.md",
      schema,
      variables: {},
      maxRetries: 1,
      inject: inject(async () => ({
        output: "definitely not json",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      })),
    });

    expect(result.data).toBeNull();
    expect(result.error).toContain("Invalid JSON");
    expect(result.rejected).toBeUndefined();
  });

  it("leaves rejected undefined on a transport failure", async () => {
    const result = await runAgent({
      agent: AgentModel.VisualDirector,
      promptPath: "visual-director/v1.md",
      schema,
      variables: {},
      maxRetries: 1,
      inject: {
        createModel: () =>
          ({
            model: "test-model",
            generate: async () => {
              throw Object.assign(new Error("nope"), { status: 401 });
            },
          }) as unknown as ReturnType<typeof createModel>,
        loadPrompt: async () => "Write JSON.",
      },
    });

    expect(result.data).toBeNull();
    expect(result.error).toBe("nope");
    expect(result.rejected).toBeUndefined();
  });

  it("does not attach rejected on success", async () => {
    const result = await runAgent({
      agent: AgentModel.VisualDirector,
      promptPath: "visual-director/v1.md",
      schema,
      variables: {},
      maxRetries: 1,
      inject: inject(async () => ({
        output: JSON.stringify({ title: "fine" }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      })),
    });

    expect(result.data).toEqual({ title: "fine" });
    expect(result.error).toBeUndefined();
    expect(result.rejected).toBeUndefined();
  });
});
