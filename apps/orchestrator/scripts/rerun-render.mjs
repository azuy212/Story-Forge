#!/usr/bin/env node

/**
 * Standalone re-render script: re-runs WhisperX alignment + FFmpeg composition
 * using existing run artifacts (images, audio, narration). Does NOT touch the
 * graph or artifact cache — outputs go to a separate directory.
 *
 * Usage:
 *   node scripts/rerun-render.mjs <namespace> [--dry-run]
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../dist/utils/logger.js";
import { closeAllRunLogSinks } from "../dist/utils/run-log.js";
import { WhisperXSceneSubtitleProvider } from "../dist/providers/whisperx-scene-subtitle-provider.js";
import { HttpWhisperXProvider } from "../dist/providers/whisperx-provider.js";
import { DeterministicSceneSubtitleProvider } from "../dist/providers/scene-subtitle-provider.js";
import { alignSceneDurationsToAudio } from "../dist/agents/video-composer.node.js";
import { FfmpegComposerProvider } from "../dist/providers/composer/ffmpeg-composer.provider.js";
import { resolveBranding, selectOutroAssetForProfile } from "../dist/utils/branding.js";
import { resolveVideoProfile } from "../dist/utils/video-profile.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(__dirname, "..", "runs");

function resolveNamespace(input) {
  const namespaces = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== ".run-names")
    .map((d) => d.name);
  const exact = namespaces.find((n) => n === input);
  if (exact) return exact;
  const matches = namespaces.filter((n) => n.includes(input));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`Multiple runs match "${input}":`);
    for (const m of matches) console.error(`  ${m}`);
    process.exit(1);
  }
  console.error(`No run found for "${input}"`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const namespace = args.find((a) => !a.startsWith("--"));
  if (!namespace) {
    console.error("Usage: node scripts/rerun-render.mjs <namespace> [--dry-run]");
    process.exit(1);
  }

  const ns = resolveNamespace(namespace);
  const runDir = join(RUNS_DIR, ns);
  console.log(`Run: ${ns}`);
  console.log(`Run dir: ${runDir}`);

  // Load artifacts
  const audioArtifact = JSON.parse(
    readFileSync(join(runDir, "artifacts/audio/v1.json"), "utf-8"),
  );
  const assetsArtifact = JSON.parse(
    readFileSync(join(runDir, "artifacts/assets/v1.json"), "utf-8"),
  );
  const subtitlesArtifact = JSON.parse(
    readFileSync(join(runDir, "artifacts/subtitles/v1.json"), "utf-8"),
  );
  const runJson = JSON.parse(readFileSync(join(runDir, "run.json"), "utf-8"));

  const audioData = audioArtifact.data;
  const assetsData = assetsArtifact.data;
  const profile = runJson.videoProfile || "short";

  console.log(`Profile: ${profile}`);
  console.log(`Scenes: ${audioData.scenes.length}`);
  console.log(`Combined audio: ${audioData.combinedAudio.url}`);
  console.log(`Duration: ${audioData.combinedAudio.durationMs}ms`);

  // Reconstruct state for alignment + composition
  const scenes = assetsData.scenes.map((s) => ({
    sceneId: s.sceneId,
    narration: s.narration,
    assetUrl: s.assetUrl,
    assetFileName: s.filename,
    durationSeconds: s.durationSeconds,
  }));

  const audioScenes = audioData.scenes.map((s) => ({
    sceneId: s.sceneId,
    narration: s.narration,
    durationMs: s.durationMs,
    artifactId: s.artifactId,
  }));

  const combinedAudioUrl = audioData.combinedAudio.url;
  const narrationDurationMs = audioData.combinedAudio.durationMs;

  // Build full narration text
  const fullNarration = audioData.scenes.map((s) => s.narration).join(" ");

  console.log(`\nFull narration (${fullNarration.length} chars):`);
  console.log(`  "${fullNarration}"`);

  // Step 1: WhisperX alignment with fallback
  console.log("\n--- Step 1: WhisperX subtitle alignment ---");

  const videoProfile = resolveVideoProfile({ videoProfile: profile });
  const whisperx = new WhisperXSceneSubtitleProvider(new HttpWhisperXProvider());
  const deterministic = new DeterministicSceneSubtitleProvider();

  let subtitleResult;
  try {
    subtitleResult = await whisperx.generateSceneSubtitles(
      scenes,
      audioScenes,
      videoProfile,
      { combinedAudioUrl, fullNarration, runId: ns },
    );
    console.log(`WhisperX alignment: ${subtitleResult.wordTimestamps.length} word timestamps`);
    console.log(`First cue: ${subtitleResult.srt.split("\n").slice(0, 4).join(" | ")}`);
  } catch (err) {
    console.warn(`WhisperX failed: ${err.message}`);
    console.warn("Falling back to deterministic timing");
    subtitleResult = await deterministic.generateSceneSubtitles(
      scenes,
      audioScenes,
      videoProfile,
    );
  }

  // Write new subtitle files
  const outputDir = join(runDir, "rerender");
  mkdirSync(outputDir, { recursive: true });
  const srtPath = join(outputDir, "subtitles.srt");
  const assPath = join(outputDir, "subtitles.ass");
  writeFileSync(srtPath, subtitleResult.srt, "utf-8");
  writeFileSync(assPath, subtitleResult.ass, "utf-8");
  console.log(`\nWrote SRT: ${srtPath}`);
  console.log(`Wrote ASS: ${assPath}`);

  if (dryRun) {
    console.log("\nDry run — skipping FFmpeg composition.");
    await closeAllRunLogSinks();
    return;
  }

  // Step 2: FFmpeg composition
  console.log("\n--- Step 2: FFmpeg composition ---");

  // Re-time scenes to match actual audio durations
  const timedScenes = alignSceneDurationsToAudio(scenes, audioScenes);

  const branding = resolveBranding({});
  const outroAsset = selectOutroAssetForProfile(branding, profile);
  const totalDurationSeconds = narrationDurationMs / 1000;

  const composer = new FfmpegComposerProvider({
    subtitleFontSize: 20,
    subtitleFontName: "Noto Sans",
    subtitleFontPath: "assets/branding/NotoSans-Bold.ttf",
  });

  const composeResult = await composer.compose({
    scenes: timedScenes.map((s) => ({
      sceneId: s.sceneId,
      assetUrl: s.assetUrl,
      startSecond: s.startSecond ?? 0,
      endSecond: s.endSecond ?? 0,
      durationSeconds: s.durationSeconds ?? 0,
    })),
    narrationUrl: combinedAudioUrl,
    srt: subtitleResult.srt,
    ass: subtitleResult.ass,
    totalDurationSeconds,
    narrativeHoldSeconds: 0.5,
    branding: {
      channel: branding.channel,
      enabled: branding.enabled,
      outroAsset,
      ctaEnabled: branding.ctaEnabled,
      outroCta: branding.outroCta,
      outroContainsCta: branding.outroContainsCta,
    },
    video: videoProfile.videoSize,
    runId: ns,
  });

  console.log(`\nComposed video: ${composeResult.videoUrl}`);
  console.log(`Duration: ${composeResult.durationMs}ms`);
  console.log(`Resolution: ${composeResult.resolution}`);

  // Copy final video to rerender dir
  const finalPath = join(outputDir, "final.mp4");
  copyFileSync(composeResult.videoUrl, finalPath);
  console.log(`Copied to: ${finalPath}`);

  console.log("\nDone.");
  await closeAllRunLogSinks();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
