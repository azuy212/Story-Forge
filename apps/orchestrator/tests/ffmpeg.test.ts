import { jest, describe, it, expect } from "@jest/globals";

const mockExeca = jest.fn();

jest.unstable_mockModule("execa", () => ({ execa: mockExeca }));

const { runFfmpegWithRetry } = await import(
  "../src/providers/composer/ffmpeg/ffmpeg.js"
);

function rejectedProcess(): any {
  const process = Promise.reject(new Error("ffmpeg failed")) as any;
  process.stderr = { on: jest.fn() };
  process.stdout = { on: jest.fn() };
  process.exitCode = 1;
  process.kill = jest.fn();
  return process;
}

describe("runFfmpegWithRetry", () => {
  it("rejects promptly when aborted during retry backoff", async () => {
    mockExeca.mockReset();
    mockExeca.mockReturnValueOnce(rejectedProcess());

    const controller = new AbortController();
    const promise = runFfmpegWithRetry(
      ["-y", "input.mp4", "output.mp4"],
      "test operation",
      3,
      undefined,
      controller.signal,
    );

    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toThrow("FFmpeg operation cancelled");
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });
});
