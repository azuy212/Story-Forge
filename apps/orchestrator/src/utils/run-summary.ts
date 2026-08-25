export interface RunData {
  production?: {
    scenes?: Array<{
      generationStatus?: string;
      assetUrl?: string;
    }>;
  };
  video?: {
    durationSec?: number;
  };
}

export function buildSummary(data: RunData | undefined): string | undefined {
  if (!data) return undefined;

  const parts: string[] = [];

  // Count scenes
  const scenes = data.production?.scenes?.length;
  if (scenes) parts.push(`${scenes} scenes`);

  // Total duration
  const duration = data.video?.durationSec;
  if (duration !== undefined) parts.push(`${duration.toFixed(1)}s`);

  // Asset count - use generationStatus to determine complete assets
  const sceneAssets = data.production?.scenes;
  if (sceneAssets) {
    const assets = sceneAssets.filter((s) => s.generationStatus === "complete" && s.assetUrl).length;
    if (assets) parts.push(`${assets} assets`);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}
