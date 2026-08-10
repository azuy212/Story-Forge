export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

function toMs(h: number, m: number, s: number, ms: number): number {
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

const TIME_RE =
  /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

export function parseSrtCues(srt: string): SrtCue[] {
  if (!srt || srt.trim().length === 0) return [];

  const blocks = srt.trim().split(/\n\s*\n/);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;

    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;

    const m = TIME_RE.exec(timeLine);
    if (!m) continue;

    // SRT fractional seconds are 3-digit milliseconds; pad short fractions
    // (",5" or ",50") to full milliseconds instead of treating them as raw ms.
    const startMs = toMs(+m[1], +m[2], +m[3], Number(m[4].padEnd(3, "0")));
    const endMs = toMs(+m[5], +m[6], +m[7], Number(m[8].padEnd(3, "0")));

    // The optional leading index line must not be merged into the text.
    let textLines = lines.filter((l) => l !== timeLine);
    if (/^\d+$/.test(lines[0] ?? "")) textLines = textLines.slice(1);
    const text = textLines.join(" ").trim();

    cues.push({ index: cues.length + 1, startMs, endMs, text });
  }

  return cues;
}
