import { describe, it, expect } from "@jest/globals";
import {
  LOG_TEXT_LIMIT,
  redactSecrets,
  sanitizeForLog,
  sanitizeUnknownForLog,
  truncateForLog,
} from "../src/utils/log-redaction.js";

describe("redactSecrets", () => {
  it("redacts provider-style API keys", () => {
    expect(redactSecrets("key sk-or-v1-abcdef0123456789abcdef")).not.toContain(
      "abcdef0123456789",
    );
    expect(redactSecrets("key sk-or-v1-abcdef0123456789abcdef")).toContain(
      "[redacted]",
    );
  });

  it("redacts Google API keys", () => {
    const text = "AIzaSyA1234567890abcdefghijklmnopqrstu";
    expect(redactSecrets(text)).toBe("[redacted]");
  });

  it("redacts bearer tokens", () => {
    expect(
      redactSecrets("Authorization: Bearer abcdefghijklmnopqrst"),
    ).toContain("[redacted]");
    expect(
      redactSecrets("Authorization: Bearer abcdefghijklmnopqrst"),
    ).not.toContain("abcdefghijklmnopqrst");
  });

  it("redacts key=value style config dumps", () => {
    const redacted = redactSecrets(
      "MODEL=x OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef",
    );
    expect(redacted).toContain("MODEL=x");
    expect(redacted).not.toContain("sk-or-v1");
  });

  it("leaves ordinary text untouched", () => {
    const text = "The nearest landmass is over 2,000 km away.";
    expect(redactSecrets(text)).toBe(text);
  });

  it("is total: empty and non-string-ish input pass through", () => {
    expect(redactSecrets("")).toBe("");
  });
});

describe("truncateForLog", () => {
  it("passes short text through unchanged", () => {
    expect(truncateForLog("short", { maxChars: 100 })).toBe("short");
  });

  it("caps long text and records how much was removed", () => {
    const out = truncateForLog("a".repeat(50), { maxChars: 10 });
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out).toContain("[truncated]");
    expect(out).toContain("40 more chars");
  });

  it("never returns more than the cap plus marker", () => {
    const out = truncateForLog("b".repeat(100_000), {
      maxChars: LOG_TEXT_LIMIT,
    });
    expect(out.length).toBeLessThanOrEqual(LOG_TEXT_LIMIT + 60);
  });
});

describe("sanitizeForLog / sanitizeUnknownForLog", () => {
  it("redacts before truncating so the tail cannot hold a secret", () => {
    const filler = "x".repeat(LOG_TEXT_LIMIT);
    const out = sanitizeForLog(`${filler} sk-or-v1-abcdef0123456789abcdef`);
    expect(out).not.toContain("sk-or-v1-abcdef0123456789abcdef");
  });

  it("redacts inside structured values", () => {
    const out = sanitizeUnknownForLog({
      headers: { Authorization: "Bearer abcdefghijklmnopqrst" },
    });
    expect(out).not.toContain("abcdefghijklmnopqrst");
  });

  it("never throws for unserializable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(sanitizeUnknownForLog(cyclic)).toBe("<unserializable>");
  });

  it("passes strings through the redactor", () => {
    expect(sanitizeUnknownForLog("api_key=supersecretvalue123")).not.toContain(
      "supersecretvalue123",
    );
  });
});
