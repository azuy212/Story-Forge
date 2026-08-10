import { runFfmpeg } from './ffmpeg.js';
import type { EncoderConfig } from './ffmpeg.js';

export interface WatermarkOptions {
  maxLogoWidth?: number;
  maxLogoHeight?: number;
  margin?: number;
  encoder: EncoderConfig;
}

export async function applyWatermark(
  videoPath: string,
  logoPath: string,
  outputPath: string,
  opts: WatermarkOptions,
): Promise<void> {
  const maxLogoWidth = opts.maxLogoWidth ?? 150;
  const maxLogoHeight = opts.maxLogoHeight ?? 150;
  const margin = opts.margin ?? 20;
  const position = `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`;
  const enc = opts.encoder;

  const args = [
    '-y',
    '-i', videoPath,
    '-i', logoPath,
    '-filter_complex',
    `[1:v]scale='min(iw,${maxLogoWidth})':'min(ih,${maxLogoHeight})':force_original_aspect_ratio=decrease,format=rgba[logo];[0:v][logo]overlay=${position}[outv]`,
    '-map', '[outv]',
    '-map', '0:a',
    '-c:v', enc.encoder,
    '-crf', String(enc.crf),
    '-preset', enc.preset,
    '-c:a', 'copy',
    '-pix_fmt', 'yuv420p',
  ];

  if (enc.extraArgs) args.push(...enc.extraArgs);
  args.push(outputPath);

  await runFfmpeg({
    args,
    description: 'apply watermark',
  });
}