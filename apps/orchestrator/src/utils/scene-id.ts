export function padSceneId(id: number, width = 3): string {
  return String(id).padStart(width, "0");
}
