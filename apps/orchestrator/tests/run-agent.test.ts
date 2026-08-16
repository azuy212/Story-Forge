import { describe, it, expect } from "@jest/globals";
import { buildRetryFeedback, classifyError } from "../src/agents/run-agent.js";

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
