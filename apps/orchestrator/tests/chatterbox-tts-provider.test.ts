import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { PipelineError } from "../src/utils/errors.js";

const mockMkdir = jest
  .fn<(...args: any[]) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockWriteFile = jest
  .fn<(...args: any[]) => Promise<void>>()
  .mockResolvedValue(undefined);

// Create a valid WAV Buffer with actual audio data for testing
function makeValidWavBuffer(
  sampleRate = 44100,
  bitsPerSample = 16,
  durationMs = 2000,
): Buffer {
  const channels = 1;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * channels * bytesPerSample;
  const fileSize = 36 + dataSize;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(fileSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // Fill data section with silence (zeros) - already zeroed by Buffer.alloc
  return buf;
}

const mockReadFile = jest
  .fn<(...args: any[]) => Promise<Buffer>>()
  .mockImplementation((path) => {
    // Return valid WAV buffer for temp files (after ffmpeg normalization)
    if (typeof path === "string" && path.includes(".speed.wav")) {
      return Promise.resolve(makeValidWavBuffer());
    }
    return Promise.resolve(Buffer.alloc(0));
  });
const mockRename = jest
  .fn<(...args: any[]) => Promise<void>>()
  .mockResolvedValue(undefined);
const mockRm = jest
  .fn<(...args: any[]) => Promise<void>>()
  .mockResolvedValue(undefined);

jest.unstable_mockModule("../src/providers/composer/ffmpeg/ffmpeg.js", () => ({
  runFfmpeg: jest.fn(() => Promise.resolve()),
  runFfmpegWithRetry: jest.fn(() => Promise.resolve()),
}));

jest.unstable_mockModule("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  rename: mockRename,
  rm: mockRm,
}));

const { ChatterboxTTSProvider } =
  await import("../src/providers/chatterbox-tts-provider.js");

let fetchSpy: jest.Spied<typeof globalThis.fetch>;

function makeWavBytes(
  sampleRate: number,
  bitsPerSample: number,
  durationMs: number,
  format: number = 1,
): ArrayBuffer {
  const channels = 1;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * channels * bytesPerSample;
  const fileSize = 36 + dataSize;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };

  w(0, "RIFF");
  v.setUint32(4, fileSize, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, format, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytesPerSample, true);
  v.setUint16(32, channels * bytesPerSample, true);
  v.setUint16(34, bitsPerSample, true);
  w(36, "data");
  v.setUint32(40, dataSize, true);

  return buf;
}

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Map() as unknown as Headers,
    json: () => Promise.resolve(body),
    arrayBuffer: () =>
      Promise.reject(new Error("Unexpected arrayBuffer on JSON response")),
  } as Response;
}

function makeBinaryResponse(status: number, body: ArrayBuffer): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Map() as unknown as Headers,
    json: () => Promise.reject(new Error("Unexpected json on binary response")),
    arrayBuffer: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  mockMkdir.mockClear();
  mockWriteFile.mockClear();
  mockWriteFile.mockResolvedValue(undefined);
  fetchSpy = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(jest.fn() as unknown as typeof globalThis.fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("ChatterboxTTSProvider", () => {
  const provider = new ChatterboxTTSProvider();

  it("cacheFingerprint includes the chatterbox endpoint and targetWpm", async () => {
    const prev = process.env.TTS_URL;
    process.env.TTS_URL = "http://localhost:8010";
    try {
      // Format: chatterbox-http-<version>:<url>:targetWpm=<wpm>
      expect(provider.cacheFingerprint()).toMatch(
        /^chatterbox-http-v3:http:\/\/localhost:8010:targetWpm=\d+$/,
      );
    } finally {
      if (prev === undefined) delete process.env.TTS_URL;
      else process.env.TTS_URL = prev;
    }
  });

  it("cacheFingerprint changes when the endpoint changes", async () => {
    const prev = process.env.TTS_URL;
    process.env.TTS_URL = "http://localhost:8010";
    try {
      const first = provider.cacheFingerprint();

      process.env.TTS_URL = "http://tts-staging.example:9000";
      const second = provider.cacheFingerprint();

      expect(first).toMatch(
        /^chatterbox-http-v3:http:\/\/localhost:8010:targetWpm=\d+$/,
      );
      expect(second).toMatch(
        /^chatterbox-http-v3:http:\/\/tts-staging.example:9000:targetWpm=\d+$/,
      );
      expect(second).not.toBe(first);
    } finally {
      if (prev === undefined) delete process.env.TTS_URL;
      else process.env.TTS_URL = prev;
    }
  });

  it("sends text to chatterbox endpoint", async () => {
    const wav = makeWavBytes(44100, 16, 1000);
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          status: "success",
          file: "abc123.wav",
          url: "/audio/abc123.wav",
        }),
      )
      .mockResolvedValueOnce(makeBinaryResponse(200, wav));

    await provider.synthesize({ text: "Hello world", voice: "narrator" });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "http://localhost:8010/generate",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello world", voice: "narrator" }),
      }),
    );
  });

  it("downloads audio and saves to generated/audio directory", async () => {
    const wav = makeWavBytes(44100, 16, 1000);
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          status: "success",
          file: "abc123.wav",
          url: "/audio/abc123.wav",
        }),
      )
      .mockResolvedValueOnce(makeBinaryResponse(200, wav));

    await provider.synthesize({ text: "Hello world" });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8010/audio/abc123.wav",
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining("generated/audio"),
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("abc123.wav"),
      expect.any(Buffer),
    );
  });

  it("returns local file path and parsed WAV duration", async () => {
    const wav = makeWavBytes(44100, 16, 2000);
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          status: "success",
          file: "abc123.wav",
          url: "/audio/abc123.wav",
        }),
      )
      .mockResolvedValueOnce(makeBinaryResponse(200, wav));

    const result = await provider.synthesize({ text: "Hello world" });

    expect(result.audioUrl).toMatch(/generated\/audio\/abc123\.wav$/);
    expect(result.durationMs).toBe(2000);
  });

  it("parses IEEE float32 WAV duration from header", async () => {
    const wav = makeWavBytes(24000, 32, 57840, 3);
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          status: "success",
          file: "float.wav",
          url: "/audio/float.wav",
        }),
      )
      .mockResolvedValueOnce(makeBinaryResponse(200, wav));

    // Disable WPM normalization to test raw duration parsing
    const prevTargetWpm = process.env.NARRATION_TARGET_WPM;
    process.env.NARRATION_TARGET_WPM = "";
    try {
      const result = await provider.synthesize({ text: "Hello world" });
      expect(result.durationMs).toBe(57840);
    } finally {
      if (prevTargetWpm === undefined) delete process.env.NARRATION_TARGET_WPM;
      else process.env.NARRATION_TARGET_WPM = prevTargetWpm;
    }
  });

  it("falls back for unsupported WAV compression formats", async () => {
    const wav = makeWavBytes(24000, 32, 57840, 6);
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          status: "success",
          file: "alaw.wav",
          url: "/audio/alaw.wav",
        }),
      )
      .mockResolvedValueOnce(makeBinaryResponse(200, wav));

    const result = await provider.synthesize({ text: "Hello world" });

    expect(result.durationMs).not.toBe(57840);
  });

  it("uses filename from opts when provided", async () => {
    const wav = makeWavBytes(44100, 16, 1000);
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          status: "success",
          file: "abc123.wav",
          url: "/audio/abc123.wav",
        }),
      )
      .mockResolvedValueOnce(makeBinaryResponse(200, wav));

    const result = await provider.synthesize({
      text: "Hello",
      filename: "narration.wav",
    });

    expect(result.audioUrl).toMatch(/narration\.wav$/);
  });

  it("includes AbortSignal in both fetch calls", async () => {
    const wav = makeWavBytes(44100, 16, 1000);
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          status: "success",
          file: "x.wav",
          url: "/audio/x.wav",
        }),
      )
      .mockResolvedValueOnce(makeBinaryResponse(200, wav));

    await provider.synthesize({ text: "Hello" });

    const [, opts1] = fetchSpy.mock.calls[0];
    const [, opts2] = fetchSpy.mock.calls[1];
    expect(opts1).toHaveProperty("signal");
    expect(opts2).toHaveProperty("signal");
  });

  it("throws PipelineError on non-200 from generate", async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse(500, { status: "error" }));

    await expect(provider.synthesize({ text: "Hello" })).rejects.toThrow(
      PipelineError,
    );
  });

  it("throws PipelineError on non-200 from audio download", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          status: "success",
          file: "x.wav",
          url: "/audio/x.wav",
        }),
      )
      .mockResolvedValueOnce(makeBinaryResponse(404, new ArrayBuffer(0)));

    await expect(provider.synthesize({ text: "Hello" })).rejects.toThrow(
      PipelineError,
    );
  });

  it("throws PipelineError on invalid JSON", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map() as unknown as Headers,
      json: () => Promise.reject(new Error("Invalid JSON")),
      arrayBuffer: () => Promise.reject(new Error("Unexpected")),
    } as Response);

    await expect(provider.synthesize({ text: "Hello" })).rejects.toThrow(
      PipelineError,
    );
  });

  it("throws PipelineError when status is not success", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse(200, { status: "error", file: "", url: "" }),
    );

    await expect(provider.synthesize({ text: "Hello" })).rejects.toThrow(
      PipelineError,
    );
  });

  it("wraps fetch failure in PipelineError", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

    await expect(provider.synthesize({ text: "Hello" })).rejects.toThrow(
      PipelineError,
    );
  });

  it("wraps write failure in PipelineError", async () => {
    const wav = makeWavBytes(44100, 16, 1000);
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          status: "success",
          file: "x.wav",
          url: "/audio/x.wav",
        }),
      )
      .mockResolvedValueOnce(makeBinaryResponse(200, wav));
    mockWriteFile.mockReset();
    mockWriteFile.mockRejectedValueOnce(new Error("Disk full"));

    await expect(provider.synthesize({ text: "Hello" })).rejects.toThrow(
      PipelineError,
    );
  });

  it("throws PipelineError on empty audio response", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          status: "success",
          file: "x.wav",
          url: "/audio/x.wav",
        }),
      )
      .mockResolvedValueOnce(makeBinaryResponse(200, new ArrayBuffer(0)));

    await expect(provider.synthesize({ text: "Hello" })).rejects.toThrow(
      PipelineError,
    );
  });
});
