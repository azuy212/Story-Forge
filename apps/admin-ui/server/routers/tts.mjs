import proxy from "@fastify/http-proxy";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = process.env.TTS_URL ?? "http://localhost:8010";
const __dirname = dirname(fileURLToPath(import.meta.url));
const TTS_ROOT = join(__dirname, "..", "..", "..", "tts");
const VOICES_DIR = join(TTS_ROOT, "app", "voices");

export async function ttsRouter(app) {
  app.register(proxy, { upstream: TARGET, prefix: "/", rewritePrefix: "" });

  app.get("/voices", async () => {
    if (!existsSync(VOICES_DIR)) return { voices: [] };
    const files = readdirSync(VOICES_DIR)
      .filter((f) => /\.(wav|mp3|flac)$/i.test(f))
      .map((f) => ({ name: f, size: statSync(join(VOICES_DIR, f)).size }));
    return { voices: files };
  });
}
