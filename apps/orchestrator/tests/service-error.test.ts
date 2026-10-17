import { describe, it, expect } from "@jest/globals";
import {
  describeServiceFailure,
  parseServiceErrorEnvelope,
  readServiceError,
} from "../src/providers/service-error.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 500,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("parseServiceErrorEnvelope", () => {
  it("reads the shared TTS/transcriber envelope", () => {
    const parsed = parseServiceErrorEnvelope({
      error: { code: "ENGINE_BUSY", message: "busy", requestId: "abc123" },
    });
    expect(parsed).toEqual({
      code: "ENGINE_BUSY",
      message: "busy",
      requestId: "abc123",
      details: { code: "ENGINE_BUSY", message: "busy", requestId: "abc123" },
    });
  });

  it("accepts `type` as the code alias (image-provider shape)", () => {
    const parsed = parseServiceErrorEnvelope({
      error: {
        type: "content_policy",
        message: "policy blocked",
        requestId: "def456",
        retryable: false,
      },
    });
    expect(parsed?.code).toBe("content_policy");
    expect(parsed?.requestId).toBe("def456");
    expect(parsed?.details?.retryable).toBe(false);
  });

  it("keeps service-specific details for the consumer", () => {
    const parsed = parseServiceErrorEnvelope({
      error: { code: "X", message: "m", provider: "gemini", model: "g1" },
    });
    expect(parsed?.details?.provider).toBe("gemini");
    expect(parsed?.details?.model).toBe("g1");
  });

  it("returns null when the body is not the envelope", () => {
    expect(parseServiceErrorEnvelope(null)).toBeNull();
    expect(parseServiceErrorEnvelope({})).toBeNull();
    expect(parseServiceErrorEnvelope({ error: null })).toBeNull();
    expect(
      parseServiceErrorEnvelope({ detail: "plain fastapi error" }),
    ).toBeNull();
    expect(parseServiceErrorEnvelope("a string")).toBeNull();
  });

  it("falls back to UNKNOWN when only a message is present", () => {
    const parsed = parseServiceErrorEnvelope({ error: { message: "failed" } });
    expect(parsed?.code).toBe("UNKNOWN");
    expect(parsed?.message).toBe("failed");
  });

  it("ignores blank codes and messages", () => {
    expect(parseServiceErrorEnvelope({ error: { code: "  " } })).toBeNull();
    expect(parseServiceErrorEnvelope({ error: { code: 5 } })).toBeNull();
  });
});

describe("readServiceError", () => {
  it("parses a JSON error body", async () => {
    const error = await readServiceError(
      jsonResponse({ error: { code: "ENGINE_FAILURE", message: "failed" } }),
    );
    expect(error?.code).toBe("ENGINE_FAILURE");
  });

  it("returns null for non-JSON bodies", async () => {
    const response = new Response("<html>oops</html>", { status: 502 });
    expect(await readServiceError(response)).toBeNull();
  });
});

describe("describeServiceFailure", () => {
  it("prefers the service code and message over the HTTP status", () => {
    expect(
      describeServiceFailure(
        "TTS synthesis failed",
        {
          code: "ENGINE_FAILURE",
          message: "TTS generation failed.",
          requestId: "0f3c1d9b",
        },
        "HTTP 503",
      ),
    ).toBe(
      "TTS synthesis failed [ENGINE_FAILURE]: TTS generation failed. (requestId 0f3c1d9b)",
    );
  });

  it("omits the request id when the service did not send one", () => {
    expect(
      describeServiceFailure(
        "WhisperX alignment failed",
        { code: "TIMEOUT", message: "timed out" },
        "HTTP 504",
      ),
    ).toBe("WhisperX alignment failed [TIMEOUT]: timed out");
  });

  it("falls back to the HTTP status for a non-envelope body", () => {
    expect(
      describeServiceFailure("TTS synthesis failed", null, "HTTP 500 Internal"),
    ).toBe("TTS synthesis failed: HTTP 500 Internal");
  });
});
