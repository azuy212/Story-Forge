import type { RunnableConfig } from "@langchain/core/runnables";

import { narrationGeneratorNode } from "./agents/narration-generator.node.js";
import { ChatterboxTTSProvider } from "./providers/chatterbox-tts-provider.js";
import type { ProjectState } from "./types/index.js";

const RUNS = 10;

const TEXT =
  "In 1925, a powerful earthquake struck Santa Barbara, California, destroying buildings, breaking water pipes, and starting fires. Residents rushed to rescue neighbors as emergency crews struggled to reach the hardest-hit areas.";

function calculateWpm(text: string, durationMs: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  const minutes = durationMs / 60_000;

  return minutes > 0 ? words / minutes : 0;
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(3)}s`;
}

async function main() {
  const provider = new ChatterboxTTSProvider();

  console.log("=".repeat(80));
  console.log("CHATTERBOX NARRATION VARIANCE TEST");
  console.log("=".repeat(80));
  console.log();
  console.log(`Runs:  ${RUNS}`);
  console.log(`Text:  ${TEXT}`);
  console.log();

  const results: Array<{
    run: number;
    durationMs: number;
    wpm: number;
  }> = [];

  for (let i = 1; i <= RUNS; i++) {
    console.log("-".repeat(80));
    console.log(`RUN ${i}/${RUNS}`);
    console.log("-".repeat(80));

    /*
     * Use a unique narration each run so cacheNodeResult cannot return
     * the previous generated artifact.
     *
     * The visible narration remains identical. The cache key sees the
     * unique runId through the provider options.
     */
    const state = {
      production: {
        scenes: [
          {
            sceneId: 1,
            narration: TEXT,
          },
        ],
      },
      branding: {
        voice: "narrator",
      },
    } as ProjectState;

    const config: RunnableConfig = {
      configurable: {
        ttsProvider: provider,

        /*
         * Unique namespace forces a fresh artifact for each run.
         */
        artifactNamespace: `test-narration-variance-${Date.now()}-${i}`,
      },
    };

    const start = performance.now();

    try {
      const result = await narrationGeneratorNode(state, config);

      const elapsedMs = performance.now() - start;

      if (result.diagnostics?.errors?.length) {
        console.error("Errors:");

        for (const error of result.diagnostics.errors) {
          console.error(`  ${error}`);
        }

        continue;
      }

      const scene = result.audio?.scenes?.[0];

      if (!scene) {
        console.error("No scene audio returned.");
        continue;
      }

      const durationMs = scene.durationMs;
      const wpm = calculateWpm(TEXT, durationMs);

      results.push({
        run: i,
        durationMs,
        wpm,
      });

      console.log(`Duration:       ${formatDuration(durationMs)}`);
      console.log(`WPM:            ${wpm.toFixed(1)}`);
      console.log(`Node time:      ${(elapsedMs / 1000).toFixed(2)}s`);
      console.log(`Audio:          ${scene.url}`);
    } catch (error) {
      console.error("Run failed:");

      if (error instanceof Error) {
        console.error(error.stack ?? error.message);
      } else {
        console.error(String(error));
      }
    }
  }

  if (results.length === 0) {
    console.error();
    console.error("No successful runs.");
    process.exitCode = 1;
    return;
  }

  const durations = results.map((result) => result.durationMs);
  const wpms = results.map((result) => result.wpm);

  const averageDuration =
    durations.reduce((sum, value) => sum + value, 0) / durations.length;

  const averageWpm = wpms.reduce((sum, value) => sum + value, 0) / wpms.length;

  const sortedDurations = [...durations].sort((a, b) => a - b);
  const sortedWpms = [...wpms].sort((a, b) => a - b);

  const medianDuration =
    sortedDurations.length % 2 === 0
      ? (sortedDurations[sortedDurations.length / 2 - 1] +
          sortedDurations[sortedDurations.length / 2]) /
        2
      : sortedDurations[Math.floor(sortedDurations.length / 2)];

  const medianWpm =
    sortedWpms.length % 2 === 0
      ? (sortedWpms[sortedWpms.length / 2 - 1] +
          sortedWpms[sortedWpms.length / 2]) /
        2
      : sortedWpms[Math.floor(sortedWpms.length / 2)];

  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);
  const minWpm = Math.min(...wpms);
  const maxWpm = Math.max(...wpms);

  const variance =
    durations.reduce(
      (sum, duration) => sum + Math.pow(duration - averageDuration, 2),
      0,
    ) / durations.length;

  const standardDeviation = Math.sqrt(variance);

  console.log();
  console.log();
  console.log("=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));

  console.log();
  console.log("Run".padEnd(8) + "Duration".padEnd(15) + "WPM");

  console.log("-".repeat(40));

  for (const result of results) {
    console.log(
      String(result.run).padEnd(8) +
        formatDuration(result.durationMs).padEnd(15) +
        result.wpm.toFixed(1),
    );
  }

  console.log();
  console.log("-".repeat(40));

  console.log(`Average duration:  ${formatDuration(averageDuration)}`);

  console.log(`Median duration:   ${formatDuration(medianDuration)}`);

  console.log(`Minimum duration:  ${formatDuration(minDuration)}`);

  console.log(`Maximum duration:  ${formatDuration(maxDuration)}`);

  console.log(`Std deviation:     ${formatDuration(standardDeviation)}`);

  console.log();

  console.log(`Average WPM:       ${averageWpm.toFixed(1)}`);
  console.log(`Median WPM:        ${medianWpm.toFixed(1)}`);
  console.log(`Minimum WPM:       ${minWpm.toFixed(1)}`);
  console.log(`Maximum WPM:       ${maxWpm.toFixed(1)}`);

  console.log();
  console.log("=".repeat(80));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
