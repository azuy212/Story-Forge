import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import type { NextInLine, SheetPayload, SheetProfile, SheetSnapshot } from "@/lib/sheet-types";

const POLL_MS = 30_000;

type State = {
  snapshot: SheetSnapshot | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
};

type Ctx = State & {
  refresh: () => Promise<void>;
  payload: (profile: SheetProfile) => SheetPayload | null;
  nextInLine: (profile: SheetProfile) => NextInLine | null;
};

const SheetContext = createContext<Ctx | undefined>(undefined);

function normalize(raw: Record<string, unknown> | null): SheetSnapshot | null {
  if (!raw) return null;
  const out: SheetSnapshot = {
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : new Date().toISOString(),
    stale: Boolean(raw.stale),
    staleError: (raw.staleError as string | null | undefined) ?? null,
  };
  if (raw.error) {
    out.error = String(raw.error);
    if (raw.message) out.message = String(raw.message);
  }
  for (const p of ["short", "long"] as const) {
    const block = raw[p] as Record<string, unknown> | undefined;
    if (!block || typeof block !== "object") continue;
    out[p] = {
      sheetName: String(block.sheetName ?? ""),
      records: Array.isArray(block.records) ? (block.records as SheetPayload["records"]) : [],
      error: typeof block.error === "string" ? block.error : undefined,
    };
  }
  return out;
}

function pickNext(payload: SheetPayload | null): NextInLine | null {
  if (!payload) return null;
  const profile: SheetProfile = payload.sheetName?.toLowerCase().includes("long")
    ? "long"
    : "short";
  for (const r of payload.records) {
    if (r.status !== "planned") continue;
    return {
      profile,
      topic: r.topic,
      category: r.category,
      videoId: r.videoId,
      scheduledAt: r.scheduledAt,
      scheduledAtLocal: r.scheduledAtLocal,
      rowExists: true,
    };
  }
  return {
    profile,
    topic: "",
    category: "",
    videoId: "",
    scheduledAt: "",
    scheduledAtLocal: "",
    rowExists: false,
  };
}

export function SheetProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({
    snapshot: null,
    loading: false,
    error: null,
    lastFetchedAt: null,
  });
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    const p = (async () => {
      try {
        const raw = await api.sheets.fetch();
        const snap = normalize(raw);
        setState({
          snapshot: snap,
          loading: false,
          error: snap?.error ?? null,
          lastFetchedAt: Date.now(),
        });
      } catch (e) {
        setState((s) => ({
          ...s,
          loading: false,
          error: (e as Error).message,
        }));
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = p;
    return p;
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const value = useMemo<Ctx>(
    () => ({
      ...state,
      refresh,
      payload: (profile) => state.snapshot?.[profile] ?? null,
      nextInLine: (profile) => pickNext(state.snapshot?.[profile] ?? null),
    }),
    [state, refresh],
  );

  return <SheetContext.Provider value={value}>{children}</SheetContext.Provider>;
}

export function useSheet() {
  const ctx = useContext(SheetContext);
  if (!ctx) throw new Error("useSheet must be used within SheetProvider");
  return ctx;
}