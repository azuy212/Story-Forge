import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import type { Logger } from './logger';
import type { AssetType, MediaAsset } from './types';

const IMAGE_MAGIC_BYTES: [number[], string][] = [
  [[0xff, 0xd8, 0xff], 'jpg'],
  [[0x89, 0x50, 0x4e, 0x47], 'png'],
  [[0x52, 0x49, 0x46, 0x46], 'webp'],
  [[0x47, 0x49, 0x46, 0x38], 'gif'],
  [[0x42, 0x4d], 'bmp'],
];

export function detectImageExt(buf: Buffer): string {
  for (const [magic, ext] of IMAGE_MAGIC_BYTES) {
    if (magic.every((b, i) => buf[i] === b)) return ext;
  }
  return 'png';
}

export function detectVideoExt(buf: Buffer): string {
  if (buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'webm';
  }
  if (buf.length > 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.slice(8, 12).toString('ascii');
    return brand === 'qt  ' ? 'mov' : 'mp4';
  }
  return 'mp4';
}

export function detectMediaExt(buf: Buffer, assetType: AssetType): string {
  return assetType === 'video' ? detectVideoExt(buf) : detectImageExt(buf);
}

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export function extToMime(ext: string): string {
  return MIME_MAP[ext] || 'application/octet-stream';
}

export interface SaveAssetsInput {
  prompt: string;
  timestamp: string;
  assetType: AssetType;
  assets: MediaAsset[];
  outputDir: string;
}

export interface SaveResult {
  prompt: string;
  timestamp: string;
  assetType: AssetType;
  assetCount: number;
  assetDir: string;
  assetFilenames: string[];
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50) || 'untitled'
  );
}

export function buildOutputPath(baseDir: string, prompt: string): string {
  const date = new Date().toISOString().split('T')[0];
  return path.join(baseDir, date, slugify(prompt));
}

export class AssetDownloader {
  constructor(private readonly logger: Logger) {}

  async saveAssets(input: SaveAssetsInput): Promise<SaveResult> {
    const assetDir = buildOutputPath(input.outputDir, input.prompt);
    await mkdir(assetDir, { recursive: true });

    const assetFilenames: string[] = [];

    for (const asset of input.assets) {
      const ext = detectMediaExt(asset.buffer, input.assetType);
      const name = asset.filename.replace(/\.[^.]+$/, '') + '.' + ext;
      const filePath = path.join(assetDir, name);
      await writeFile(filePath, asset.buffer);
      assetFilenames.push(name);

      this.logger.debug('Saved asset', {
        path: filePath,
        bytes: asset.buffer.length,
      });
    }

    const metadata = {
      prompt: input.prompt,
      timestamp: input.timestamp,
      assetType: input.assetType,
      assetCount: input.assets.length,
      assetFilenames,
    };

    await writeFile(path.join(assetDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

    return {
      prompt: input.prompt,
      timestamp: input.timestamp,
      assetType: input.assetType,
      assetCount: input.assets.length,
      assetDir,
      assetFilenames,
    };
  }
}
