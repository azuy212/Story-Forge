#!/usr/bin/env node

/**
 * Story-Forge stickman storytelling pipeline — single command entry point.
 *
 *   node scripts/story-video.mjs "The mutiny on the Bounty" --duration 150
 *
 * Requires a build first (`pnpm --filter youtube-shorts-orchestrator build`),
 * because it imports the compiled `dist/story/index.js`.
 *
 * The env file is loaded here, anchored to the package — like every other
 * plain-JS entrypoint in this repo — because nothing under `src/` reads `.env`
 * on its own. Without this the documented `OPENROUTER_API_KEY` in `.env` was
 * invisible to the CLI and the very first agent call failed.
 *
 * Exit codes: 0 complete or successful dry run, 1 failed, 2 stopped (an
 * incomplete run: some stages are still pending).
 */

import "../src/runtime/network.mjs";
import dotenv from "dotenv";
import { Command } from "commander";
import { fileURLToPath } from "node:url";

dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

// Imported after the env is loaded: `src/utils/config.ts` reads process.env
// lazily, but a dynamic import keeps the ordering explicit.
const { runStoryJob, STORY_CLI_OVERRIDE_KEYS } =
  await import("../dist/story/index.js");

const STAGES = [
  "S1_input",
  "S2_story",
  "S3_scenes",
  "S4_visual_plan",
  "S5_images",
  "S6_audio",
  "S7_align",
  "S8_render",
];

const program = new Command();

program
  .name("story-video")
  .description(
    "Turn a topic into a validated 1080p illustrated story video with per-scene narration and audio-timed subtitles.",
  )
  .argument(
    "<topic>",
    'the story topic, for example "The mutiny on the Bounty"',
  )
  .option("--duration <seconds>", "target narration length in seconds", Number)
  .option("--language <tag>", "narration language as a BCP-47 tag", String)
  .option("--tone <text>", "narration tone hint", String)
  .option(
    "--style <id>",
    "image style profile id under prompts/story/style",
    String,
  )
  .option("--job-id <id>", "job id (also the output directory name)", String)
  .option("--out-dir <dir>", "directory that holds the job folder", String)
  .option(
    "--wpm <words>",
    "narration speaking rate used for budgets and lint",
    Number,
  )
  .option("--fps <fps>", "render frame rate", Number)
  .option("--resolution <WxH>", "render resolution (default 1920x1080)", String)
  .option(
    "--image-concurrency <n>",
    "maximum in-flight image generations (default 1)",
    Number,
  )
  .option("--scene-gap-ms <ms>", "silence held between scenes", Number)
  .option(
    "--stages <list>",
    `comma-separated stages to run (${STAGES.join(",")})`,
    String,
  )
  .option(
    "--from <stage>",
    "force this stage and every later stage to rerun",
    String,
  )
  .option(
    "--regenerate-prompts",
    "discard stored scene prompts and re-plan them in S4 (keeps images/audio unless their own inputs changed)",
    false,
  )
  .option(
    "--regenerate-images <sceneIds>",
    "comma-separated scene ids to regenerate in S5, bypassing the image-provider cache",
    String,
  )
  .option(
    "--dry-run",
    "validate the input and print the plan without any paid call",
    false,
  )
  .option(
    "--review-story",
    "print the written story and wait for approval before continuing",
    false,
  )
  .option("--json", "print the result summary as JSON", false)
  .showHelpAfterError();

program.parse();

const topic = program.args[0];
const options = program.opts();

const overrides = {};
const assign = (key, value) => {
  if (value !== undefined) overrides[key] = value;
};

assign("duration", options.duration);
assign("language", options.language);
assign("tone", options.tone);
assign("style", options.style);
assign("jobId", options.jobId);
assign("outputDir", options.outDir);
assign("wpm", options.wpm);
assign("fps", options.fps);
assign("resolution", options.resolution);
assign("imageConcurrency", options.imageConcurrency);
assign("sceneGapMs", options.sceneGapMs);

if (options.stages !== undefined) {
  const stages = String(options.stages)
    .split(",")
    .map((stage) => stage.trim())
    .filter(Boolean);
  const unknown = stages.filter((stage) => !STAGES.includes(stage));
  if (unknown.length > 0) {
    console.error(
      `Unknown stage(s): ${unknown.join(", ")}\nValid stages: ${STAGES.join(", ")}`,
    );
    process.exit(1);
  }
  overrides.stages = stages;
}
assign("from", options.from);
overrides.regeneratePrompts = options.regeneratePrompts;
if (options.regenerateImages !== undefined) {
  const rawIds = String(options.regenerateImages)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const ids = rawIds.map(Number);
  if (
    ids.length === 0 ||
    rawIds.some((value) => !/^[1-9]\d*$/.test(value)) ||
    ids.some((id) => !Number.isInteger(id) || id < 1) ||
    new Set(ids).size !== ids.length
  ) {
    console.error(
      `Invalid --regenerate-images value "${options.regenerateImages}": use unique positive scene ids separated by commas`,
    );
    process.exit(1);
  }
  overrides.regenerateImages = ids;
}
overrides.dryRun = options.dryRun;
overrides.reviewStory = options.reviewStory;

// Fail loudly on a flag that maps to a key the config does not read, instead of
// silently ignoring it (the `--duration` bug: it wrote `targetDurationSec`).
const unknownOverrides = Object.keys(overrides).filter(
  (key) =>
    !STORY_CLI_OVERRIDE_KEYS.includes(key) &&
    key !== "stages" &&
    key !== "from" &&
    key !== "regeneratePrompts" &&
    key !== "regenerateImages" &&
    key !== "dryRun" &&
    key !== "reviewStory",
);
if (unknownOverrides.length > 0) {
  console.error(
    `Internal error: unknown override key(s) ${unknownOverrides.join(", ")}. ` +
      `Valid keys: ${STORY_CLI_OVERRIDE_KEYS.join(", ")}`,
  );
  process.exit(1);
}

try {
  const result = await runStoryJob({ ...overrides, topic });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\njob:      ${result.jobId}`);
    console.log(`dir:      ${result.jobDir}`);
    console.log(`status:   ${result.status}`);
    if (result.plan) {
      console.log(
        `plan:     about ${result.plan.estimatedSceneCount} scenes, ${result.plan.wordBudget} words (${result.plan.note})`,
      );
    }
    if (result.finalVideo) {
      const probe = result.manifest.render?.ffprobe;
      console.log(`video:    ${result.finalVideo}`);
      if (probe) {
        console.log(
          `          ${probe.width}x${probe.height} ${probe.fps}fps ${probe.duration}s ${probe.videoCodec}/${probe.audioCodec}`,
        );
      }
    }
    if (result.manifest.warnings.length > 0) {
      console.log("\nwarnings:");
      for (const warning of result.manifest.warnings) {
        console.log(`  - ${warning}`);
      }
    }
    console.log(`\nmanifest: ${result.jobDir}/manifest.json`);
  }

  // A dry run is a success: it validated the input and planned the job.
  // Status "stopped" without a dry run means stages are still pending.
  if (result.status === "complete" || options.dryRun) process.exit(0);
  process.exit(2);
} catch (err) {
  console.error(`\nStory job failed: ${err?.message ?? err}`);
  process.exit(1);
}
