import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createModel, type GenerateOptions } from "../models/model-factory.js";
import { loadPrompt } from "../utils/load-prompt.js";
import { renderPrompt } from "../utils/render-prompt.js";
import { runFfmpeg } from "../providers/composer/ffmpeg/ffmpeg.js";
import { PromptPaths } from "../models/prompt-paths.js";
import { AgentModel } from "../models/agent-model.js";
import { ThumbnailQaSchema } from "../schemas/thumbnail-qa.js";
import { LLMError, getErrorMessage } from "../utils/errors.js";

export interface ThumbnailQaResult {
  status: "pass" | "fail";
  issues: string[];
}

const QA_MAX_EDGE = 432;
const QA_DIR = path.resolve("generated", "assets", "qa");

async function downscaleToDataUrl(inputPath: string): Promise<string> {
  const uniqueName = `${path.basename(inputPath, path.extname(inputPath))}-${randomUUID()}.qa.png`;
  const out = path.join(QA_DIR, uniqueName);
  await fs.promises.mkdir(QA_DIR, { recursive: true });
  await runFfmpeg({
    args: [
      "-y",
      "-i",
      inputPath,
      "-vf",
      `scale='min(${QA_MAX_EDGE},iw)':-2`,
      "-frames:v",
      "1",
      "-c:v",
      "png",
      out,
    ],
    description: "downscale thumbnail for QA",
    timeout: 60_000,
  });
  const buffer = await fs.promises.readFile(out);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export async function runThumbnailQa(
  imagePath: string,
  thumbnailText: string,
): Promise<ThumbnailQaResult> {
  const template = await loadPrompt(PromptPaths.ThumbnailQA);
  const userPrompt = renderPrompt(template, { thumbnailText });

  const imageDataUrl = await downscaleToDataUrl(imagePath);
  const model = createModel(AgentModel.ThumbnailQA);
  const genOpts: GenerateOptions = {
    temperature: 0.0,
    responseFormat: { type: "json_object" },
  };

  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: userPrompt },
        { type: "image_url" as const, image_url: { url: imageDataUrl } },
      ],
    },
  ];

  try {
    const response = await model.generate(messages as never, genOpts);
    const raw = response?.choices?.[0]?.message?.content;
    if (!raw) throw new LLMError("Empty QA response");
    const result = ThumbnailQaSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      throw new LLMError(`QA schema invalid: ${result.error.message}`);
    }
    return { status: result.data.status, issues: result.data.issues ?? [] };
  } catch (err) {
    throw new Error(`Thumbnail QA failed: ${getErrorMessage(err)}`, {
      cause: err,
    });
  }
}
