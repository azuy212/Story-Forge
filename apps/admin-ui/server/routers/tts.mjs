import proxy from "@fastify/http-proxy";

const TARGET = process.env.TTS_URL ?? "http://localhost:8010";

export async function ttsRouter(app) {
  app.register(proxy, {
    upstream: TARGET,
    prefix: "/",
    rewritePrefix: "",
  });
}
