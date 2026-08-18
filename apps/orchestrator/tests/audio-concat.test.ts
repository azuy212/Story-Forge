import { jest, describe, it, expect } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockRunFfmpegWithRetry = jest
  .fn<(...args: any[]) => Promise<any>>()
  .mockResolvedValue(undefined);
const mockProbe = jest
  .fn<(...args: any[]) => Promise<any>>()
  .mockResolvedValue({
    duration: 6.25,
    hasAudio: true,
    hasVideo: false,
    width: 0,
    height: 0,
    fps: 0,
  });

jest.unstable_mockModule("../src/providers/composer/ffmpeg/ffmpeg.js", () => ({
  probe: mockProbe,
  runFfmpeg: jest.fn(),
  runFfmpegWithRetry: mockRunFfmpegWithRetry,
}));

const { concatAudio } =
  await import("../src/providers/composer/ffmpeg/audio.js");

describe("concatAudio", () => {
  it("sorts numeric scene IDs and returns measured duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audio-concat-test-"));
    const output = join(dir, "narration.wav");
    try {
      for (const id of [1, 2, 10]) {
        writeFileSync(
          join(dir, `scene-${String(id).padStart(3, "0")}.wav`),
          "x",
        );
      }

      const result = await concatAudio(
        [
          { sceneId: 10, filePath: join(dir, "scene-010.wav") },
          { sceneId: 2, filePath: join(dir, "scene-002.wav") },
          { sceneId: 1, filePath: join(dir, "scene-001.wav") },
        ],
        output,
      );

      const args = mockRunFfmpegWithRetry.mock.calls[0][0];
      expect(args).toEqual(
        expect.arrayContaining([
          "-filter_complex",
          "[0:a:0][1:a:0][2:a:0]concat=n=3:v=0:a=1[outa]",
          "-c:a",
          "pcm_s16le",
        ]),
      );
      expect(args.filter((arg: string) => arg.endsWith(".wav"))).toEqual([
        join(dir, "scene-001.wav"),
        join(dir, "scene-002.wav"),
        join(dir, "scene-010.wav"),
        output,
      ]);
      expect(result).toEqual({ audioPath: output, durationMs: 6250 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate scene IDs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audio-concat-test-"));
    try {
      writeFileSync(join(dir, "one.wav"), "x");
      await expect(
        concatAudio(
          [
            { sceneId: 1, filePath: join(dir, "one.wav") },
            { sceneId: 1, filePath: join(dir, "one.wav") },
          ],
          join(dir, "duplicate.wav"),
        ),
      ).rejects.toThrow("Duplicate scene audio ID");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects remote URL scene audio paths", async () => {
    await expect(
      concatAudio(
        [
          { sceneId: 1, filePath: "https://example.com/scene-001.wav" },
          { sceneId: 2, filePath: "https://example.com/scene-002.wav" },
        ],
        "/tmp/remote.wav",
      ),
    ).rejects.toThrow("must be a local file path");
  });

  it("rejects missing scene audio files", async () => {
    await expect(
      concatAudio(
        [
          { sceneId: 1, filePath: "/tmp/definitely-missing-001.wav" },
          { sceneId: 2, filePath: "/tmp/definitely-missing-002.wav" },
        ],
        "/tmp/missing.wav",
      ),
    ).rejects.toThrow("Scene audio file not found");
  });
});
