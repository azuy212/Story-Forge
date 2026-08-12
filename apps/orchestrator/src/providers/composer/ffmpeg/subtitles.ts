import { runFfmpeg } from './ffmpeg.js';
import type { EncoderConfig } from './ffmpeg.js';

export interface BurnSubtitlesOptions {
  subtitlePath: string;
  fontSize?: number;
  fontName?: string;
  encoder: EncoderConfig;
}

export function escapeSubtitlePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/'/g, "\\'");
}

export function buildSubtitleStyle(fontSize: number, fontName: string): string {
  const styleParts = [
    `FontSize=${fontSize}`,
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H00000000',
    'BorderStyle=1',
    'Outline=2',
    'MarginV=40',
    'Alignment=2',
  ];

  if (fontName) {
    styleParts.unshift(`FontName=${fontName}`);
  }

  return styleParts.join(',');
}

export async function burnSubtitles(
  videoPath: string,
  opts: BurnSubtitlesOptions,
  outputPath: string,
): Promise<void> {
  const fontSize = opts.fontSize ?? 20;
  const fontName = opts.fontName;
  const enc = opts.encoder;

  const style = buildSubtitleStyle(fontSize, fontName || '');
  const escapedPath = escapeSubtitlePath(opts.subtitlePath);

  const args = [
    '-y',
    '-i', videoPath,
    '-vf', `subtitles=filename=${escapedPath}:force_style='${style}'`,
    '-c:a', 'copy',
    '-c:v', enc.encoder,
    '-crf', String(enc.crf),
    '-preset', enc.preset,
    '-pix_fmt', 'yuv420p',
  ];

  if (enc.extraArgs) args.push(...enc.extraArgs);
  args.push(outputPath);

  await runFfmpeg({
    args,
    description: 'burn subtitles',
  });
}