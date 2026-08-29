import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { PexelsSourceAssetProvider } from "../src/providers/pexels-source-asset-provider.js";
import type { RunLogSink } from "../src/utils/run-log.js";

const originalFetch = globalThis.fetch;

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Map() as unknown as Headers,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.reject(new Error("Unexpected arrayBuffer")),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

class CapturingSink implements RunLogSink {
  readonly runId = "capture";
  readonly filePath = "/tmp/never-written";
  events: unknown[] = [];
  appendLine(event: unknown): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("PexelsSourceAssetProvider run-log capture", () => {
  let fetchSpy: jest.Spied<typeof globalThis.fetch>;
  let sink: CapturingSink;

  beforeEach(() => {
    sink = new CapturingSink();
    fetchSpy = jest.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("emits a provider_call event with sanitized auth header and response body", async () => {
    fetchSpy.mockResolvedValue(
      makeJsonResponse(200, {
        total_results: 0,
        page: 1,
        per_page: 12,
        photos: [],
      }),
    );

    const provider = new PexelsSourceAssetProvider("test-key");
    await provider.search({ type: "person", name: "Ada" }, "Ada", undefined, {
      sink,
      runId: "capture",
    });

    const providerCalls = sink.events.filter(
      (e) => (e as { event: string }).event === "provider_call",
    );
    expect(providerCalls).toHaveLength(1);
    const evt = providerCalls[0] as Record<string, unknown>;
    expect(evt.provider).toBe("pexels");
    expect(evt.operation).toBe("photo_search");
    expect((evt.headers as Record<string, string>).Authorization).toBe("***");
    expect(evt.responseStatus).toBe(200);
    expect((evt.responseBody as { total_results: number }).total_results).toBe(
      0,
    );
    expect(evt.requestDurationMs).toBeGreaterThanOrEqual(0);
    expect(evt.error).toBeUndefined();
  });

  it("captures the error and rethrows on a failed response", async () => {
    fetchSpy.mockResolvedValue(makeJsonResponse(500, { error: "boom" }));
    const provider = new PexelsSourceAssetProvider("test-key");
    await expect(
      provider.search({ type: "person", name: "Ada" }, "Ada", undefined, {
        sink,
        runId: "capture",
      }),
    ).rejects.toThrow();

    const providerCalls = sink.events.filter(
      (e) => (e as { event: string }).event === "provider_call",
    );
    expect(providerCalls).toHaveLength(1);
    const evt = providerCalls[0] as Record<string, unknown>;
    expect(evt.error).toBeDefined();
  });
});
