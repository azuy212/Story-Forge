import { z } from "zod";

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** Separator-free form, so `3D`, `3d`, `3-d` and `3 d` all collapse together. */
function squashKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface LenientEnumConfig<T extends string> {
  /**
   * Extra spellings mapped onto a canonical option. Keys are normalized with
   * `normalizeKey`, so `Photo Realistic` and `photo_realistic` both work.
   */
  aliases?: Record<string, T>;
  /** Value used when nothing matches. Must be one of the canonical options. */
  fallback: T;
}

/**
 * Build a tolerant enum field for LLM-produced JSON.
 *
 * Small models routinely invent spellings for enum members (`Photorealistic`,
 * `photo-real`, `3d`, `Archive`). A strict `z.enum` rejects the whole payload
 * over a cosmetic difference, which burns the node's entire revision budget
 * and ends the run. This resolves casing/spacing drift, applies an alias table,
 * and falls back to a safe canonical option instead of failing.
 *
 * Implemented as `z.string().transform()` rather than `z.preprocess()` on
 * purpose: `z.preprocess` widens the schema's *input* type to `unknown`,
 * which leaks through every `z.input<>`-derived state type in this package
 * (`Scene`, `SceneEntity`, `VisualPlanEntry`). With a transform the input type
 * stays `string` — honest for raw LLM JSON — while the *output* type remains
 * the exact literal union, so validated artifacts stay exhaustively typed.
 *
 * Non-string values still fail validation: only string-shaped drift is
 * forgiven, never a structurally wrong type.
 */
export function lenientEnum<const T extends readonly [string, ...string[]]>(
  options: T,
  config: LenientEnumConfig<T[number]>,
) {
  const lookup = new Map<string, T[number]>(
    options.map((o) => [normalizeKey(o), o]),
  );
  for (const [from, to] of Object.entries(config.aliases ?? {})) {
    lookup.set(normalizeKey(from), to);
  }
  const squashed = new Map<string, T[number]>(
    options.map((o) => [squashKey(o), o]),
  );
  for (const [from, to] of Object.entries(config.aliases ?? {})) {
    squashed.set(squashKey(from), to);
  }

  const resolve = (value: string): T[number] =>
    lookup.get(normalizeKey(value)) ??
    squashed.get(squashKey(value)) ??
    config.fallback;

  return z.string().transform(resolve);
}
