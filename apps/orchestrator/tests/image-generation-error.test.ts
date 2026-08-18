import { describe, it, expect } from "@jest/globals";
import {
  ImageGenerationProviderError,
  normalizeImageGenerationError,
  isRetryableFailure,
  isRepairCandidate,
  isFatalFailure,
  isImageGenerationProviderError,
  ImageGenerationFailureTypeEnum,
} from "../src/providers/image-generation-error.js";
import { ProviderErrorSchema } from "../src/schemas/production.js";

describe("image-generation-error classification", () => {
  it("classifies policy/prompt rejections as repair candidates, never retryable", () => {
    for (const type of ["content_policy", "invalid_prompt"] as const) {
      expect(isRepairCandidate(type)).toBe(true);
      expect(isRetryableFailure(type)).toBe(false);
      expect(isFatalFailure(type)).toBe(false);
    }
  });

  it("classifies transient failures as retryable, never repair candidates", () => {
    for (const type of ["rate_limit", "timeout", "server_error"] as const) {
      expect(isRetryableFailure(type)).toBe(true);
      expect(isRepairCandidate(type)).toBe(false);
      expect(isFatalFailure(type)).toBe(false);
    }
  });

  it("classifies auth, invalid request, and unknown as fatal infrastructure errors", () => {
    // unknown is fatal: an unclassifiable failure could hide an
    // authentication or infrastructure problem, so it is never routed to an
    // LLM prompt repair.
    for (const type of [
      "authentication",
      "invalid_request",
      "unknown",
    ] as const) {
      expect(isFatalFailure(type)).toBe(true);
      expect(isRetryableFailure(type)).toBe(false);
      expect(isRepairCandidate(type)).toBe(false);
    }
  });

  it("normalizes a provider payload into the full pipeline record", () => {
    const error = normalizeImageGenerationError({
      provider: "gemini",
      model: "gemini-image-model",
      type: "content_policy",
      message: "I can't depict some public figures.",
      originalPrompt: "A reference likeness of a psychologist.",
      sceneId: 6,
    });

    expect(error).toMatchObject({
      provider: "gemini",
      model: "gemini-image-model",
      type: "content_policy",
      message: "I can't depict some public figures.",
      retryable: false,
      originalPrompt: "A reference likeness of a psychologist.",
      sceneId: 6,
    });
    expect(error.timestamp).toBeDefined();
  });

  it("normalizes a provider payload with rawMessage", () => {
    const error = normalizeImageGenerationError({
      provider: "gemini",
      type: "invalid_prompt",
      message: "Couldn't generate an image",
      rawMessage: "We couldn't generate an image for this prompt.",
      originalPrompt: "A map.",
      sceneId: 2,
    });
    expect(error.rawMessage).toBe(
      "We couldn't generate an image for this prompt.",
    );
  });

  it("carries the normalized record on the thrown provider error", () => {
    const info = normalizeImageGenerationError({
      provider: "gemini",
      type: "rate_limit",
      message: "Rate limited.",
      originalPrompt: "A map.",
      sceneId: 2,
    });
    const thrown = new ImageGenerationProviderError(info);

    expect(isImageGenerationProviderError(thrown)).toBe(true);
    expect(thrown.info.type).toBe("rate_limit");
    expect(thrown.info.retryable).toBe(true);
    expect(thrown.message).toBe("Rate limited.");

    expect(isImageGenerationProviderError(new Error("plain"))).toBe(false);
  });

  it("enforces a closed enum for the provider error type", () => {
    // ProviderErrorSchema.type must reject anything outside the failure
    // union, even though the JSON payload is untyped at runtime.
    expect(
      ProviderErrorSchema.safeParse({
        provider: "gemini",
        type: "content_policy",
        message: "blocked",
      }).success,
    ).toBe(true);
    expect(
      ProviderErrorSchema.safeParse({
        provider: "gemini",
        type: "something_else",
        message: "blocked",
      }).success,
    ).toBe(false);
    expect(ImageGenerationFailureTypeEnum.enum).toHaveProperty("unknown");
  });
});
