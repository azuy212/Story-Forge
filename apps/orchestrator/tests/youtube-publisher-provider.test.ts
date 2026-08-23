import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { YouTubePublisherProvider } from "../src/providers/youtube-publisher-provider.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("YouTubePublisherProvider", () => {
  it("uploads a private video and reuses its receipt on retry", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "youtube-upload-"));
    const videoPath = path.join(directory, "final.mp4");
    const thumbnailPath = path.join(directory, "thumbnail.png");
    await writeFile(videoPath, "video bytes");
    await writeFile(thumbnailPath, "image bytes");

    const metadataBodies: string[] = [];
    let videoUploads = 0;
    let thumbnailUploads = 0;
    const fetchImpl = jest.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("uploadType=resumable")) {
        metadataBodies.push(String(init?.body));
        return new Response(null, {
          status: 200,
          headers: { location: "https://upload.test/session" },
        });
      }
      if (url === "https://upload.test/session") {
        videoUploads++;
        const body = init?.body as unknown as AsyncIterable<Uint8Array>;
        for await (const _chunk of body) {
          // Drain the file stream as the real fetch implementation would.
        }
        return new Response(JSON.stringify({ id: "youtube-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/thumbnails/set")) {
        thumbnailUploads++;
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const provider = new YouTubePublisherProvider({
      fetchImpl,
      tokenProvider: { getAccessToken: async () => "access-token" },
      privacyStatus: "private",
      defaultCategoryId: "27",
    });
    const input = {
      videoUrl: videoPath,
      thumbnailUrl: thumbnailPath,
      title: "A short",
      description: "Description",
      tags: ["history"],
      hashtags: ["Shorts"],
      category: "Education",
      platform: "youtube",
    };

    await expect(provider.publish(input)).resolves.toEqual(
      expect.objectContaining({
        platform: "youtube",
        status: "private",
        publishUrl: "https://studio.youtube.com/video/youtube-123/edit",
      }),
    );
    await provider.publish(input);

    expect(videoUploads).toBe(1);
    expect(thumbnailUploads).toBe(2);
    expect(metadataBodies).toHaveLength(1);
    expect(JSON.parse(metadataBodies[0])).toEqual(
      expect.objectContaining({
        snippet: expect.objectContaining({
          categoryId: "27",
          description: "Description\n\n#Shorts",
        }),
        status: { privacyStatus: "private" },
      }),
    );
  });
});
