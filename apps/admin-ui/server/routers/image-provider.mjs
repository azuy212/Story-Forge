import proxy from "@fastify/http-proxy";

const TARGET = process.env.IMAGE_PROVIDER_URL ?? "http://localhost:8020";

export async function imageProviderRouter(app) {
  app.register(proxy, {
    upstream: TARGET,
    prefix: "/",
    rewritePrefix: "",
  });
}
