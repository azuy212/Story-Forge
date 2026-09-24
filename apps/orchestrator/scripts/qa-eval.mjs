#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { defaultCreateClassifier } from "../dist/classifiers/factory.js";
import { harvestCases } from "../dist/eval/harvest.js";
import { replayCases } from "../dist/eval/replay.js";
import { formatMetricsSummary } from "../dist/eval/metrics.js";

function loadCases(path) {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array of cases in ${path}`);
  }
  return parsed;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const program = new Command();
program
  .name("qa-eval")
  .description(
    "Harvest historical QA verdicts and replay them through a classifier",
  );

program
  .command("harvest")
  .description("Build an eval case set from runs/*/artifacts")
  .option("--runs-dir <dir>", "runs directory", "runs")
  .option("--out <file>", "output JSON path", "runs/qa-eval/cases.json")
  .option(
    "--gates <gates>",
    "comma-separated gates (promptqa,researchqa,releasereview,scriptqa)",
  )
  .action((opts) => {
    const gates = opts.gates
      ? opts.gates.split(",").map((g) => g.trim())
      : undefined;
    const cases = harvestCases({ runsDir: opts.runsDir, gates });
    writeJson(opts.out, cases);
    const byGate = {};
    for (const qaCase of cases) {
      byGate[qaCase.gate] = (byGate[qaCase.gate] ?? 0) + 1;
    }
    console.log(`Harvested ${cases.length} cases -> ${opts.out}`);
    for (const [gate, count] of Object.entries(byGate)) {
      console.log(`  ${gate}: ${count}`);
    }
  });

program
  .command("replay")
  .description("Replay harvested cases through the configured classifier")
  .requiredOption("--in <file>", "harvested cases JSON")
  .option("--out <file>", "report JSON path", "runs/qa-eval/report.json")
  .option("--gates <gates>", "comma-separated gates to include")
  .action(async (opts) => {
    if (!existsSync(opts.in)) {
      console.error(`Cases file not found: ${opts.in}`);
      process.exitCode = 1;
      return;
    }
    let cases = loadCases(opts.in);
    if (opts.gates) {
      const allowed = new Set(opts.gates.split(",").map((g) => g.trim()));
      cases = cases.filter((c) => allowed.has(c.gate));
    }
    if (cases.length === 0) {
      console.error("No cases to replay.");
      process.exitCode = 1;
      return;
    }

    const classifier = defaultCreateClassifier({
      runId: "qa-eval",
      agent: "QaEval",
    });
    console.log(
      `Replaying ${cases.length} cases with ${classifier.provider}/${classifier.model}...`,
    );

    const report = await replayCases(classifier, cases);
    writeJson(opts.out, report);

    for (const [gate, metrics] of Object.entries(report.metricsByGate)) {
      console.log(formatMetricsSummary(gate, metrics));
    }
    if (report.errors > 0) {
      console.log(`${report.errors} case(s) errored (counted as wrong).`);
      for (const outcome of report.outcomes) {
        if (outcome.error) {
          console.log(`  ${outcome.caseId}: ${outcome.error}`);
        }
      }
    }
    console.log(`Report -> ${opts.out}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
