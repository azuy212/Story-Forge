const captured = [];

export const logger = {
  setRunContext: () => {},
  getCurrentSink: () => null,
  setSink: () => {},
  info: (msg) => captured.push({ level: "info", message: msg }),
  warn: (msg) => captured.push({ level: "warn", message: msg }),
  error: (msg) => {
    captured.push({ level: "error", message: msg });
    console.log(JSON.stringify({ level: "error", message: msg }));
  },
  debug: () => {},
  nodeStart: () => {},
  nodeDone: () => {},
  nodePhase: () => {},
  nodeRetry: () => {},
  nodeSkipped: () => {},
  nodeIncomplete: () => {},
  nodeFailed: () => {},
  finalize: () => {},
  _captured: captured,
};
