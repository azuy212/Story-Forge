import proxy from "@fastify/http-proxy";

const TARGET = process.env.TRANSCRIBER_URL ?? "http://localhost:8030";

export async function transcriberRouter(app) {
  app.register(proxy, {
    upstream: TARGET,
    prefix: "/",
    rewritePrefix: "",
  });
}
