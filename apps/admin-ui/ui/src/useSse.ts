import { useEffect, useRef, useState } from "react";

type Options = {
  onMessage?: (event: string, data: unknown) => void;
  enabled?: boolean;
};

export function useSse(url: string | null, options: Options = {}) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    if (!url || options.enabled === false) return;
    const es = new EventSource(url);
    esRef.current = es;
    es.onopen = () => {
      setConnected(true);
      setError(null);
    };
    es.onerror = () => {
      setConnected(false);
      setError("disconnected");
    };
    es.onmessage = (e) => {
      try {
        optsRef.current.onMessage?.("message", JSON.parse(e.data));
      } catch {
        // ignore malformed
      }
    };
    const named = ["log", "child", "stderr", "error"];
    for (const name of named) {
      es.addEventListener(name, (e) => {
        try {
          optsRef.current.onMessage?.(name, JSON.parse((e as MessageEvent).data));
        } catch {
          // ignore
        }
      });
    }
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [url, options.enabled]);

  return { connected, error };
}
