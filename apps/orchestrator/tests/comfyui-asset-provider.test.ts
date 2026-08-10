import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { PipelineError } from "../src/utils/errors.js";

const mockMkdir = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
const mockWriteFile = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
}));

const { ComfyUIAssetProvider } = await import("../src/providers/comfyui-asset-provider.js");

let fetchSpy: jest.Spied<typeof globalThis.fetch>;

beforeEach(() => {
  mockMkdir.mockClear();
  mockWriteFile.mockClear();
  mockWriteFile.mockResolvedValue(undefined);
  fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(
    jest.fn() as unknown as typeof globalThis.fetch,
  );
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function mockImageResponse(status: number, body: ArrayBuffer, contentType: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Map([["content-type", contentType]]) as unknown as Headers,
    arrayBuffer: () => Promise.resolve(body),
  } as Response;
}

describe("ComfyUIAssetProvider", () => {
  const provider = new ComfyUIAssetProvider();

  it("sends prompt to image provider endpoint", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    fetchSpy.mockResolvedValue(mockImageResponse(200, pngBytes, "image/png"));

    await provider.generateImage({ prompt: "a cat", sceneId: 1, filename: "scene-001.png" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8020/generate",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "a cat" }),
      }),
    );
  });

  it("includes AbortSignal in fetch call", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    fetchSpy.mockResolvedValue(mockImageResponse(200, pngBytes, "image/png"));

    await provider.generateImage({ prompt: "a cat", sceneId: 1, filename: "scene-001.png" });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(Object),
      }),
    );
  });

  it("saves image to generated/assets directory", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    fetchSpy.mockResolvedValue(mockImageResponse(200, pngBytes, "image/png"));

    await provider.generateImage({ prompt: "a cat", sceneId: 1, filename: "scene-001.png" });

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining("generated/assets"),
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("scene-001.png"),
      expect.any(Buffer),
    );
  });

  it("returns file path in result url", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    fetchSpy.mockResolvedValue(mockImageResponse(200, pngBytes, "image/png"));

    const result = await provider.generateImage({ prompt: "a cat", sceneId: 1, filename: "scene-001.png" });

    expect(result.url).toMatch(/generated\/assets\/scene-001\.png$/);
  });

  it("uses default filename from sceneId when filename not provided", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    fetchSpy.mockResolvedValue(mockImageResponse(200, pngBytes, "image/png"));

    const result = await provider.generateImage({ prompt: "a cat", sceneId: 2 });

    expect(result.url).toMatch(/scene-002\.png$/);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("scene-002.png"),
      expect.any(Buffer),
    );
  });

  it("throws PipelineError on non-200 response", async () => {
    fetchSpy.mockResolvedValue(mockImageResponse(500, new ArrayBuffer(0), "text/plain"));

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toThrow(PipelineError);
  });

  it("throws PipelineError on non-image content type", async () => {
    fetchSpy.mockResolvedValue(mockImageResponse(200, new ArrayBuffer(8), "text/plain"));

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toThrow(PipelineError);
  });

  it("throws PipelineError on empty response body", async () => {
    fetchSpy.mockResolvedValue(mockImageResponse(200, new ArrayBuffer(0), "image/png"));

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toThrow(PipelineError);
  });

  it("wraps fetch failure in PipelineError", async () => {
    fetchSpy.mockRejectedValue(new Error("Network failure"));

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toThrow(PipelineError);
  });

  it("wraps write failure in PipelineError", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    fetchSpy.mockResolvedValue(mockImageResponse(200, pngBytes, "image/png"));
    mockWriteFile.mockReset();
    mockWriteFile.mockRejectedValueOnce(new Error("Disk full"));

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toThrow(PipelineError);
  });

  it("throws PipelineError for generateVideo", async () => {
    await expect(
      provider.generateVideo({ prompt: "a video", sceneId: 1 }),
    ).rejects.toThrow(PipelineError);
  });
});
