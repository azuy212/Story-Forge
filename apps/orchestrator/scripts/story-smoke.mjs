#!/usr/bin/env node

/**
 * End-to-end smoke test for the Story-Forge stickman storytelling pipeline.
 *
 * Runs the WHOLE job (S1→S8) with deterministic fake agents plus fake TTS,
 * image and transcription providers that still produce REAL media: images come
 * from ffmpeg lavfi, narration from an ffmpeg sine wave, and the render,
 * ffprobe, blackdetect and silencedetect steps are the production ones. So the
 * timeline math, the single-pass render, the subtitle burn-in and every S8
 * validation check are exercised for real, with no paid call and no network.
 *
 * It then runs the job a SECOND time, unchanged, and asserts that every stage
 * was reused from its fingerprint and that no provider was called again — the
 * resumability guarantee, measured rather than asserted by inspection.
 *
 *   node scripts/story-smoke.mjs [--out-dir DIR] [--keep]
 *
 * Requires a build first: it imports the compiled dist/story/index.js.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { runStoryJob, tokenizeScript } from "../dist/story/index.js";

const exec = promisify(execFile);

const args = process.argv.slice(2);
const outDirFlag = args.indexOf("--out-dir");
const OUT_ROOT = resolve(
  outDirFlag >= 0 && args[outDirFlag + 1]
    ? args[outDirFlag + 1]
    : "/tmp/opencode/story-smoke",
);
const FAKE_ROOT = resolve(OUT_ROOT, "fake-provider");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A 77-word story for a 30 s / 150 wpm job (75-word budget, ±15% = 64–86).
 * Sentence lengths 8–11 words, no hard words, no technical terms.
 */
const STORY_SENTENCES = [
  "Columbus stood on the deck of a small wooden ship.",
  "The crew had not seen land for many days.",
  "They were tired, hungry, and very afraid.",
  "Some sailors wanted to turn the ship around and go home.",
  "Columbus asked them to wait one more night.",
  "That night a sailor saw a small light far away.",
  "In the morning they found a green island with tall trees.",
  "The long journey across the wide sea was finally over.",
];

const STORY = STORY_SENTENCES.join(" ");

const CLAIMS = [
  {
    claim: "Columbus commanded a small wooden sailing ship.",
    status: "established",
    hedgeInNarration: false,
  },
  {
    claim: "The crew went many days without seeing land.",
    status: "established",
    hedgeInNarration: false,
  },
  {
    claim: "A sailor sighted land in the morning.",
    status: "established",
    hedgeInNarration: false,
  },
];

/** sentence ids s1..s8 grouped into four ~19-word scenes. */
const GROUPING = [
  {
    sceneId: 1,
    sentenceIds: ["s1", "s2"],
    visualPurpose: "Show how small the ship is on the open sea.",
  },
  {
    sceneId: 2,
    sentenceIds: ["s3", "s4"],
    visualPurpose: "Show how tired and frightened the crew has become.",
  },
  {
    sceneId: 3,
    sentenceIds: ["s5", "s6"],
    visualPurpose:
      "Show the captain holding the crew back until a light appears.",
  },
  {
    sceneId: 4,
    sentenceIds: ["s7", "s8"],
    visualPurpose: "Show the green island reached at last.",
  },
];

const CHARACTERS = [
  {
    id: "columbus",
    name: "Columbus",
    role: "the captain",
    visualDescription: "A tall stick figure in a wide-brimmed black hat.",
  },
  {
    id: "the_crew",
    name: "The crew",
    role: "the tired sailors",
    visualDescription: "A cluster of weary stick figures in knitted caps.",
  },
];

const SLOT_DRAFTS = {
  1: {
    action:
      "Columbus stands at the rail of the small wooden ship and points ahead at the wide empty sea.",
    characters: [
      {
        id: "columbus",
        pose: "standing at the rail with one arm raised and pointing ahead",
        expression: "calm and hopeful, eyebrows lifted",
      },
    ],
    setting:
      "the deck of a small wooden sailing ship on open water in the late afternoon",
    props: ["a wooden rail", "coiled rope", "a tall mast"],
    lighting: "warm low sunlight across the deck",
    composition:
      "wide horizontal framing with the camera low behind the rail, ship and captain on the left third, calm empty sea across the bottom of the frame",
    metaphor: false,
  },
  2: {
    action:
      "Three sailors sit slumped against the mast while Columbus watches them from the helm.",
    characters: [
      {
        id: "columbus",
        pose: "standing behind the helm with both hands on the wheel",
        expression: "steady, mouth a flat line",
      },
      {
        id: "the_crew",
        pose: "slumped on the deck with heads lowered and knees drawn up",
        expression: "exhausted and anxious, mouths turned down",
      },
    ],
    setting:
      "the crowded deck of the small ship at dusk, sails slack above them",
    props: ["a coiled rope", "an empty wooden bowl"],
    lighting: "dim blue evening light with one warm lamp from below",
    composition:
      "wide horizontal framing from beside the mast, crew grouped in the right third and the helm behind them, calm deck boards across the bottom of the frame",
    metaphor: false,
  },
  3: {
    action:
      "A sailor grips the rail and leans out over the water as a tiny light glimmers on the horizon.",
    characters: [
      {
        id: "the_crew",
        pose: "leaning over the rail with one hand shielding the eyes",
        expression: "surprised, eyebrows raised high",
      },
    ],
    setting:
      "the bow of the ship at night, black water stretching to a faint glow far away",
    props: ["a wooden rail", "a hanging lantern"],
    lighting: "near-black night with a single cold glow on the horizon",
    composition:
      "wide horizontal framing at the bow, sailor on the left third and the far glow on the right, calm dark water across the bottom of the frame",
    metaphor: false,
  },
  4: {
    action:
      "The ship glides toward a green island of tall trees while the crew gathers at the rail.",
    characters: [
      {
        id: "columbus",
        pose: "standing at the bow with arms lowered at his sides",
        expression: "relieved, slight smile",
      },
      {
        id: "the_crew",
        pose: "clustered at the rail, one sailor waving an arm overhead",
        expression: "delighted, mouths open in cheer",
      },
    ],
    setting:
      "a calm bay beside a green island with tall trees in the early morning",
    props: ["a wooden rail", "rolled sailcloth"],
    lighting: "bright soft morning light",
    composition:
      "wide horizontal framing from behind the ship, island filling the right third and the crew at the rail on the left, calm water across the bottom of the frame",
    metaphor: false,
  },
};

function slotsFor(sceneId) {
  const draft = SLOT_DRAFTS[sceneId];
  assert.ok(draft, `no slot draft for scene ${sceneId}`);
  return { sceneId, ...draft };
}

// ---------------------------------------------------------------------------
// Fake providers (real media, no network, no paid call)
// ---------------------------------------------------------------------------

const counts = {
  writeStory: 0,
  verifyStory: 0,
  planScenes: 0,
  designCharacters: 0,
  planSceneVisuals: 0,
  image: 0,
  tts: 0,
  align: 0,
};

const PALETTE = [
  "0x1F2937",
  "0xC2410C",
  "0x1D4ED8",
  "0x15803D",
  "0x7C3AED",
  "0xB91C1C",
  "0x0F766E",
];

const fakeAgents = {
  async writeStory() {
    counts.writeStory += 1;
    return {
      data: { title: "The Long Night at Sea", story: STORY, claims: CLAIMS },
      telemetry: { model: "fake/story-author" },
    };
  },
  async verifyStory() {
    counts.verifyStory += 1;
    return {
      data: { issues: [] },
      telemetry: { model: "fake/story-verifier" },
    };
  },
  async planScenes() {
    counts.planScenes += 1;
    return {
      data: { scenes: GROUPING },
      telemetry: { model: "fake/scene-planner" },
    };
  },
  async designCharacters() {
    counts.designCharacters += 1;
    return {
      data: { characters: CHARACTERS },
      telemetry: { model: "fake/character-designer" },
    };
  },
  async planSceneVisuals(input) {
    counts.planSceneVisuals += 1;
    return {
      data: slotsFor(input.sceneId),
      telemetry: { model: "fake/visual-planner" },
    };
  },
};

const fakeAssetProvider = {
  capabilities: { referenceImages: true, imageEditing: true },
  async generateImage(options) {
    counts.image += 1;
    const dir = resolve(FAKE_ROOT, "images", options.runId ?? "run");
    await mkdir(dir, { recursive: true });
    const out = resolve(
      dir,
      options.filename ?? `scene-${options.sceneId}.png`,
    );
    const seed = Math.abs(options.sceneId) % PALETTE.length;
    const filter = [
      "color=c=0xEEE8DC:s=1920x1080",
      `drawbox=x=${120 + ((options.sceneId * 137) % 1100)}:y=${300 + ((options.sceneId * 61) % 300)}:w=420:h=360:color=${PALETTE[seed]}:t=fill`,
      `drawbox=x=${700 + seed * 40}:y=180:w=260:h=220:color=0x111827:t=fill`,
    ].join(",");
    await exec("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      filter,
      "-frames:v",
      "1",
      out,
    ]);
    return { url: out };
  },
  async generateVideo() {
    throw new Error(
      "the story pipeline never requests video from the asset provider",
    );
  },
};

/** Scene duration the fake engine produces: 0.4 s/word at 150 wpm. */
function fakeDurationSec(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.8, words * 0.4);
}

const fakeTtsProvider = {
  cacheFingerprint: () => "story-smoke-tts-v1",
  async synthesize(options) {
    counts.tts += 1;
    const dir = resolve(FAKE_ROOT, "audio", options.runId ?? "run");
    await mkdir(dir, { recursive: true });
    const out = resolve(dir, options.filename ?? "part.wav");
    const durationSec = fakeDurationSec(options.text);
    const sceneKey = options.filename?.match(/scene-(\d{3})/)?.[1];
    if (sceneKey) {
      const previous = narrationByScene.get(sceneKey);
      narrationByScene.set(
        sceneKey,
        previous ? `${previous} ${options.text}` : options.text,
      );
    }
    await exec("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${durationSec}`,
      "-ac",
      "1",
      "-ar",
      "48000",
      "-c:a",
      "pcm_s16le",
      out,
    ]);
    return { audioUrl: out, durationMs: Math.round(durationSec * 1000) };
  },
};

async function ffprobeDurationSec(path) {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    path,
  ]);
  return Number(JSON.parse(stdout).format.duration);
}

/** Deterministic "forced alignment": the script's own tokens, evenly spread. */
const narrationByScene = new Map();
let simulatedSkipPending = true;
const fakeTranscriber = {
  async align(audioUrl, narration) {
    counts.align += 1;
    const durationSec = await ffprobeDurationSec(audioUrl);
    // The free ASR pass sends no script; the fake TTS recorded the text it
    // spoke into this chunk, so the fake can behave like a perfect
    // transcriber. One free pass deliberately drops the second half once, to
    // exercise the automatic re-synthesis.
    const sceneKey = audioUrl.match(/scene-(\d{3})/)?.[1];
    const text =
      narration ??
      (sceneKey ? narrationByScene.get(sceneKey) : undefined) ??
      "";
    const tokens = tokenizeScript(text);
    if (
      narration === undefined &&
      simulatedSkipPending &&
      audioUrl.includes("scene-002.wav")
    ) {
      simulatedSkipPending = false;
      tokens.splice(Math.ceil(tokens.length / 2));
    }
    const count = Math.max(1, tokens.length);
    const slice = durationSec / count;
    const round3 = (value) => Math.round(value * 1000) / 1000;
    return {
      wordTimestamps: tokens.map((word, index) => ({
        word,
        start: round3(index * slice),
        end: round3((index + 1) * slice),
        score: 1,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err?.message ?? String(err) });
    console.log(`  FAIL ${name}\n       ${err?.message ?? err}`);
  }
}

async function main() {
  await rm(OUT_ROOT, { recursive: true, force: true });
  await mkdir(OUT_ROOT, { recursive: true });

  const baseOptions = {
    topic: "The long night at sea",
    duration: 30,
    language: "en",
    jobId: "smoke",
    outputDir: OUT_ROOT,
    agents: fakeAgents,
    assetProvider: fakeAssetProvider,
    ttsProvider: fakeTtsProvider,
    transcriber: fakeTranscriber,
    imageProviderLabel: "fake-lavfi",
  };

  console.log(`\nstory-smoke: out=${OUT_ROOT}\n`);
  console.log("pass 1 — full job");
  const started = Date.now();
  const first = await runStoryJob(baseOptions);
  const firstMs = Date.now() - started;
  const countsAfterFirst = { ...counts };

  const manifest = first.manifest;
  const jobDir = first.jobDir;

  await check("job reports complete", () =>
    assert.equal(first.status, "complete"),
  );
  await check("final.mp4 exists", async () => {
    const info = await stat(first.finalVideo);
    assert.ok(info.size > 50_000, `final.mp4 is only ${info.size} bytes`);
  });
  await check("every stage is done", () => {
    for (const stage of [
      "S1_input",
      "S2_story",
      "S3_scenes",
      "S4_visual_plan",
      "S5_images",
      "S6_audio",
      "S7_align",
      "S8_render",
    ]) {
      assert.equal(
        manifest.stages[stage]?.status,
        "done",
        `${stage} is ${manifest.stages[stage]?.status}`,
      );
    }
  });
  await check("render validations all passed", () => {
    assert.equal(manifest.render?.validations.passed, true);
    for (const entry of manifest.render?.validations.checks ?? []) {
      // Warning checks are reported but cannot fail the job (the frame-vs-source
      // comparison is still being tuned on real Gemini images).
      if (entry.severity === "warning") continue;
      assert.ok(entry.passed, `${entry.name}: ${entry.detail}`);
    }
    assert.ok(
      (manifest.render?.validations.checks ?? []).length >= 10,
      "expected at least 10 validation checks",
    );
  });
  await check("four scenes, one image and one chunk each", () => {
    assert.equal(manifest.scenes.length, 4);
    for (const scene of manifest.scenes) {
      assert.equal(scene.status.image, "done");
      assert.equal(scene.status.audio, "done");
      assert.equal(scene.status.transcript, "done");
    }
  });
  await check("narration was rebuilt from sentence ids, not model text", () => {
    const joined = manifest.scenes.map((scene) => scene.narration).join(" ");
    assert.equal(joined, STORY);
  });
  await check("scene image gate recorded real source dimensions", () => {
    for (const scene of manifest.scenes) {
      assert.ok(
        scene.image.width >= 1000 && scene.image.height >= 540,
        "image below the DP4 gate",
      );
      assert.ok(
        scene.image.aspect >= 1.6 && scene.image.aspect <= 1.9,
        `aspect ${scene.image.aspect}`,
      );
      assert.ok(scene.image.luminanceVariance >= 8, "image looks blank");
    }
  });
  await check(
    "subtitles: cues exist, never overlap, respect the minimum duration",
    async () => {
      const cues = parseSrt(
        await readFileSafe(resolve(jobDir, "subtitles.srt")),
      );
      assert.ok(cues.length >= 4, `only ${cues.length} cues`);
      for (let index = 0; index < cues.length; index++) {
        const cue = cues[index];
        assert.ok(cue.endMs > cue.startMs, `cue ${cue.index} has no duration`);
        assert.ok(
          cue.endMs - cue.startMs >= 800 || index === cues.length - 1,
          `cue ${cue.index} is shorter than 800 ms`,
        );
        const next = cues[index + 1];
        if (next)
          assert.ok(
            cue.endMs <= next.startMs,
            `cue ${cue.index} overlaps cue ${next.index}`,
          );
      }
    },
  );
  await check("subtitle text comes from the script", async () => {
    const srt = await readFileSafe(resolve(jobDir, "subtitles.srt"));
    for (const word of ["Columbus", "island"]) {
      assert.ok(srt.includes(word), `subtitles are missing "${word}"`);
    }
  });
  await check("timeline is contiguous and covers the audio", () => {
    const scenes = manifest.scenes;
    assert.equal(scenes[0].timing.startFrame, 0);
    for (let index = 1; index < scenes.length; index++) {
      assert.equal(
        scenes[index].timing.startFrame,
        scenes[index - 1].timing.endFrame,
      );
    }
    const lastFrame = scenes[scenes.length - 1].timing.endFrame;
    assert.equal(
      lastFrame,
      Math.ceil(manifest.audio.durationSec * manifest.config.fps),
    );
  });
  await check("alignment matched every scene", () => {
    assert.equal(manifest.subtitles.overallMatchRatio, 1);
    for (const scene of manifest.scenes)
      assert.equal(scene.transcript.method, "aligned");
  });
  await check("free ASR verified every narration chunk", () => {
    for (const scene of manifest.scenes)
      assert.equal(scene.audio.asrCoverage, 1);
    assert.equal(
      manifest.warnings.some((warning) => warning.includes("free ASR")),
      false,
    );
  });
  await check("a low-coverage chunk was re-synthesized once", () => {
    assert.equal(manifest.scenes[1].audio.resynthesized, true);
    assert.equal(manifest.scenes[1].audio.asrCoverage, 1);
  });
  await check("no voice outliers were flagged", () => {
    const flagged = manifest.warnings.filter((warning) =>
      warning.includes("voice drift"),
    );
    assert.deepEqual(flagged, []);
  });
  await check("manifest records the unverified grounding source", () => {
    assert.equal(manifest.groundingSource, "model-knowledge");
    assert.equal(manifest.unverified, true);
  });

  const ffprobeJson = JSON.parse(
    (
      await exec("ffprobe", [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        first.finalVideo,
      ])
    ).stdout,
  );

  console.log("\npass 2 — resume with nothing changed");
  const second = await runStoryJob(baseOptions);
  await check("second run is complete too", () =>
    assert.equal(second.status, "complete"),
  );
  await check("no agent or provider was called again", () => {
    for (const [key, value] of Object.entries(counts)) {
      assert.equal(
        value,
        countsAfterFirst[key],
        `${key} was called again (${countsAfterFirst[key]} → ${value})`,
      );
    }
  });
  await check("every stage fingerprint is unchanged and reused", () => {
    for (const stage of Object.keys(manifest.stages)) {
      assert.equal(
        second.manifest.stages[stage].fingerprint,
        manifest.stages[stage].fingerprint,
        `${stage} fingerprint changed`,
      );
      assert.equal(second.manifest.stages[stage].status, "done");
    }
  });

  console.log("\npass 3 — force S5/S6/S7 and prove per-scene artifact reuse");
  const third = await runStoryJob({
    ...baseOptions,
    stages: ["S5_images", "S6_audio", "S7_align"],
  });
  await check("forced rerun still reports complete", () =>
    assert.equal(third.status, "complete"),
  );
  await check("the forced stages actually re-ran", () => {
    assert.equal(third.manifest.stages.S5_images.status, "done");
    assert.equal(third.manifest.stages.S6_audio.status, "done");
    assert.equal(third.manifest.stages.S7_align.status, "done");
  });
  await check("every image was reused, not regenerated", () => {
    assert.equal(third.manifest.stages.S5_images.metrics.reused, 4);
    assert.equal(third.manifest.stages.S5_images.metrics.generated, 0);
    assert.equal(counts.image, countsAfterFirst.image);
  });
  await check("every narration chunk was reused, not re-synthesized", () => {
    assert.equal(third.manifest.stages.S6_audio.metrics.chunks, 4);
    assert.equal(counts.tts, countsAfterFirst.tts);
  });
  await check("every transcript was reused, not re-aligned", () => {
    assert.equal(counts.align, countsAfterFirst.align);
  });

  console.log("\npass 4 — interrupt mid-image-generation, then resume");
  const interruptDir = resolve(OUT_ROOT, "interrupt");
  const interruptOptions = {
    ...baseOptions,
    jobId: "interrupt-smoke",
    outputDir: interruptDir,
  };
  const interruptJobDir = resolve(interruptDir, "interrupt-smoke");

  // Fail on the third image: two scenes finish, the stage dies mid-way.
  let passCalls = 0;
  const flakyAssetProvider = {
    ...fakeAssetProvider,
    async generateImage(options) {
      passCalls += 1;
      if (passCalls > 2) throw new Error("simulated provider outage");
      return fakeAssetProvider.generateImage(options);
    },
  };

  await check("the interrupted run fails loudly", () =>
    assert.rejects(() =>
      runStoryJob({ ...interruptOptions, assetProvider: flakyAssetProvider }),
    ),
  );
  await check("the first two images survived on disk", async () => {
    const files = await readdir(resolve(interruptJobDir, "images"));
    assert.deepEqual(files.sort(), ["scene-001.png", "scene-002.png"]);
  });

  const countsAfterCrash = { ...counts };
  const resumed = await runStoryJob(interruptOptions);
  await check("the resumed run completes the job", () =>
    assert.equal(resumed.status, "complete"),
  );
  await check("only the missing scenes were regenerated", () => {
    assert.equal(resumed.manifest.stages.S5_images.metrics.reused, 2);
    assert.equal(resumed.manifest.stages.S5_images.metrics.generated, 2);
    assert.equal(counts.image - countsAfterCrash.image, 2);
  });
  await check("the crash did not re-run the text stages", () => {
    for (const key of [
      "writeStory",
      "verifyStory",
      "planScenes",
      "designCharacters",
      "planSceneVisuals",
    ]) {
      assert.equal(
        counts[key],
        countsAfterCrash[key],
        `${key} re-ran after resume`,
      );
    }
  });

  console.log(`\njob dir:      ${jobDir}`);
  console.log(`first pass:   ${(firstMs / 1000).toFixed(1)}s`);
  console.log(`provider calls: ${JSON.stringify(counts)}`);
  console.log(`\nffprobe ${first.finalVideo}`);
  console.log(
    `  format: duration=${ffprobeJson.format.duration} size=${ffprobeJson.format.size} bit_rate=${ffprobeJson.format.bit_rate}`,
  );
  for (const stream of ffprobeJson.streams) {
    console.log(
      `  ${stream.codec_type}: ${stream.codec_name} ${stream.width ?? ""}x${stream.height ?? ""} ${stream.pix_fmt ?? ""} ${stream.avg_frame_rate ?? ""} ${stream.sample_rate ?? ""}Hz`,
    );
  }

  console.log("\nS8 validation report");
  for (const entry of manifest.render.validations.checks) {
    const label = entry.passed
      ? "ok  "
      : entry.severity === "warning"
        ? "WARN"
        : "FAIL";
    console.log(`  ${label} ${entry.name}: ${entry.detail}`);
  }

  const artifacts = [
    "manifest.json",
    "story.json",
    "claims.json",
    "characters.json",
    "scenes.json",
    "transcript.json",
    "subtitles.ass",
    "subtitles.srt",
    "final.mp4",
    "audio/narration.wav",
    "images/scene-001.png",
  ];
  const present = [];
  for (const artifact of artifacts) {
    try {
      await stat(resolve(jobDir, artifact));
      present.push(artifact);
    } catch {
      present.push(`${artifact} (MISSING)`);
    }
  }
  console.log(`\nartifacts\n  ${present.join("\n  ")}`);

  await writeFile(
    resolve(OUT_ROOT, "smoke-report.json"),
    `${JSON.stringify(
      {
        jobDir,
        firstPassMs: firstMs,
        providerCalls: counts,
        ffprobe: ffprobeJson,
        stages: manifest.stages,
        validations: manifest.render.validations,
        warnings: manifest.warnings,
        errors: manifest.errors,
        sceneTiming: manifest.scenes.map((scene) => ({
          sceneId: scene.sceneId,
          words: scene.wordCount,
          durationSec: scene.audio.durationSec,
          startFrame: scene.timing.startFrame,
          endFrame: scene.timing.endFrame,
        })),
        results,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  const failed = results.filter((entry) => !entry.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  if (failed.length > 0) {
    console.log("failed checks:");
    for (const entry of failed)
      console.log(`  - ${entry.name}: ${entry.detail}`);
    process.exit(1);
  }
}

async function readFileSafe(path) {
  return readFile(path, "utf-8");
}

/** Minimal SRT reader (the smoke test asserts on the pipeline's own output). */
function parseSrt(text) {
  const cues = [];
  for (const block of text.trim().split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const timing =
      /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(
        lines[1] ?? "",
      );
    if (!timing) continue;
    const toMs = (h, m, s, ms) =>
      ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
    cues.push({
      index: Number(lines[0]),
      startMs: toMs(timing[1], timing[2], timing[3], timing[4]),
      endMs: toMs(timing[5], timing[6], timing[7], timing[8]),
      text: lines.slice(2).join(" "),
    });
  }
  return cues;
}

main().catch((err) => {
  console.error(`\nstory-smoke failed: ${err?.stack ?? err}`);
  process.exit(1);
});
