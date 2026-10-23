#!/usr/bin/env node

/**
 * Next visual experiment — variants D and E on scenes 1 and 18.
 *
 * This script is prepared but intentionally NOT run by CI or by the pipeline
 * change that added it. Run it only with an image-provider server already
 * running and logged in:
 *
 *   pnpm --filter gemini-image-automation serve
 *   node apps/orchestrator/scripts/next-cue-experiment.mjs
 *
 * One provider session covers every generated sample: two variants × two
 * scenes × two fresh samples = 8 images. Every call sets a random `cacheNonce`,
 * so the provider cannot serve a cached image and the sample is genuinely new.
 * The prompt text is never padded or changed to defeat the cache.
 *
 * Variants (the lead's registry description):
 *   D: "dark-red flat cap"
 *   E: "flat black cap plus a dark-red sash"
 *
 * Per-image pass criteria (also written into review.html):
 *   - round white head
 *   - eyebrows and mouth only (no eyes, nose, pupils, hair or gaze)
 *   - no coat or clothing folds
 *   - flat cap shape (not a tricorn/bicorne/three-cornered hat)
 *   - a visible red identifier
 *
 * The same run also records the pending checks that do not need new images:
 * the corrected fixed-batch hat shape, scene 13's body/crew mismatch, the
 * face-word slot lint and the lead flat-cap lint.
 *
 * Output: apps/orchestrator/outputs/next-cue-experiment/
 *   - D-scene-01-sample-1.png ... E-scene-18-sample-2.png
 *   - prompts.json
 *   - review.html
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({
  path: resolve(packageDir, ".env"),
  quiet: true,
});

const {
  composeImagePrompt,
  lintImagePrompt,
  loadStyleProfile,
  styleProfilePath,
  validateSceneImage,
} = await import("../dist/story/index.js");
const { lintCharacterRegistry } = await import("../dist/story/lint.js");

const providerUrl = (
  process.env.IMAGE_PROVIDER_URL ?? "http://127.0.0.1:8020"
).replace(/\/$/, "");
const outputDir = resolve(packageDir, "outputs", "next-cue-experiment");
const fixturePath = resolve(
  packageDir,
  "tests/fixtures/story-columbus-19.json",
);
const style = await loadStyleProfile(styleProfilePath("stickman-history"));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

const VARIANTS = [
  {
    id: "D",
    lead: "A stick figure in a dark-red flat cap.",
  },
  {
    id: "E",
    lead: "A stick figure in a flat black cap plus a dark-red sash.",
  },
];
const SCENE_IDS = [1, 18];
const SAMPLES_PER_VARIANT = 2;

const PASS_CRITERIA = [
  "Round white head",
  "Eyebrows and mouth only (no eyes, nose, pupils, hair or gaze)",
  "No coat or clothing folds",
  "Flat cap shape (not a tricorn, bicorne or three-cornered hat)",
  "A visible red identifier",
];

const KNOWN_ISSUES = [
  "Fixed batch: the cap was present 6/6, but the hats were tricorn/bicorne shapes, not flat caps. Flat-cap shape 0/6.",
  "Scene 13: Columbus has a plain red triangle body and only one crew member appears where the slot asked for three. Recorded as a known issue; not regenerated.",
  "Cue A/B: the provider cache served the C samples from the fixed batch and repeated B's second sample; A was fresh. Cap-only (A) remains the default.",
];

function sceneById(sceneId) {
  const scene = fixture.scenes.find((entry) => entry.sceneId === sceneId);
  if (!scene) throw new Error(`Fixture has no scene ${sceneId}`);
  return scene;
}

function charactersFor(variant) {
  return fixture.characters.map((character) =>
    character.id === "columbus"
      ? { ...character, visualDescription: variant.lead }
      : character,
  );
}

function mediaExtension(mime) {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return ".png";
}

/** Fraction of sampled pixels that read as a red accent (not the background wash). */
function redPixelFraction(path) {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      "scale=96:96:force_original_aspect_ratio=decrease,pad=96:96:(ow-iw)/2:(oh-ih)/2",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  let red = 0;
  const pixels = Math.floor(raw.length / 3);
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const r = raw[i];
    const g = raw[i + 1];
    const b = raw[i + 2];
    if (r >= 70 && r >= g * 1.35 && r >= b * 1.35) red += 1;
  }
  return pixels > 0 ? red / pixels : 0;
}

async function generateSample({ variant, sceneId, sample, prompt }) {
  const cacheNonce = randomUUID();
  const response = await fetch(`${providerUrl}/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ prompt, cacheNonce }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Provider rejected ${variant}-scene-${sceneId}-sample-${sample}: ${body?.error?.code ?? response.status} ${body?.error?.message ?? ""}`,
    );
  }
  if (body?.fromCache === true) {
    throw new Error(
      `Cache bypass failed for ${variant}-scene-${sceneId}-sample-${sample}: provider reported fromCache=true`,
    );
  }
  if (!Array.isArray(body?.media) || body.media.length === 0) {
    throw new Error(
      `Provider returned no media for ${variant}-scene-${sceneId}-sample-${sample}`,
    );
  }

  const media = body.media[0];
  const filename = `${variant}-scene-${String(sceneId).padStart(2, "0")}-sample-${sample}${mediaExtension(media.mime)}`;
  const imagePath = resolve(outputDir, filename);
  await writeFile(imagePath, Buffer.from(media.base64, "base64"));
  return { filename, imagePath, cacheNonce };
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  const health = await fetch(`${providerUrl}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `Image provider is not reachable at ${providerUrl}. Start it once with "pnpm --filter gemini-image-automation serve" and log in, then rerun this script.`,
    );
  }

  const probes = [];
  for (const variant of VARIANTS) {
    for (const sceneId of SCENE_IDS) {
      const scene = sceneById(sceneId);
      const characters = charactersFor(variant);
      const { prompt, characterIds } = composeImagePrompt({
        style,
        slots: scene.slots,
        characters,
      });
      const lint = lintImagePrompt({
        prompt,
        slots: scene.slots,
        characters,
        language: "en",
      });
      if (lint.length > 0) {
        throw new Error(
          `Variant ${variant.id} scene ${sceneId} failed prompt lint: ${lint.map((issue) => issue.message).join("; ")}`,
        );
      }

      for (let sample = 1; sample <= SAMPLES_PER_VARIANT; sample += 1) {
        const generated = await generateSample({
          variant: variant.id,
          sceneId,
          sample,
          prompt,
        });
        const gate = await validateSceneImage(generated.imagePath, {
          minWidth: 1000,
          minHeight: 540,
          minAspect: 1.6,
          maxAspect: 1.9,
          workDir: outputDir,
          tag: `${variant.id}-scene-${sceneId}-sample-${sample}`,
        });
        probes.push({
          variant: variant.id,
          sceneId,
          sample,
          lead: variant.lead,
          characterIds,
          prompt,
          cacheNonce: generated.cacheNonce,
          filename: generated.filename,
          gate: gate.ok
            ? {
                ok: true,
                width: gate.result.width,
                height: gate.result.height,
                aspect: gate.result.aspect,
                luminanceVariance: gate.result.luminanceVariance,
              }
            : { ok: false, issues: gate.issues },
          redPixelFraction: Number(
            redPixelFraction(generated.imagePath).toFixed(4),
          ),
        });
        console.log(
          `${generated.filename}: gate=${gate.ok ? "pass" : "FAIL"} red=${(probes.at(-1).redPixelFraction * 100).toFixed(2)}%`,
        );
      }
    }
  }

  // Pending checks that do not need another image call.
  const leadChecks = VARIANTS.map((variant) => {
    const issues = lintCharacterRegistry(
      [
        {
          id: "columbus",
          kind: "individual",
          lead: true,
          visualDescription: variant.lead,
        },
      ],
      { version: 2 },
    );
    const flatCapIssues = issues.filter((issue) =>
      /flat cap|tricorn|bicorne|three-cornered|pointed/.test(issue),
    );
    return {
      variant: variant.id,
      lead: variant.lead,
      issues,
      flatCapPass: flatCapIssues.length === 0,
      flatCapIssues,
    };
  });
  const faceWordChecks = probes.map((probe) => ({
    file: probe.filename,
    faceWords: ["eyes", "eye", "nose", "pupils", "hair", "gaze"].filter(
      (word) => new RegExp(`\\b${word}\\b`, "i").test(probe.prompt),
    ),
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    providerUrl,
    passCriteria: PASS_CRITERIA,
    knownIssues: KNOWN_ISSUES,
    probes,
    pendingChecks: {
      leadChecks,
      faceWordChecks,
      fixedBatchHatShape: KNOWN_ISSUES[0],
      scene13BodyAndCrew: KNOWN_ISSUES[1],
      cueAbCacheCaveat: KNOWN_ISSUES[2],
    },
  };
  await writeFile(
    resolve(outputDir, "prompts.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const cards = probes
    .map(
      (probe) => `
    <article class="card">
      <h2>${probe.variant} · scene ${probe.sceneId} · sample ${probe.sample}</h2>
      <img src="${probe.filename}" alt="${probe.variant} scene ${probe.sceneId} sample ${probe.sample}" />
      <p class="meta">${probe.gate.ok ? `${probe.gate.width}×${probe.gate.height}, aspect ${probe.gate.aspect.toFixed(3)}, variance ${probe.gate.luminanceVariance.toFixed(1)}` : `GATE FAILED: ${probe.gate.issues.join("; ")}`}</p>
      <p class="meta">red pixels: ${(probe.redPixelFraction * 100).toFixed(2)}% · cache nonce: ${probe.cacheNonce}</p>
      <ul class="checks">
        ${PASS_CRITERIA.map((criterion) => `<li><label><input type="checkbox" /> ${criterion}</label></li>`).join("\n        ")}
      </ul>
      <details><summary>Prompt</summary><pre>${probe.prompt.replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char])}</pre></details>
    </article>`,
    )
    .join("\n");

  const pending = `
    <section class="pending">
      <h2>Pending checks (same run, no extra image calls)</h2>
      <ul>
        ${KNOWN_ISSUES.map((issue) => `<li>${issue}</li>`).join("\n        ")}
        <li>Face-word slot lint: ${faceWordChecks.every((check) => check.faceWords.length === 0) ? "pass (no eyes, eye, nose, pupils, hair or gaze in any prompt)" : "FAIL"}</li>
        <li>Lead flat-cap lint: ${leadChecks.map((check) => `${check.variant}=${check.flatCapPass ? "pass" : check.flatCapIssues.join("; ")}`).join(" · ")}. ${leadChecks
          .filter((check) => check.issues.length > 0)
          .map(
            (check) =>
              `${check.variant} also has expected registry issues: ${check.issues.join("; ")}`,
          )
          .join(" ")}</li>
      </ul>
    </section>`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Next cue experiment — D/E</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #f7f5ef; color: #222; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.25rem; }
    .card { background: #fff; padding: 1rem; border: 1px solid #ddd; border-radius: 8px; }
    img { width: 100%; height: auto; border: 1px solid #eee; }
    .meta { color: #666; font-size: 0.85rem; }
    .checks { padding-left: 0; list-style: none; }
    pre { white-space: pre-wrap; font-size: 0.75rem; background: #f3f3f3; padding: 0.75rem; }
    .pending { margin-top: 2rem; background: #fff8d8; padding: 1rem; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Next cue experiment — variants D and E</h1>
  <p>Scenes 1 and 18, two fresh samples each. Every sample used a random cache nonce; a <code>fromCache=true</code> response aborts the run.</p>
  ${pending}
  <div class="grid">${cards}
  </div>
</body>
</html>
`;
  await writeFile(resolve(outputDir, "review.html"), html);
  console.log(
    `\nWrote ${probes.length} images and review.html to ${outputDir}`,
  );
}

main().catch((error) => {
  console.error(`\nNext cue experiment failed: ${error?.message ?? error}`);
  process.exit(1);
});
