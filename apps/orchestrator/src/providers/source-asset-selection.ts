import type { SceneEntity, SourceAsset } from "../schemas/production.js";

export const TYPE_HINT: Record<string, string> = {
  person: "",
  place: "city",
  object: "",
  organization: "",
  product: "",
  document: "",
  landmark: "landmark",
  other: "",
};

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function substringMatch(wanted: string[], haystack: Set<string>): number {
  let matches = 0;
  for (const w of wanted) {
    for (const h of haystack) {
      if (h === w || h.includes(w) || w.includes(h)) {
        matches++;
        break;
      }
    }
  }
  return matches;
}

function relevance(entity: SceneEntity, asset: SourceAsset): number {
  const wanted = tokens(entity.name);
  const haystack = new Set(
    tokens(
      [asset.title, asset.attribution, asset.url].filter(Boolean).join(" "),
    ),
  );
  if (wanted.length === 0 || haystack.size === 0) return 0;
  const matches = substringMatch(wanted, haystack);
  return matches / wanted.length;
}

function hasHintMatch(entity: SceneEntity, asset: SourceAsset): boolean {
  const hint = TYPE_HINT[entity.type];
  if (!hint) return false;
  const haystack = [asset.title, asset.attribution, asset.url]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(hint.toLowerCase());
}

export function scoreSourceAsset(
  entity: SceneEntity,
  asset: SourceAsset,
): number {
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  const pixels = width * height;
  const title = (asset.title ?? "").toLowerCase();
  const rel = relevance(entity, asset);
  const hintMatch = hasHintMatch(entity, asset);
  let score = rel * 100;

  if (rel === 0 && hintMatch) {
    score = 5;
  }

  if (entity.type === "person") {
    if (height >= width) score += 18;
    if (pixels >= 1_000_000) score += 12;
  } else if (pixels >= 1_000_000) {
    score += 8;
  }

  if (asset.license) score += 4;
  if (asset.attribution) score += 4;
  if (/\b(logo|icon|flag|map|diagram|symbol|coat of arms)\b/.test(title)) {
    score -= 40;
  }

  return score;
}

export function selectBestSourceAsset(
  entity: SceneEntity,
  assets: SourceAsset[],
): SourceAsset | undefined {
  return [...assets]
    .filter(
      (asset) =>
        asset.url &&
        relevance(entity, asset) > 0 &&
        (asset.width ?? 0) > 0 &&
        (asset.height ?? 0) > 0 &&
        !/\b(logo|icon|diagram|symbol|coat of arms)\b/i.test(asset.title ?? ""),
    )
    .sort((a, b) => {
      const scoreDelta =
        scoreSourceAsset(entity, b) - scoreSourceAsset(entity, a);
      return scoreDelta || a.id.localeCompare(b.id);
    })[0];
}
