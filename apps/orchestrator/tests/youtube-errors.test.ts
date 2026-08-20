import { describe, it, expect } from "@jest/globals";
import {
  PublishError,
  mapYouTubeError,
} from "../src/providers/publisher/youtube/youtube-errors.js";

describe("mapYouTubeError", () => {
  it("classifies rate limits as retryable", () => {
    const info = mapYouTubeError({ code: 429, message: "Too many requests" });
    expect(info).toMatchObject({ code: "rate_limit", retryable: true });
  });

  it("classifies rate-limit reasons from the errors array", () => {
    const info = mapYouTubeError({
      errors: [{ reason: "rateLimitExceeded", message: "Slow down" }],
    });
    expect(info).toMatchObject({ code: "rate_limit", retryable: true });
  });

  it("classifies 5xx as retryable backend errors", () => {
    expect(mapYouTubeError({ code: 500 })).toMatchObject({
      code: "backend_error",
      retryable: true,
    });
    expect(mapYouTubeError({ code: 503 })).toMatchObject({
      code: "backend_error",
      retryable: true,
    });
  });

  it("classifies network errors as retryable", () => {
    expect(mapYouTubeError({ code: "ECONNRESET" })).toMatchObject({
      code: "network_error",
      retryable: true,
    });
  });

  it("classifies quota exceeded as non-retryable", () => {
    expect(
      mapYouTubeError({ code: 403, errors: [{ reason: "quotaExceeded" }] }),
    ).toMatchObject({ code: "quota_exceeded", retryable: false });
  });

  it("classifies generic 403 as non-retryable forbidden", () => {
    expect(mapYouTubeError({ code: 403 })).toMatchObject({
      code: "forbidden",
      retryable: false,
    });
  });

  it("classifies 401 as non-retryable auth error", () => {
    expect(mapYouTubeError({ code: 401 })).toMatchObject({
      code: "auth_error",
      retryable: false,
    });
  });

  it("classifies 400 as non-retryable invalid request", () => {
    expect(mapYouTubeError({ code: 400 })).toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
  });

  it("treats 404 as non-retryable", () => {
    expect(mapYouTubeError({ code: 404 })).toMatchObject({
      code: "not_found",
      retryable: false,
    });
  });

  it("uses the most specific message available", () => {
    const info = mapYouTubeError({
      code: 400,
      errors: [{ reason: "invalidMetadata", message: "Bad title" }],
      message: "Fallback",
    });
    expect(info.message).toBe("Bad title");
  });

  it("wraps unknown failures without retrying", () => {
    const info = mapYouTubeError(new Error("boom"));
    expect(info).toMatchObject({ code: "unknown", retryable: false });
    expect(info.message).toBe("boom");
  });

  it("PublishError carries its taxonomy", () => {
    const err = new PublishError({
      code: "auth_error",
      message: "nope",
      retryable: false,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.info).toMatchObject({ code: "auth_error", retryable: false });
  });
});
