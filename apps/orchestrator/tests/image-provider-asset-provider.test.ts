import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { PipelineError } from "../src/utils/errors.js";
import { ImageGenerationProviderError } from "../src/providers/image-generation-error.js";

const mockMkdir = jest
  .fn<(...args: any[]) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockReadFile = jest
  .fn<(...args: any[]) => Promise<Buffer>>()
  .mockResolvedValue(Buffer.from("source"));
const mockWriteFile = jest
  .fn<(...args: any[]) => Promise<void>>()
  .mockResolvedValue(undefined);

jest.unstable_mockModule("node:fs/promises", () => ({
  mkdir: mockMkdir,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

const { ImageProviderAssetProvider } =
  await import("../src/providers/image-provider-asset-provider.js");

let fetchSpy: jest.Spied<typeof globalThis.fetch>;

beforeEach(() => {
  mockMkdir.mockClear();
  mockReadFile.mockClear();
  mockWriteFile.mockClear();
  mockWriteFile.mockResolvedValue(undefined);
  fetchSpy = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(jest.fn() as unknown as typeof globalThis.fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function mockImageResponse(
  status: number,
  body: ArrayBuffer,
  contentType: string,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Map([["content-type", contentType]]) as unknown as Headers,
    json: () => Promise.resolve(null),
    arrayBuffer: () => Promise.resolve(body),
  } as Response;
}

describe("ImageProviderAssetProvider", () => {
  const provider = new ImageProviderAssetProvider();

  it("sends prompt to image provider endpoint", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    fetchSpy.mockResolvedValue(mockImageResponse(200, pngBytes, "image/png"));

    await provider.generateImage({
      prompt: "a cat",
      sceneId: 1,
      filename: "scene-001.png",
    });

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

    await provider.generateImage({
      prompt: "a cat",
      sceneId: 1,
      filename: "scene-001.png",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(Object),
      }),
    );
  });

  it("passes reference images to image-provider", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    fetchSpy.mockResolvedValue(mockImageResponse(200, pngBytes, "image/png"));

    await provider.generateImage({
      prompt: "Place subject in a study",
      sceneId: 1,
      filename: "scene-001.png",
      referenceImages: [
        { id: "source-1", path: "/tmp/source-1.png", mimeType: "image/png" },
      ],
      mode: "image_to_image",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8020/generate",
      expect.objectContaining({
        body: JSON.stringify({
          prompt: "Place subject in a study",
          type: "image",
          mode: "image_to_image",
          referenceImages: [
            {
              id: "source-1",
              filename: "source-1.png",
              mime: "image/png",
              base64: Buffer.from("source").toString("base64"),
            },
          ],
        }),
      }),
    );
  });

  it("declares reference capability explicitly", () => {
    expect(provider.capabilities).toEqual({
      referenceImages: true,
      imageEditing: true,
    });
  });

  it("saves image to generated/assets directory", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    fetchSpy.mockResolvedValue(mockImageResponse(200, pngBytes, "image/png"));

    await provider.generateImage({
      prompt: "a cat",
      sceneId: 1,
      filename: "scene-001.png",
    });

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

    const result = await provider.generateImage({
      prompt: "a cat",
      sceneId: 1,
      filename: "scene-001.png",
    });

    expect(result.url).toMatch(/generated\/assets\/scene-001\.png$/);
  });

  it("uses default filename from sceneId when filename not provided", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    fetchSpy.mockResolvedValue(mockImageResponse(200, pngBytes, "image/png"));

    const result = await provider.generateImage({
      prompt: "a cat",
      sceneId: 2,
    });

    expect(result.url).toMatch(/scene-002\.png$/);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("scene-002.png"),
      expect.any(Buffer),
    );
  });

  it("throws ImageGenerationProviderError with unknown type on unparseable error body", async () => {
    fetchSpy.mockResolvedValue(
      mockImageResponse(500, new ArrayBuffer(0), "text/plain"),
    );

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toThrow(ImageGenerationProviderError);
    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toMatchObject({ info: { type: "unknown" } });
  });

  it("propagates the provider's typed error and raw message", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: new Map([
        ["content-type", "application/json"],
      ]) as unknown as Headers,
      json: () =>
        Promise.resolve({
          error: {
            type: "invalid_prompt",
            message: "Couldn't generate an image",
            rawMessage: "We couldn't generate an image for this prompt.",
            provider: "gemini",
            model: "imagen",
          },
        }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as Response);

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toMatchObject({
      info: {
        type: "invalid_prompt",
        message: "Couldn't generate an image",
        rawMessage: "We couldn't generate an image for this prompt.",
      },
    });
  });

  it("downgrades an unrecognized provider error type to unknown (fatal)", async () => {
    // A type the orchestrator does not know must never pass through: an
    // unvalidated string would silently land in the transient-retry branch
    // instead of failing closed.
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Map([
        ["content-type", "application/json"],
      ]) as unknown as Headers,
      json: () =>
        Promise.resolve({
          error: {
            type: "brand_new_failure_mode",
            message: "Something new.",
            provider: "gemini",
          },
        }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as Response);

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toMatchObject({
      info: { type: "unknown", message: "Something new." },
    });
  });

  it("throws PipelineError on non-image content type", async () => {
    fetchSpy.mockResolvedValue(
      mockImageResponse(200, new ArrayBuffer(8), "text/plain"),
    );

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toThrow(PipelineError);
  });

  it("throws PipelineError on empty response body", async () => {
    fetchSpy.mockResolvedValue(
      mockImageResponse(200, new ArrayBuffer(0), "image/png"),
    );

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toThrow(PipelineError);
  });

  it("wraps fetch failure in ImageGenerationProviderError", async () => {
    fetchSpy.mockRejectedValue(new Error("Network failure"));

    await expect(
      provider.generateImage({ prompt: "a cat", sceneId: 1 }),
    ).rejects.toThrow(ImageGenerationProviderError);
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
