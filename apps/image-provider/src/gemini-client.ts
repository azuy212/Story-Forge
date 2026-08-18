import { chromium, type Page, type BrowserContext, type Locator, type Response } from 'playwright';
import type { Config } from './config';
import type { Logger } from './logger';
import { retry, RetryError } from './retry';
import { ProviderError, isRetryableType, classifyGeminiError } from './errors';
import { AssetDownloader } from './asset-downloader';
import { AssetCache } from './cache';
import type {
  AssetType,
  GenerationOptions,
  GenerationResult,
  MediaAsset,
  ReferenceImage,
} from './types';

export class GeminiClient {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private downloader: AssetDownloader;
  private cache: AssetCache;
  private _shuttingDown = false;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.downloader = new AssetDownloader(logger);
    this.cache = new AssetCache(logger, config.cacheDir);
  }

  get shuttingDown(): boolean {
    return this._shuttingDown;
  }

  async start(): Promise<void> {
    this.logger.info('Launching browser', { headless: this.config.headless });

    const opts: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: this.config.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
      acceptDownloads: true,
    };

    if (this.config.browserExecutablePath) {
      opts.executablePath = this.config.browserExecutablePath;
    }

    this.context = await chromium.launchPersistentContext(this.config.userDataDir, opts);

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

    this.page.setDefaultTimeout(this.config.timeout);
    this.page.setDefaultNavigationTimeout(this.config.navigationTimeout);

    await this.page.goto(this.config.geminiUrl, {
      waitUntil: 'load',
      timeout: this.config.navigationTimeout,
    });
    this.logger.info('Gemini page loaded');
  }

  async waitForAuthentication(): Promise<void> {
    if (!this.page) throw new Error('Browser not started');

    if (await this.isAuthenticated()) {
      this.logger.info('Already authenticated');
      return;
    }

    this.logger.info('Waiting for manual sign-in in the opened browser...');

    await this.page.waitForFunction(
      () => {
        const sel = '[contenteditable="true"], textarea, [role="textbox"]';
        return document.querySelectorAll(sel).length > 0;
      },
      { timeout: this.config.authenticationTimeout },
    );

    this.logger.info('Authentication confirmed');
  }

  private async isAuthenticated(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        const sel = '[contenteditable="true"], textarea, [role="textbox"]';
        return document.querySelectorAll(sel).length > 0;
      });
    } catch {
      return false;
    }
  }

  async isCached(
    prompt: string,
    assetType: AssetType,
    options: GenerationOptions = {},
  ): Promise<boolean> {
    return this.cache.has(prompt, assetType, options);
  }

  async processAllPrompts(prompts: string[], assetType: AssetType): Promise<void> {
    const baseDir = this.config.downloadDir;

    for (let i = 0; i < prompts.length; i++) {
      if (this._shuttingDown) break;

      const prompt = prompts[i];
      this.logger.info(`[${i + 1}/${prompts.length}] Processing`, {
        prompt: prompt.substring(0, 60),
        assetType,
      });

      try {
        const result = await this.processSinglePrompt(prompt, baseDir, assetType);
        this.logger.info(`[${i + 1}/${prompts.length}] Done`, {
          assets: result.assetCount,
          dir: result.assetDir,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`[${i + 1}/${prompts.length}] Failed`, {
          prompt: prompt.substring(0, 60),
          error: msg,
        });
      }
    }
  }

  private async processSinglePrompt(prompt: string, baseDir: string, assetType: AssetType) {
    const cached = await this.cache.get(prompt, assetType);
    if (cached) {
      this.logger.info('Cache hit, reusing generated assets', {
        prompt: prompt.substring(0, 60),
        assetType,
        assets: cached.assets.length,
      });
      return this.downloader.saveAssets({
        prompt,
        timestamp: cached.timestamp,
        assetType,
        assets: cached.assets,
        outputDir: baseDir,
      });
    }

    const { result, assets } = await retry(
      async () => {
        const timestamp = new Date().toISOString();
        const assets = await this.executeGeneration(prompt, assetType);
        const result = await this.downloader.saveAssets({
          prompt,
          timestamp,
          assetType,
          assets,
          outputDir: baseDir,
        });
        return { result, assets };
      },
      {
        maxAttempts: this.config.retryMaxAttempts,
        baseDelayMs: this.config.retryBaseDelayMs,
        timeout: this.config.timeout,
        isRetryable: (err) => !(err instanceof ProviderError) || isRetryableType(err.type),
        onRetry: (err) => this.logRetryWarnings(err),
      },
    );

    try {
      await this.cache.put(prompt, assetType, assets);
    } catch (error) {
      this.logger.warn('Failed to write cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return result;
  }

  private _busy = false;
  private _queue: Array<{
    prompt: string;
    assetType: AssetType;
    options: GenerationOptions;
    resolve: (result: GenerationResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private _inflight = new Map<string, Promise<GenerationResult>>();

  async generate(
    prompt: string,
    assetType: AssetType,
    options: GenerationOptions = {},
  ): Promise<GenerationResult> {
    const key = this.cache.key(prompt, assetType, options);

    const existing = this._inflight.get(key);
    if (existing) {
      this.logger.debug('Joining in-flight generation for identical prompt', {
        prompt: prompt.substring(0, 60),
        assetType,
      });
      return existing;
    }

    const promise = this._generate(prompt, assetType, options);
    this._inflight.set(key, promise);
    promise.finally(() => this._inflight.delete(key)).catch(() => {});

    return promise;
  }

  private async _generate(
    prompt: string,
    assetType: AssetType,
    options: GenerationOptions = {},
  ): Promise<GenerationResult> {
    const cached = await this.cache.get(prompt, assetType, options);
    if (cached) {
      this.logger.info('Cache hit, serving from cache', {
        prompt: prompt.substring(0, 60),
        assetType,
        assets: cached.assets.length,
      });
      return { prompt, assetType, assets: cached.assets, fromCache: true };
    }

    return new Promise((resolve, reject) => {
      this._queue.push({ prompt, assetType, options, resolve, reject });
      void this._processQueue();
    });
  }

  private async _processQueue(): Promise<void> {
    if (this._busy || this._queue.length === 0) return;
    this._busy = true;
    const item = this._queue.shift()!;
    try {
      const assets = await retry(
        async () => {
          return this.executeGeneration(item.prompt, item.assetType, item.options);
        },
        {
          maxAttempts: this.config.retryMaxAttempts,
          baseDelayMs: this.config.retryBaseDelayMs,
          timeout: this.config.timeout,
          isRetryable: (err) => !(err instanceof ProviderError) || isRetryableType(err.type),
          onRetry: (err) => this.logRetryWarnings(err),
        },
      );
      try {
        await this.cache.put(item.prompt, item.assetType, assets, item.options);
      } catch (error) {
        this.logger.warn('Failed to write cache', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      item.resolve({ prompt: item.prompt, assetType: item.assetType, assets, fromCache: false });
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this._busy = false;
      void this._processQueue();
    }
  }

  private async executeGeneration(
    prompt: string,
    assetType: AssetType,
    options: GenerationOptions = {},
  ): Promise<MediaAsset[]> {
    if (!this.page) throw new Error('Page closed');
    const page = this.page;

    const responseCache = new Map<string, Buffer>();
    const contentTypePrefix = assetType === 'video' ? 'video/' : 'image/';
    const onResponse = (res: Response) => {
      const ct = res.headers()['content-type'] || '';
      if (ct.startsWith(contentTypePrefix) && res.status() === 200) {
        res
          .body()
          .then((b) => responseCache.set(res.url(), b))
          .catch(() => {});
      }
    };
    page.on('response', onResponse);

    try {
      await this.selectCreateMode(assetType);
      if (options.referenceImages?.length) {
        await uploadReferenceImages(page, options.referenceImages);
      }

      const oldSrcs =
        assetType === 'video' ? await this.snapshotVideoSrcs() : await this.snapshotImageSrcs();

      const input = await this.resolveInput();
      await input.focus().catch(() => this.focusInput());
      await input.fill('');
      await this.page.keyboard.press('ControlOrMeta+A').catch(() => {});
      await this.page.keyboard.press('Backspace').catch(() => {});
      await this.page.keyboard.type(prompt, { delay: 15 });

      const submitted = await this.submitPrompt(input);
      if (!submitted) throw new Error('Could not submit prompt');

      let buffers =
        assetType === 'video'
          ? await this.collectVideos(responseCache, oldSrcs)
          : await this.collectImages(responseCache, oldSrcs);
      if (buffers.length === 0) {
        const errorMsg = await this.detectGenerationError();
        const failure = new ProviderError(
          errorMsg || `No ${assetType} generated`,
          classifyGeminiError(errorMsg ?? ''),
          errorMsg || undefined,
        );

        // Only a transient (retryable) failure may be re-issued against the
        // same prompt. A policy/prompt rejection must surface as-is so the
        // caller can repair the prompt instead of burning retries.
        if (isRetryableType(failure.type) && (await this.clickGenerationRetry())) {
          this.logger.info('Retrying failed generation from Gemini UI');
          buffers =
            assetType === 'video'
              ? await this.collectVideos(responseCache, oldSrcs)
              : await this.collectImages(responseCache, oldSrcs);
        }

        if (buffers.length > 0)
          return buffers.map((buf, i) => ({
            filename: `${assetType === 'video' ? 'video' : 'image'}-${i + 1}`,
            buffer: buf,
          }));

        throw failure;
      }

      const prefix = assetType === 'video' ? 'video' : 'image';
      return buffers.map((buf, i) => ({
        filename: `${prefix}-${i + 1}`,
        buffer: buf,
      }));
    } finally {
      page.off('response', onResponse);
    }
  }

  private async clickGenerationRetry(): Promise<boolean> {
    if (!this.page) return false;

    const retryButton = this.page.getByRole('button', { name: /^(redo|retry|try again)$/i }).last();

    if (!(await retryButton.isVisible().catch(() => false))) return false;
    if (!(await retryButton.isEnabled().catch(() => false))) return false;

    await retryButton.click();
    return true;
  }

  private async focusInput(): Promise<void> {
    if (!this.page) return;
    await this.page.evaluate(() => {
      const sel = '[contenteditable="true"], textarea, [role="textbox"]';
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) el.focus();
    });
  }

  private async selectCreateMode(assetType: AssetType): Promise<void> {
    if (!this.page) throw new Error('Page closed');

    const label = assetType === 'video' ? 'Create video' : 'Create image';
    const item = this.page.locator('[role="menuitemcheckbox"]').filter({ hasText: label }).first();

    const checked = await item.getAttribute('aria-checked', { timeout: 2000 }).catch(() => null);
    if (checked === 'true') {
      this.logger.debug('Create mode already active', { assetType, label });
      return;
    }

    const plusBtn = this.page.locator('button[aria-label="Upload & tools"]').first();
    await plusBtn.click();

    await item.waitFor({ state: 'visible', timeout: 15000 });
    await item.click();

    await this.page.keyboard.press('Escape').catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));

    this.logger.debug('Selected create mode', { assetType, label });
  }

  private async resolveInput(): Promise<Locator> {
    if (!this.page) throw new Error('Page closed');

    const sel = ['[contenteditable="true"]', 'textarea', '[role="textbox"]'].join(', ');

    const loc = this.page.locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    return loc;
  }

  private async submitPrompt(input: Locator): Promise<boolean> {
    if (!this.page) return false;

    await input.press('Enter');
    await new Promise((r) => setTimeout(r, 2000));

    const cleared = await this.page.evaluate(() => {
      const sel = '[contenteditable="true"], textarea, [role="textbox"]';
      for (const el of document.querySelectorAll(sel)) {
        const text = (el as HTMLElement).textContent || '';
        if (text.trim().length > 0) return false;
      }
      return true;
    });

    if (cleared) return true;

    const labeled = this.page
      .locator('button[aria-label]')
      .filter({ hasText: /\b(Send|Submit|Generate|Create)\b/i })
      .last();
    const labeledEnabled = await labeled.isEnabled().catch(() => false);
    if (labeledEnabled) {
      await labeled.click();
      return true;
    }

    const iconBtn = this.page.locator('button').filter({ hasNotText: /\S/ }).last();
    const iconEnabled = await iconBtn.isEnabled().catch(() => false);
    if (iconEnabled) {
      await iconBtn.click();
      return true;
    }

    return false;
  }

  private async collectImages(
    responseCache: Map<string, Buffer>,
    oldSrcs: Set<string>,
  ): Promise<Buffer[]> {
    if (!this.page) throw new Error('Page closed');

    this.logger.debug('Existing images on page', { count: oldSrcs.size });

    await this.waitForGeneration(this.config.timeout);

    const newSrcs = await this.pollForNewImages(oldSrcs);

    this.logger.debug('New image sources found', { count: newSrcs.length });

    const buffers: Buffer[] = [];
    for (const src of newSrcs) {
      const buf = await this.downloadBuffer(src, responseCache);
      if (buf && buf.length > 2048) {
        buffers.push(buf);
      }
    }

    this.logger.debug('Downloaded image buffers', { count: buffers.length });

    return buffers;
  }

  private async collectVideos(
    responseCache: Map<string, Buffer>,
    oldSrcs: Set<string>,
  ): Promise<Buffer[]> {
    if (!this.page) throw new Error('Page closed');

    this.logger.debug('Existing videos on page', { count: oldSrcs.size });

    await this.waitForGeneration(this.config.videoTimeout);

    const newSrcs = await this.pollForNewVideos(oldSrcs);

    this.logger.debug('New video sources found', { count: newSrcs.length });

    const buffers: Buffer[] = [];
    for (const src of newSrcs) {
      const buf = await this.downloadBuffer(src, responseCache);
      if (buf && buf.length > 1024) {
        buffers.push(buf);
      }
    }

    this.logger.debug('Downloaded video buffers', { count: buffers.length });

    return buffers;
  }

  private async waitForGeneration(timeoutMs: number): Promise<void> {
    if (!this.page) return;

    const genIndicator = this.page.locator('button:has-text("Stop"), [role="progressbar"]').first();

    const appeared = await genIndicator
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (!appeared) {
      this.logger.debug('Generation indicator did not appear, falling back to polling');
      return;
    }

    const matched = await genIndicator.getAttribute('aria-label').catch(() => null);
    this.logger.debug('Generation indicator appeared', { matched });

    try {
      await genIndicator.waitFor({ state: 'hidden', timeout: timeoutMs });
      this.logger.debug('Generation indicator disappeared');
    } catch {
      this.logger.warn('Generation indicator did not disappear, proceeding');
    }
  }

  private async snapshotImageSrcs(): Promise<Set<string>> {
    if (!this.page) return new Set();
    const srcs = await this.page.evaluate(() => {
      return Array.from(document.querySelectorAll('img'))
        .map((img) => (img as HTMLImageElement).src || '')
        .filter(Boolean);
    });
    return new Set(srcs);
  }

  private async snapshotVideoSrcs(): Promise<Set<string>> {
    if (!this.page) return new Set();
    const srcs = await this.page.evaluate(() => {
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

  private async pollForNewImages(oldSrcs: Set<string>): Promise<string[]> {
    if (!this.page) return [];
    return this.pollForNewSources(oldSrcs, this.config.timeout, 'images');
  }

  private async pollForNewVideos(oldSrcs: Set<string>): Promise<string[]> {
    if (!this.page) return [];
    return this.pollForNewSources(oldSrcs, this.config.videoTimeout, 'videos');
  }

  private async pollForNewSources(
    oldSrcs: Set<string>,
    timeoutMs: number,
    kind: string,
  ): Promise<string[]> {
    if (!this.page) return [];

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
      this.logger.debug(`Polling for ${kind}...`, {
        elapsed: `${elapsed}s`,
        found: newSrcs.length,
      });

      await new Promise((r) => setTimeout(r, 2000));
    }

    return [];
  }

  private async collectAllMediaSrcs(kind: string): Promise<string[]> {
    if (!this.page) return [];
    const selector = kind === 'images' ? 'img' : 'video, video source';
    return this.page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel))
        .map((el) => {
          const node = el as HTMLImageElement & HTMLVideoElement & HTMLSourceElement;
          const src = node.currentSrc || node.src || '';
          return src;
        })
        .filter((s) => s && s.length > 0 && !s.startsWith('data:'));
    }, selector);
  }

  private async downloadBuffer(src: string, cache: Map<string, Buffer>): Promise<Buffer | null> {
    if (cache.has(src)) return cache.get(src)!;

    if (src.startsWith('blob:')) {
      return this.downloadBlob(src);
    }

    if (src.startsWith('http')) {
      try {
        const resp = await this.context!.request.get(src);
        if (resp.ok()) return resp.body();
      } catch {
        // fallback to page-context fetch
      }
      return this.downloadViaPage(src);
    }

    return null;
  }

  private async downloadBlob(src: string): Promise<Buffer | null> {
    if (!this.page) return null;
    try {
      const dataUrl = await this.page.evaluate(async (url: string) => {
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
      this.logger.debug('Blob download failed', { error: String(err) });
      return null;
    }
  }

  private async downloadViaPage(src: string): Promise<Buffer | null> {
    if (!this.page) return null;
    try {
      const dataUrl = await this.page.evaluate(async (url: string) => {
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

  private async detectGenerationError(): Promise<string | null> {
    if (!this.page) return null;

    const patterns = [
      'image generation failed',
      'image generation error',
      'something went wrong',
      'encountered an error',
      "can't generate",
      "couldn't generate",
      'content policy',
      'rate limit',
      'try again',
      'blocked',
      'violation',
      'not available',
      'unable to generate',
      'flagge',
    ];

    // Avoid broad :has-text selectors. They can match html/script ancestors and
    // return Google's entire WIZ_global_data payload instead of the UI error.
    const visibleTexts = await this.page.locator('body *:visible').evaluateAll((elements) =>
      elements
        .map((element) => ({
          tag: element.tagName,
          text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
        }))
        .filter(
          ({ tag, text }) =>
            !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag) && text.length > 0 && text.length <= 500,
        ),
    );

    for (const pattern of patterns) {
      const match = visibleTexts
        .filter(({ text }) => text.toLowerCase().includes(pattern))
        .sort((left, right) => left.text.length - right.text.length)[0];

      if (match) return match.text;
    }

    return null;
  }

  private logRetryWarnings(error: Error): void {
    const msg = error.message.toLowerCase();
    if (msg.includes('content policy') || msg.includes('flagge') || msg.includes('violation')) {
      this.logger.warn('Content policy violation, retrying...');
    } else if (msg.includes('rate limit') || msg.includes('429')) {
      this.logger.warn('Rate limited, backing off...');
    } else if (msg.includes('timeout') || msg.includes('timed out')) {
      this.logger.warn('Operation timed out, retrying...');
    } else if (error instanceof RetryError) {
      this.logger.warn('Generation failed, retrying...', { reason: error.message });
    } else {
      this.logger.warn('Temporary failure, retrying...', { error: error.message });
    }
  }

  async shutdown(): Promise<void> {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // best-effort close
      }
      this.context = null;
      this.page = null;
    }
  }
}

/** Upload references through Gemini's Upload & tools control. */
export async function uploadReferenceImages(
  page: Page,
  references: ReferenceImage[],
): Promise<void> {
  const plusButton = page.locator('button[aria-label="Upload & tools"]').first();
  await plusButton.click();

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 15000 });
  await fileInput.setInputFiles(
    references.map((reference) => ({
      name: reference.filename,
      mimeType: reference.mime,
      buffer: Buffer.from(reference.base64, 'base64'),
    })),
  );
  const uploadedCount = await fileInput.evaluate(
    (input) => (input as HTMLInputElement).files?.length ?? 0,
  );
  assertReferenceUploadCount(uploadedCount, references.length);
  await page.keyboard.press('Escape').catch(() => {});
}

export function assertReferenceUploadCount(uploadedCount: number, expectedCount: number): void {
  if (uploadedCount !== expectedCount) {
    throw new Error(
      `Gemini reference upload accepted ${uploadedCount} of ${expectedCount} image(s)`,
    );
  }
}
