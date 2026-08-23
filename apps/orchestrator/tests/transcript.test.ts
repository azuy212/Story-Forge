import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportTranscriptBesideVideo } from "../src/utils/transcript.js";
import type { ProjectState } from "../src/types/index.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("exportTranscriptBesideVideo", () => {
  it("writes ordered spoken narration next to the completed video", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "story-transcript-"));
    const videoPath = path.join(directory, "final.mp4");
    await writeFile(videoPath, "video");
    const state = {
      project: { pillar: "P", topic: "T" },
      audio: {
        scenes: [
          { sceneId: 2, narration: "Second scene.", durationMs: 1, url: "b" },
          { sceneId: 1, narration: "First scene.", durationMs: 1, url: "a" },
        ],
      },
      execution: { version: "0.2.0" },
    } as ProjectState;

    const result = await exportTranscriptBesideVideo(videoPath, state);

    expect(result).toBe(path.join(directory, "transcript.txt"));
    await expect(readFile(result!, "utf8")).resolves.toBe(
      "First scene.\n\nSecond scene.\n",
    );
  });

  it("does not try to write beside a remote stub URL", async () => {
    await expect(
      exportTranscriptBesideVideo("https://example.test/final.mp4", {
        project: { pillar: "P", topic: "T" },
        execution: { version: "0.2.0" },
      } as ProjectState),
    ).resolves.toBeUndefined();
  });
});
