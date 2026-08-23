import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ProjectState } from "../types/index.js";
import { parseSrtCues } from "./srt.js";

function localVideoPath(videoUrl: string): string | undefined {
  if (videoUrl.startsWith("file://")) return fileURLToPath(videoUrl);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(videoUrl)) return undefined;
  return path.resolve(videoUrl);
}

export function transcriptText(state: ProjectState): string {
  const sceneNarration = [...(state.audio?.scenes ?? [])]
    .sort((a, b) => a.sceneId - b.sceneId)
    .map((scene) => scene.narration.trim())
    .filter(Boolean);
  if (sceneNarration.length > 0) return sceneNarration.join("\n\n");

  const narration = state.content?.narration?.trim();
  if (narration) return narration;

  const script = state.content?.script?.trim();
  if (script) return script;

  return parseSrtCues(state.subtitles?.srt ?? "")
    .map((cue) => cue.text.trim())
    .filter(Boolean)
    .join("\n");
}

export async function exportTranscriptBesideVideo(
  videoUrl: string,
  state: ProjectState,
): Promise<string | undefined> {
  const videoPath = localVideoPath(videoUrl);
  if (!videoPath) return undefined;

  const text = transcriptText(state);
  if (!text)
    throw new Error("No narration text is available for transcript.txt");

  const transcriptPath = path.join(path.dirname(videoPath), "transcript.txt");
  const temporaryPath = `${transcriptPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${text}\n`, "utf8");
  await rename(temporaryPath, transcriptPath);
  return transcriptPath;
}
