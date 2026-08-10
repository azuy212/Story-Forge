import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { PipelineError } from "../src/utils/errors.js";

const mockReadFile = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

const { HttpWhisperXProvider } =
  await import("../src/providers/whisperx-provider.js");

const TRANSCRIBER_URL = "http://localhost:8030";
const WAV = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
]);

const SAMPLE_RESPONSE = {
  language: "en",
  processing_seconds: 12.5,
  segments: [
    {
      start: 0.0,
      end: 1.9,
      text: " Hello world.",
      words: [
        { word: "Hello", start: 0.0, end: 0.4, score: 0.91 },
        { word: "world.", start: 0.4, end: 1.9, score: 0.82 },
      ],
    },
    {
      start: 2.0,
      end: 3.0,
      text: " Second.",
      words: [{ word: "Second.", start: 2.0, end: 3.0, score: 0.77 }],
    },
  ],
};

let fetchSpy: jest.Spied<typeof globalThis.fetch>;

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Map() as unknown as Headers,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.reject(new Error("Unexpected arrayBuffer")),
  } as Response;
}

beforeEach(() => {
  mockReadFile.mockClear();
  mockReadFile.mockResolvedValue(WAV);
  fetchSpy = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(jest.fn() as unknown as typeof globalThis.fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("HttpWhisperXProvider", () => {
  const provider = new HttpWhisperXProvider(TRANSCRIBER_URL);

  it("uploads the actual WAV bytes to {url}/align and returns flattened word timestamps", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, SAMPLE_RESPONSE));

    const result = await provider.align(
      "generated/audio/run/narration.wav",
      "Hello world. Second.",
    );

    expect(mockReadFile).toHaveBeenCalledWith(
      "generated/audio/run/narration.wav",
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      `${TRANSCRIBER_URL}/align`,
      expect.objectContaining({
        method: "POST",
        signal: expect.any(Object),
      }),
    );

    const [, opts] = fetchSpy.mock.calls[0];
    const init = opts as unknown as {
      headers: Record<string, string>;
      body: Buffer;
    };
    expect(init.headers["Content-Type"]).toMatch(
      /^multipart\/form-data; boundary=/,
    );

    const body = init.body;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.includes(WAV)).toBe(true);
    const bodyText = body.toString("latin1");
    expect(bodyText).toContain('name="audio"; filename="narration.wav"');
    expect(bodyText).toContain("Content-Type: audio/wav");
    expect(bodyText).toContain('name="text"');
    expect(bodyText).toContain("Hello world. Second.");

    expect(result.wordTimestamps).toEqual([
      { word: "Hello", start: 0.0, end: 0.4 },
      { word: "world.", start: 0.4, end: 1.9 },
      { word: "Second.", start: 2.0, end: 3.0 },
    ]);
  });

  it("preserves exact first and last word timestamps from the response", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, SAMPLE_RESPONSE));

    const result = await provider.align("audio.wav");

    expect(result.wordTimestamps[0].start).toBe(0.0);
    expect(result.wordTimestamps[0].end).toBe(0.4);
    expect(result.wordTimestamps[result.wordTimestamps.length - 1].end).toBe(
      3.0,
    );
  });

  it("omits the text field when no narration is supplied", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, SAMPLE_RESPONSE));

    await provider.align("audio.wav");

    const [, opts] = fetchSpy.mock.calls[0];
    const bodyText = (opts as unknown as { body: Buffer }).body.toString(
      "latin1",
    );
    expect(bodyText).not.toContain('name="text"');
  });

  it("throws PipelineError on HTTP 500", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(500, { error: "boom" }));

    const err = await provider.align("audio.wav").catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/HTTP 500/);
  });

  it("throws PipelineError on malformed JSON", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map() as unknown as Headers,
      json: () => Promise.reject(new Error("Invalid JSON")),
    } as Response);

    const err = await provider.align("audio.wav").catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/invalid JSON/);
  });

  it("throws PipelineError when segments array is missing", async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, { language: "en" }));

    const err = await provider.align("audio.wav").catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/segments/);
  });

  it("throws PipelineError when the response contains no words", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        segments: [{ start: 0, end: 1, text: "x", words: [] }],
      }),
    );

    const err = await provider.align("audio.wav").catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/no word timestamps/);
  });

  it("throws PipelineError on a word missing timestamps", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        segments: [
          {
            start: 0,
            end: 1,
            text: "x",
            words: [{ word: "broken", start: null, end: 1.0 }],
          },
        ],
      }),
    );

    const err = await provider.align("audio.wav").catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/missing valid start\/end/);
  });

  it("throws PipelineError when the audio file cannot be read", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

    const err = await provider.align("missing.wav").catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/could not read audio file/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws PipelineError on network failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

    const err = await provider.align("audio.wav").catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect((err as Error).message).toMatch(/WhisperX alignment failed/);
  });
});
