import Fastify from "fastify";
import cors from "@fastify/cors";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { orchestratorRouter } from "./routers/orchestrator.mjs";
import { imageProviderRouter } from "./routers/image-provider.mjs";
import { ttsRouter } from "./routers/tts.mjs";
import { transcriberRouter } from "./routers/transcriber.mjs";
import { sheetsRouter } from "./routers/sheets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIST = join(__dirname, "..", "dist", "ui");

const PORT = Number(process.env.ADMIN_UI_PORT ?? 2025);

const app = Fastify({ logger: { level: "info" } });

await app.register(cors, { origin: true, credentials: true });

await app.register(orchestratorRouter, { prefix: "/api/orchestrator" });
await app.register(imageProviderRouter, { prefix: "/api/image-provider" });
await app.register(ttsRouter, { prefix: "/api/tts" });
await app.register(transcriberRouter, { prefix: "/api/transcriber" });
await app.register(sheetsRouter, { prefix: "/api/sheets" });

app.get("/api/health", async () => ({ status: "ok", service: "admin-ui" }));

if (existsSync(UI_DIST)) {
  try {
    const { default: fastifyStatic } = await import("@fastify/static");
    await app.register(fastifyStatic, { root: UI_DIST, prefix: "/" });
  } catch (err) {
    app.log.warn({ err }, "@fastify/static not available; serving API only");
  }
}

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith("/api/")) {
    reply.code(404).send({ error: "not_found" });
    return;
  }
  reply.code(200).type("text/html").send("<h1>admin-ui</h1><p>API at /api</p>");
});

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  app.log.info(`admin-ui server listening on http://127.0.0.1:${PORT}`);
});
