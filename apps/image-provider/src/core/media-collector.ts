import type { BrowserContext, Page } from 'playwright';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

/**
 * Media collection for a generation round: snapshot what is already on the
 * page, wait for generation to finish, poll for new sources, and download the
 * resulting buffers.
 *
 * Extracted from GeminiClient, which owns the browser lifecycle; this module
 * owns only "get the bytes for whatever the UI just produced". The page and
 * context are provided by getters so the collector never owns a stale
 * reference after a restart, and `responseCache` is threaded through so a
 * media body intercepted during generation is reused instead of re-fetched.
 */
export interface MediaCollectorDeps {
  getPage: () => Page | null;
  getContext: () => BrowserContext | null;
  logger: Logger;
  config: Config;
}

/** Minimum plausible payload size, below which a "new" source is treated as a UI thumbnail. */
const MIN_IMAGE_BYTES = 2048;
const MIN_VIDEO_BYTES = 1024;

export class MediaCollector {
  constructor(private readonly deps: MediaCollectorDeps) {}

  async snapshotImageSrcs(): Promise<Set<string>> {
    const page = this.deps.getPage();
    if (!page) return new Set();
    const srcs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img'))
        .map((img) => (img as HTMLImageElement).src || '')
        .filter(Boolean);
    });
    return new Set(srcs);
  }

  async snapshotVideoSrcs(): Promise<Set<string>> {
    const page = this.deps.getPage();
    if (!page) return new Set();
    const srcs = await page.evaluate(() => {
      const out: string[] = [];
      for (const vid of Array.from(document.querySelectorAll('video'))) {
        const v = vid as HTMLVideoElement;
        if (v.currentSrc) out.push(v.currentSrc);
        else if (v.src) out.push(v.src);
      }
      for (const src of Array.from(document.querySelectorAll('video source'))) {
        const s = src as HTMLSourceElement;
        if (s.src) out.push(s.src);
      }
      return out.filter(Boolean);
    });
    return new Set(srcs);
  }

  async collectImages(responseCache: Map<string, Buffer>, oldSrcs: Set<string>): Promise<Buffer[]> {
    const page = this.deps.getPage();
    if (!page) throw new Error('Page closed');

    this.deps.logger.debug('Existing images on page', { count: oldSrcs.size });

    await this.waitForGeneration(this.deps.config.timeout);

    const newSrcs = await this.pollForNewImages(oldSrcs);

    this.deps.logger.debug('New image sources found', { count: newSrcs.length });

    const buffers: Buffer[] = [];
    for (const src of newSrcs) {
      const buf = await this.downloadBuffer(src, responseCache);
      if (buf && buf.length > MIN_IMAGE_BYTES) {
        buffers.push(buf);
      }
    }

    this.deps.logger.debug('Downloaded image buffers', { count: buffers.length });

    return buffers;
  }

  async collectVideos(responseCache: Map<string, Buffer>, oldSrcs: Set<string>): Promise<Buffer[]> {
    const page = this.deps.getPage();
    if (!page) throw new Error('Page closed');

    this.deps.logger.debug('Existing videos on page', { count: oldSrcs.size });

    await this.waitForGeneration(this.deps.config.videoTimeout);

    const newSrcs = await this.pollForNewVideos(oldSrcs);

    this.deps.logger.debug('New video sources found', { count: newSrcs.length });

    const buffers: Buffer[] = [];
    for (const src of newSrcs) {
      const buf = await this.downloadBuffer(src, responseCache);
      if (buf && buf.length > MIN_VIDEO_BYTES) {
        buffers.push(buf);
      }
    }

    this.deps.logger.debug('Downloaded video buffers', { count: buffers.length });

    return buffers;
  }

  private async waitForGeneration(timeoutMs: number): Promise<void> {
    const page = this.deps.getPage();
    if (!page) return;

    const genIndicator = page.locator('button:has-text("Stop"), [role="progressbar"]').first();

    const appeared = await genIndicator
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (!appeared) {
      this.deps.logger.debug('Generation indicator did not appear, falling back to polling');
      return;
    }

    const matched = await genIndicator.getAttribute('aria-label').catch(() => null);
    this.deps.logger.debug('Generation indicator appeared', { matched });

    try {
      await genIndicator.waitFor({ state: 'hidden', timeout: timeoutMs });
      this.deps.logger.debug('Generation indicator disappeared');
    } catch {
      this.deps.logger.warn('Generation indicator did not disappear, proceeding');
    }
  }

  private async pollForNewImages(oldSrcs: Set<string>): Promise<string[]> {
    if (!this.deps.getPage()) return [];
    return this.pollForNewSources(oldSrcs, this.deps.config.timeout, 'images');
  }

  private async pollForNewVideos(oldSrcs: Set<string>): Promise<string[]> {
    if (!this.deps.getPage()) return [];
    return this.pollForNewSources(oldSrcs, this.deps.config.videoTimeout, 'videos');
  }

  /**
   * A source counts as new only if a second sample still contains it: the UI
   * renders placeholders before the real media lands, so a single observation
   * would ship a broken asset.
   */
  private async pollForNewSources(
    oldSrcs: Set<string>,
    timeoutMs: number,
    kind: string,
  ): Promise<string[]> {
    if (!this.deps.getPage()) return [];

    const startTime = Date.now();
    const deadline = startTime + timeoutMs;

    while (Date.now() < deadline) {
      const allSrcs = await this.collectAllMediaSrcs(kind);
      const newSrcs = allSrcs.filter((s) => !oldSrcs.has(s));

      if (newSrcs.length > 0) {
        await new Promise((r) => setTimeout(r, 2000));
        const allSrcs2 = await this.collectAllMediaSrcs(kind);
        const newSrcs2 = allSrcs2.filter((s) => !oldSrcs.has(s));

        if (newSrcs2.length >= newSrcs.length) {
          return newSrcs2;
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.deps.logger.debug(`Polling for ${kind}...`, {
        elapsed: `${elapsed}s`,
        found: newSrcs.length,
      });

      await new Promise((r) => setTimeout(r, 2000));
    }

    return [];
  }

  private async collectAllMediaSrcs(kind: string): Promise<string[]> {
    const page = this.deps.getPage();
    if (!page) return [];
    const selector = kind === 'images' ? 'img' : 'video, video source';
    return page.evaluate((sel) => {
      return (
        Array.from(document.querySelectorAll(sel))
          // Chrome icons and avatars are smaller than any generated image; a
          // 32px avatar arriving late must not end the poll before the result
          // exists.
          .filter((el) => {
            if (sel !== 'img') return true;
            const img = el as HTMLImageElement;
            return (
              (img.naturalWidth || img.width) >= 100 && (img.naturalHeight || img.height) >= 100
            );
          })
          .map((el) => {
            const node = el as HTMLImageElement & HTMLVideoElement & HTMLSourceElement;
            const src = node.currentSrc || node.src || '';
            return src;
          })
          .filter((s) => s && s.length > 0 && !s.startsWith('data:'))
      );
    }, selector);
  }

  private async downloadBuffer(src: string, cache: Map<string, Buffer>): Promise<Buffer | null> {
    if (cache.has(src)) return cache.get(src)!;

    if (src.startsWith('blob:')) {
      return this.downloadBlob(src);
    }

    if (src.startsWith('http')) {
      try {
        const resp = await this.deps.getContext()!.request.get(src);
        if (resp.ok()) return resp.body();
      } catch {
        // fallback to page-context fetch
      }
      return this.downloadViaPage(src);
    }

    return null;
  }

  private async downloadBlob(src: string): Promise<Buffer | null> {
    const page = this.deps.getPage();
    if (!page) return null;
    try {
      const dataUrl = await page.evaluate(async (url: string) => {
        const resp = await fetch(url);
        const blob = await resp.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, src);
      return Buffer.from(dataUrl.split(',')[1], 'base64');
    } catch (err) {
      this.deps.logger.debug('Blob download failed', { error: String(err) });
      return null;
    }
  }

  private async downloadViaPage(src: string): Promise<Buffer | null> {
    const page = this.deps.getPage();
    if (!page) return null;
    try {
      const dataUrl = await page.evaluate(async (url: string) => {
        const resp = await fetch(url);
        const blob = await resp.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, src);
      return Buffer.from(dataUrl.split(',')[1], 'base64');
    } catch {
      return null;
    }
  }
}
