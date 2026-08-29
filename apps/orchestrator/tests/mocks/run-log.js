// Module shim: jest's `tests/mocks/logger.js` is mapped to `../dist/utils/logger.js`.
// run-next.mjs also imports `../dist/utils/run-log.js`; map it to a no-op so the
// script can be loaded in unit tests without spinning up real file I/O.
export function closeAllRunLogSinks() {
  return Promise.resolve();
}

export function openRunLogSink() {
  return Promise.resolve(null);
}

export function getRunLogSink() {
  return null;
}

export function closeRunLogSink() {
  return Promise.resolve();
}

export function resetRunLogSinks() {}

export function appendRunLogEvent() {}

export function withProviderLog(_sink, _event, fn) {
  return fn();
}

export function sanitizeHeaders(headers) {
  if (!headers) return {};
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/authorization|cookie|api-key|auth-token/i.test(name)) {
      out[name] = "***";
    } else {
      out[name] = value;
    }
  }
  return out;
}

export function truncateLogBody(body) {
  return body;
}

export function getRunLogSinkFromConfig() {
  return null;
}

export function getRunLogContextFromConfig() {
  return {};
}
