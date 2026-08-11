import type { SceneEntity, SourceAsset } from "../schemas/production.js";

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function relevance(entity: SceneEntity, asset: SourceAsset): number {
  const wanted = tokens(entity.name);
  const haystack = new Set(
    tokens(
      [asset.title, asset.attribution, asset.url].filter(Boolean).join(" "),
    ),
  );
  if (wanted.length === 0 || haystack.size === 0) return 0;
  return wanted.filter((token) => haystack.has(token)).length / wanted.length;
}

export function scoreSourceAsset(
  entity: SceneEntity,
  asset: SourceAsset,
): number {
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  const pixels = width * height;
  const title = (asset.title ?? "").toLowerCase();
  let score = relevance(entity, asset) * 100;

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
