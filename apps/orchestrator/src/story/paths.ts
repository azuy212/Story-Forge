import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../utils/config.js";

/**
 * Artifact layout for a story job (brief section 5):
 *
 *   jobs/<jobId>/
 *     manifest.json
 *     story.json  claims.json  characters.json  scenes.json
 *     images/scene-001.png …
 *     audio/parts/…  audio/chunks/…  narration.wav
 *     transcript.json  subtitles.ass  subtitles.srt
 *     render/…  final.mp4
 *
 * The default root is anchored to the orchestrator package (not the process
 * CWD) so jobs always land in the git-ignored `/apps/orchestrator/jobs/`
 * regardless of where the command is run from. `--output-dir` overrides it.
 */

// Both src/story and dist/story sit two levels below the package root.
const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export function packageRoot(): string {
  return PACKAGE_ROOT;
}

export function jobsRoot(): string {
  const configured = config.storyJobsDir();
  return isAbsolute(configured)
    ? configured
    : resolve(PACKAGE_ROOT, configured);
}

export function promptsRoot(): string {
  return config.storyPromptsPath() ?? resolve(PACKAGE_ROOT, "prompts");
}

export function styleProfilePath(style: string): string {
  return resolve(promptsRoot(), "story", "style", `${style}.json`);
}

export interface JobPaths {
  dir: string;
  manifest: string;
  story: string;
  claims: string;
  characters: string;
  scenes: string;
  imagesDir: string;
  audioDir: string;
  audioPartsDir: string;
  audioChunksDir: string;
  narration: string;
  transcript: string;
  subtitlesAss: string;
  subtitlesSrt: string;
  renderDir: string;
  finalVideo: string;
}

export function jobDir(jobId: string, outputDir?: string): string {
  if (!outputDir) return resolve(jobsRoot(), jobId);
  const absolute = isAbsolute(outputDir)
    ? outputDir
    : resolve(process.cwd(), outputDir);
  // An explicit output dir normally HOLDS the job folder; passing the job's
  // own directory (its basename is exactly the job id) uses it verbatim
  // instead of nesting a second copy.
  return basename(absolute) === jobId ? absolute : resolve(absolute, jobId);
}

export function jobPaths(dir: string): JobPaths {
  return {
    dir,
    manifest: resolve(dir, "manifest.json"),
    story: resolve(dir, "story.json"),
    claims: resolve(dir, "claims.json"),
    characters: resolve(dir, "characters.json"),
    scenes: resolve(dir, "scenes.json"),
    imagesDir: resolve(dir, "images"),
    audioDir: resolve(dir, "audio"),
    audioPartsDir: resolve(dir, "audio", "parts"),
    audioChunksDir: resolve(dir, "audio", "chunks"),
    narration: resolve(dir, "audio", "narration.wav"),
    transcript: resolve(dir, "transcript.json"),
    subtitlesAss: resolve(dir, "subtitles.ass"),
    subtitlesSrt: resolve(dir, "subtitles.srt"),
    renderDir: resolve(dir, "render"),
    finalVideo: resolve(dir, "final.mp4"),
  };
}

/** Deterministic scene-to-file mapping (brief S5). */
export function sceneImagePath(
  paths: JobPaths,
  sceneId: number,
  extension = "png",
): string {
  return resolve(
    paths.imagesDir,
    `scene-${String(sceneId).padStart(3, "0")}.${extension}`,
  );
}

export function sceneChunkPath(paths: JobPaths, sceneId: number): string {
  return resolve(
    paths.audioChunksDir,
    `scene-${String(sceneId).padStart(3, "0")}.wav`,
  );
}

export function scenePartPath(
  paths: JobPaths,
  sceneId: number,
  part: number,
): string {
  return resolve(
    paths.audioPartsDir,
    `scene-${String(sceneId).padStart(3, "0")}-part${String(part).padStart(2, "0")}.wav`,
  );
}
