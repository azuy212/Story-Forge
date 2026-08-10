import { createHash } from 'crypto';
import { readFile, writeFile, mkdir, stat, rename, rm, readdir } from 'fs/promises';
import path from 'path';
import type { Logger } from './logger';
import type { AssetType, MediaAsset } from './types';
import { detectMediaExt } from './asset-downloader';

export interface CacheEntry {
  prompt: string;
  assetType: AssetType;
  timestamp: string;
  assets: MediaAsset[];
}

interface CacheMetadata {
  prompt: string;
  assetType: AssetType;
  timestamp: string;
  assetCount: number;
  assetFilenames: string[];
}

export class AssetCache {
  constructor(
    private readonly logger: Logger,
    private readonly dir: string,
  ) {
    void this.cleanupStale().catch(() => {});
  }

  key(prompt: string, assetType: AssetType): string {
    return createHash('sha256').update(prompt).update('\0').update(assetType).digest('hex');
  }

  private entryDir(prompt: string, assetType: AssetType): string {
    return path.join(this.dir, this.key(prompt, assetType));
  }

  async has(prompt: string, assetType: AssetType): Promise<boolean> {
    try {
      const meta = await this.readMetadata(prompt, assetType);
      if (!meta) return false;
      for (const f of meta.assetFilenames) {
        const st = await stat(path.join(this.entryDir(prompt, assetType), f));
        if (!st.isFile()) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async get(prompt: string, assetType: AssetType): Promise<CacheEntry | null> {
    try {
      const meta = await this.readMetadata(prompt, assetType);
      if (!meta) return null;

      const assets: MediaAsset[] = [];
      for (const f of meta.assetFilenames) {
        const buffer = await readFile(path.join(this.entryDir(prompt, assetType), f));
        assets.push({ filename: f.replace(/\.[^.]+$/, ''), buffer });
      }

      return {
        prompt: meta.prompt,
        assetType: meta.assetType,
        timestamp: meta.timestamp,
        assets,
      };
    } catch (error) {
      this.logger.debug('Cache read failed', {
        prompt: prompt.substring(0, 60),
        assetType,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async put(prompt: string, assetType: AssetType, assets: MediaAsset[]): Promise<void> {
    const dir = this.entryDir(prompt, assetType);
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bak = `${dir}.bak`;
    await mkdir(tmp, { recursive: true });

    try {
      const assetFilenames: string[] = [];
      for (let i = 0; i < assets.length; i++) {
        const ext = detectMediaExt(assets[i].buffer, assetType);
        const name = `${assets[i].filename.replace(/\.[^.]+$/, '')}.${ext}`;
        await writeFile(path.join(tmp, name), assets[i].buffer);
        assetFilenames.push(name);
      }

      const metadata: CacheMetadata = {
        prompt,
        assetType,
        timestamp: new Date().toISOString(),
        assetCount: assets.length,
        assetFilenames,
      };

      await writeFile(path.join(tmp, 'metadata.json'), JSON.stringify(metadata, null, 2));

      await rm(bak, { recursive: true, force: true });
      await rename(dir, bak).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      });
      await rename(tmp, dir);
      await rm(bak, { recursive: true, force: true });
    } catch (error) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      const dirExists = await stat(dir)
        .then(() => true)
        .catch(() => false);
      if (!dirExists) {
        await rename(bak, dir).catch(() => {});
      }
      throw error;
    }

    this.logger.debug('Cache saved', {
      prompt: prompt.substring(0, 60),
      assetType,
      dir,
    });
  }

  private async cleanupStale(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.includes('.tmp-') || e.endsWith('.bak')) {
        await rm(path.join(this.dir, e), { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async readMetadata(prompt: string, assetType: AssetType): Promise<CacheMetadata | null> {
    const raw = await readFile(
      path.join(this.entryDir(prompt, assetType), 'metadata.json'),
      'utf-8',
    );
    const meta = JSON.parse(raw) as Partial<CacheMetadata>;

    if (
      typeof meta.prompt !== 'string' ||
      meta.prompt !== prompt ||
      meta.assetType !== assetType ||
      !Array.isArray(meta.assetFilenames) ||
      meta.assetCount !== meta.assetFilenames.length ||
      meta.assetCount < 1
    ) {
      return null;
    }

    for (const f of meta.assetFilenames) {
      if (typeof f !== 'string' || f.length === 0) return null;
      if (f !== path.basename(f) || f.includes('..') || path.isAbsolute(f)) return null;
    }

    return meta as CacheMetadata;
  }
}
