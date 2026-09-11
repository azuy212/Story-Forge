import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { PipelineError } from "../src/utils/errors.js";

const mockMkdir = jest.fn<(...args: any[]) => Promise<any>>();
const mockWriteFile = jest.fn<(...args: any[]) => Promise<any>>();
const mockRename = jest.fn<(...args: any[]) => Promise<any>>();
const mockRm = jest.fn<(...args: any[]) => Promise<any>>();
const mockReadFile = jest.fn<(...args: any[]) => Promise<any>>();
const mockAppendFile = jest.fn<(...args: any[]) => Promise<any>>();
const mockStat = jest.fn<(...args: any[]) => Promise<any>>();

const writtenFiles: Record<string, Buffer> = {};

jest.unstable_mockModule("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  rename: mockRename,
  rm: mockRm,
  readFile: mockReadFile,
  appendFile: mockAppendFile,
  stat: mockStat,
}));

const mockProbe = jest.fn<(...args: any[]) => Promise<any>>();
const mockRunFfmpeg = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule("../src/providers/composer/ffmpeg/ffmpeg.js", () => ({
  probe: mockProbe,
  runFfmpeg: mockRunFfmpeg,
}));

const { OpenRouterTTSProvider } =
  await import("../src/providers/openrouter-tts-provider.js");

const TTS_URL = "https://openrouter.ai/api/v1/audio/speech";
const MODEL = "fish-audio/s2.1-pro-free";
const VOICE = "536d3a5e000945adb7038665781a4aca";
const MP3_BYTES = Buffer.from([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f, 0xff, 0xfb, 0x90,
  0x64, 0x22, 0x21, 0x00, 0x00, 0x01, 0x2e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_TTS_MODEL",
  "OPENROUTER_TTS_VOICE",
  "OPENROUTER_TTS_RESPONSE_FORMAT",
  "OPENROUTER_TTS_TIMEOUT_MS",
  "NARRATION_TARGET_WPM",
];

const originalEnv: Record<string, string | undefined> = {};

function makeAudioResponse(bytes: Buffer): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: () => "audio/mpeg",
      entries: () => [] as IterableIterator<[string, string]>,
    } as unknown as Headers,
    json: () => {
      throw new Error("JSON parsing must not be attempted on audio bytes");
    },
    text: () => Promise.reject(new Error("text must not be used")),
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      ),
  } as Response;
}

function makeErrorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    statusText: "Error",
    headers: {
      get: () => "application/json",
      entries: () => [] as IterableIterator<[string, string]>,
    } as unknown as Headers,
    json: () => Promise.resolve({ error: { code: status, message } }),
    text: () => Promise.resolve(JSON.stringify({ error: { message } })),
    arrayBuffer: () =>
      Promise.reject(new Error("error responses are not audio")),
  } as Response;
}

let fetchSpy: jest.Spied<typeof globalThis.fetch>;

function resetFsMocks(): void {
  const tempKeys = Object.keys(writtenFiles).filter((key) =>
    key.endsWith(".tmp"),
  );
  for (const key of tempKeys) delete writtenFiles[key];
  mockMkdir.mockImplementation(async () => undefined);
  mockWriteFile.mockImplementation(async (path: string, data: Buffer) => {
    writtenFiles[path] = data;
  });
  mockRename.mockImplementation(async (from: string, to: string) => {
    if (writtenFiles[from]) {
      writtenFiles[to] = writtenFiles[from];
      delete writtenFiles[from];
    }
  });
  mockRm.mockImplementation(async (path: string) => {
    delete writtenFiles[path];
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.OPENROUTER_API_KEY = "test-api-key";
  process.env.OPENROUTER_TTS_MODEL = MODEL;
  process.env.OPENROUTER_TTS_VOICE = VOICE;
  process.env.OPENROUTER_TTS_RESPONSE_FORMAT = "mp3";
  delete process.env.OPENROUTER_TTS_TIMEOUT_MS;
  delete process.env.NARRATION_TARGET_WPM;

  mockMkdir.mockClear();
  mockWriteFile.mockClear();
  mockRename.mockClear();
  mockRm.mockClear();
  mockProbe.mockClear();
  mockRunFfmpeg.mockClear();
  resetFsMocks();

  mockProbe.mockResolvedValue({
    duration: 2.0,
    hasAudio: true,
    hasVideo: false,
    width: 0,
    height: 0,
    fps: 0,
  });
  mockRunFfmpeg.mockResolvedValue(undefined);

  fetchSpy = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(jest.fn() as unknown as typeof globalThis.fetch);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  fetchSpy.mockRestore();
  jest.useRealTimers();
});

describe("OpenRouterTTSProvider", () => {
  const provider = new OpenRouterTTSProvider();

  it("builds the OpenRouter audio/speech request body from model/voice/format", async () => {
    fetchSpy.mockResolvedValueOnce(makeAudioResponse(MP3_BYTES));

    await provider.synthesize({ text: "Hello world" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(TTS_URL);

    const request = init as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-api-key",
    });
    expect(JSON.parse(request.body as string)).toEqual({
      model: MODEL,
      input: "Hello world",
      voice: VOICE,
      response_format: "mp3",
    });
  });

  it("writes the raw audio bytes atomically without JSON parsing", async () => {
    fetchSpy.mockResolvedValueOnce(makeAudioResponse(MP3_BYTES));

    const result = await provider.synthesize({
      text: "Hello world",
      filename: "scene-001.mp3",
    });

    expect(result.durationMs).toBe(2000);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(TTS_URL);
    expect((init as RequestInit).signal).toBeDefined();

    const finalPath = result.audioUrl;
    expect(finalPath).toContain("scene-001.mp3");
    expect(writtenFiles[finalPath]).toBeDefined();
    expect(writtenFiles[finalPath].equals(MP3_BYTES)).toBe(true);

    // downloaded via temp file, then renamed into place — no bare temp left
    expect(mockRename).toHaveBeenCalledTimes(1);
    const [tempPath, renamedTo] = mockRename.mock.calls[0];
    expect(renamedTo).toBe(finalPath);
    expect(String(tempPath)).toContain(".tmp");
    expect(Object.keys(writtenFiles).some((key) => key.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it("omits voice when neither config nor options supply one", async () => {
    delete process.env.OPENROUTER_TTS_VOICE;
    fetchSpy.mockResolvedValueOnce(makeAudioResponse(MP3_BYTES));

    await provider.synthesize({ text: "Hello world" });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      model: MODEL,
      input: "Hello world",
      response_format: "mp3",
    });
    expect("voice" in body).toBe(false);
  });

  it("prefers an explicit per-call voice over the configured voice", async () => {
    process.env.OPENROUTER_TTS_VOICE = VOICE;
    fetchSpy.mockResolvedValueOnce(makeAudioResponse(MP3_BYTES));

    await provider.synthesize({ text: "Hi", voice: "other-voice" });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.voice).toBe("other-voice");
  });

  it("never forwards the pipeline default voice 'narrator'", async () => {
    delete process.env.OPENROUTER_TTS_VOICE;
    fetchSpy.mockResolvedValueOnce(makeAudioResponse(MP3_BYTES));

    await provider.synthesize({ text: "Hi", voice: "narrator" });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect("voice" in body).toBe(false);
  });

  it("uses the configured voice when the caller passes the generic 'narrator' default", async () => {
    process.env.OPENROUTER_TTS_VOICE = VOICE;
    fetchSpy.mockResolvedValueOnce(makeAudioResponse(MP3_BYTES));

    await provider.synthesize({ text: "Hi", voice: "narrator" });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.voice).toBe(VOICE);
  });
});

describe("OpenRouterTTSProvider HTTP errors", () => {
  const provider = new OpenRouterTTSProvider();

  for (const status of [400, 401, 402, 403, 404]) {
    it(`surfaces a useful error for HTTP ${status} without retrying`, async () => {
      fetchSpy.mockResolvedValueOnce(
        makeErrorResponse(status, `reason for ${status}`),
      );

      const err = await provider
        .synthesize({ text: "Hello world" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(PipelineError);
      expect((err as Error).message).toContain(`HTTP ${status}`);
      expect((err as Error).message).toContain(`reason for ${status}`);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  }

  it("surfaces a useful error when the error body is not JSON", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: {
        get: () => "text/plain",
        entries: () => [] as IterableIterator<[string, string]>,
      } as unknown as Headers,
      json: () => Promise.reject(new Error("Invalid JSON")),
    } as Response);

    const err = await provider
      .synthesize({ text: "Hello world" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/HTTP 400/);
    expect((err as Error).message).toMatch(/malformed or unsupported/);
  });
});

describe("OpenRouterTTSProvider retries", () => {
  const provider = new OpenRouterTTSProvider();

  beforeEach(() => {
    jest.useFakeTimers();
  });

  it("backs off and retries transient 429 errors before succeeding", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(429, "rate limited"))
      .mockResolvedValueOnce(makeErrorResponse(429, "rate limited"))
      .mockResolvedValueOnce(makeAudioResponse(MP3_BYTES));

    const promise = provider.synthesize({ text: "Hello world" });

    await jest.advanceTimersByTimeAsync(1300); // first backoff (1000 + jitter)
    await jest.advanceTimersByTimeAsync(2300); // second backoff (2000 + jitter)

    await expect(promise).resolves.toMatchObject({ durationMs: 2000 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retries transient 502 up to the retry limit then fails", async () => {
    fetchSpy
      .mockResolvedValueOnce(makeErrorResponse(502, "upstream audio failure"))
      .mockResolvedValueOnce(makeErrorResponse(502, "upstream audio failure"))
      .mockResolvedValueOnce(makeErrorResponse(502, "upstream audio failure"))
      .mockResolvedValueOnce(makeErrorResponse(502, "upstream audio failure"));

    const promise = provider
      .synthesize({ text: "Hello world" })
      .catch((e) => e);

    await jest.advanceTimersByTimeAsync(1300);
    await jest.advanceTimersByTimeAsync(2300);
    await jest.advanceTimersByTimeAsync(4300);

    const err = await promise;
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toContain("HTTP 502");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("does not retry a permanent 400", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(400, "bad request"));

    const promise = provider
      .synthesize({ text: "Hello world" })
      .catch((e) => e);
    await jest.advanceTimersByTimeAsync(10_000);

    const err = await promise;
    expect(err).toBeInstanceOf(PipelineError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry a local write failure", async () => {
    fetchSpy.mockResolvedValueOnce(makeAudioResponse(MP3_BYTES));
    mockWriteFile.mockRejectedValueOnce(new Error("ENOSPC"));

    const promise = provider
      .synthesize({ text: "Hello world" })
      .catch((e) => e);
    await jest.advanceTimersByTimeAsync(10_000);

    const err = await promise;
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/Failed to save/);

    const tempPath = mockWriteFile.mock.calls[0][0];
    expect(mockRm).toHaveBeenCalledWith(
      tempPath,
      expect.objectContaining({ force: true }),
    );
    expect(mockRename).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("OpenRouterTTSProvider timeout", () => {
  const provider = new OpenRouterTTSProvider();

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.OPENROUTER_TTS_TIMEOUT_MS = "50";
  });

  it("aborts a hanging request and surfaces a timeout error", async () => {
    fetchSpy.mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("The operation was aborted"), {
                name: "AbortError",
              }),
            );
          });
        }) as never,
    );

    const promise = provider
      .synthesize({ text: "Hello world" })
      .catch((e) => e);

    for (let i = 0; i < 4; i++) {
      await jest.advanceTimersByTimeAsync(50); // request timeout aborts the call
      if (i < 3) await jest.advanceTimersByTimeAsync(1000 * 2 ** i + 250);
    }

    const err = await promise;
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/timed out/);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
