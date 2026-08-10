import { runFfmpeg } from './ffmpeg.js';

export type AudioDurationMode = 'shortest' | 'pad';
export type AudioMixDuration = 'first' | 'longest' | 'shortest';

export async function addNarration(
  videoPath: string,
  narrationPath: string,
  outputPath: string,
  durationMode?: AudioDurationMode,
): Promise<void> {
  const mode = durationMode ?? 'shortest';

  const args: string[] = [
    '-y',
    '-i', videoPath,
    '-i', narrationPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-shortest', // Always use shortest to prevent video/audio length mismatch
  ];

  if (mode === 'pad') {
    // If pad, we need to pad the audio before encoding, but here we are just copying video. 
    // To truly pad, we'd need to re-encode audio with apad.
    args.splice(args.length - 1, 0, '-af', 'apad'); 
  }

  args.push(outputPath);

  await runFfmpeg({ args, description: 'add narration audio' });
}

export interface AudioMixOptions {
  narrationPath: string;
  bgmPath: string;
  bgmVolume?: number;
  durationMode?: AudioDurationMode;
  mixDuration?: AudioMixDuration;
}

export async function mixNarrationWithBgm(
  videoPath: string,
  opts: AudioMixOptions,
  outputPath: string,
): Promise<void> {
  const bgmVolume = opts.bgmVolume ?? 0.15;
  const mode = opts.durationMode ?? 'shortest';
  const mixDuration = opts.mixDuration ?? 'first';

  const amixFilter = `[narr][music]amix=inputs=2:duration=${mixDuration}${mode === 'pad' ? ',apad' : ''}[outa]`;

  const args: string[] = [
    '-y',
    '-i', videoPath,
    '-i', opts.narrationPath,
    '-i', opts.bgmPath,
    '-filter_complex',
    [
      `[1:a]volume=1.0[narr]`,
      `[2:a]volume=${bgmVolume}[music]`,
      amixFilter,
    ].join(';'),
    '-map', '0:v:0',
    '-map', '[outa]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-shortest', // Always shortest to match video length
    outputPath,
  ];

  await runFfmpeg({ args, description: 'mix narration with background music' });
}