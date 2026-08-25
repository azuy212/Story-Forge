export function buildSummary(data: any): string | undefined {
  if (!data) return undefined;
  
  const parts = [];
  
  const scenes = data.production?.scenes?.length;
  if (scenes) parts.push(`${scenes} scenes`);
  
  const duration = data.video?.durationSec;
  if (duration !== undefined) parts.push(`${duration.toFixed(1)}s`);
  
  const sceneAssets = data.production?.scenes;
  if (sceneAssets) {
    const assets = sceneAssets.filter((s: any) => s.generationStatus === "complete" && s.assetUrl).length;
    if (assets) parts.push(`${assets} assets`);
  }
  
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
