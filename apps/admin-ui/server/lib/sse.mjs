export function sseHeaders(reply) {
  reply.raw.setHeader("content-type", "text/event-stream");
  reply.raw.setHeader("cache-control", "no-cache, no-transform");
  reply.raw.setHeader("connection", "keep-alive");
  reply.raw.setHeader("x-accel-buffering", "no");
  reply.raw.flushHeaders?.();
}

export function sseSend(reply, event, data) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function sseComment(reply, text = "") {
  reply.raw.write(`: ${text}\n\n`);
}

export function heartbeat(reply) {
  const t = setInterval(() => sseComment(reply, "hb"), 15_000);
  return () => clearInterval(t);
}
