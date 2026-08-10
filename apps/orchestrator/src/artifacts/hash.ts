import { createHash } from "node:crypto";

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  function stringify(v: unknown): string {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    const t = typeof v;
    if (t === "string") return JSON.stringify(v);
    if (t === "number" || t === "boolean") return String(v);
    if (t === "bigint") return v.toString();
    if (t === "function") return v.toString();
    if (Array.isArray(v)) {
      return `[${v.map(stringify).join(",")}]`;
    }
    if (typeof v === "object") {
      if (seen.has(v)) return '"[Circular]"';
      seen.add(v);
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k])}`).join(",")}}`;
    }
    return '"[Unknown]"';
  }

  return stringify(value);
}

export function hashObject(obj: unknown): string {
  return createHash("sha256").update(stableStringify(obj)).digest("hex");
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
