import { chromium, type Page, type BrowserContext, type Locator, type Response } from 'playwright';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { retry, RetryError } from './retry.js';
import { ProviderError, isRetryableType, classifyGeminiError } from './errors.js';
import { AssetDownloader } from '../storage/asset-downloader.js';
import { AssetCache } from '../storage/cache.js';
import { MediaCollector } from './media-collector.js';
import { GeminiErrorDetector } from './gemini-error-detector.js';
import { normalizeImagesPrompt } from './prompt-text.js';
import { chooseCreateMode } from './create-mode.js';
import { uploadReferenceImages } from './reference-upload.js';
import type { AssetType, GenerationOptions, GenerationResult, MediaAsset } from './types.js';

// Re-exported so existing consumers of this module keep working.
export { assertReferenceUploadCount, uploadReferenceImages } from './reference-upload.js';

/**
 * The Images surface's composer. Gemini moved image creation off the tools menu
 * onto `gemini.google.com/images`, reached through the sidebar entry; for
 * accounts on that UI the menu's "Create image" item is permanently disabled,
 * which is why a disabled entry alone must not be read as a spent quota.
 */
const IMAGES_COMPOSER = '[data-placeholder="Describe your image"]';
const IMAGES_PAGE_TIMEOUT_MS = 20000;

export class GeminiClient {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private downloader: AssetDownloader;
  private cache: AssetCache;
  private _shuttingDown = false;
  private _createModeActive = new Set<AssetType>();
  private readonly media: MediaCollector;
  private readonly errorDetector: GeminiErrorDetector;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.downloader = new AssetDownloader(logger);
    this.cache = new AssetCache(logger, config.cacheDir);
    this.media = new MediaCollector({
      getPage: () => this.page,
      getContext: () => this.context,
      logger,
      config,
    });
    this.errorDetector = new GeminiErrorDetector({
      getPage: () => this.page,
      logger,
    });
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

    this._createModeActive.clear();

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

    // Poll instead of waiting on one selector: a signed-out page and a
    // signed-in page both render a composer, so the composer cannot be the
    // signal. `isAuthenticated` is account-aware and this loop only exits once
    // it agrees the session is usable.
    const deadline = Date.now() + this.config.authenticationTimeout;
    while (Date.now() < deadline) {
      if (await this.isAuthenticated()) {
        this.logger.info('Authentication confirmed');
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new ProviderError(
      'Timed out waiting for Gemini sign-in',
      'authentication',
      'no Google account chip appeared',
    );
  }

  /**
   * A signed-out Gemini still renders an anonymous composer, so "there is a
   * textbox" is not an authentication check. That mattered twice: `login`
   * returned immediately instead of waiting for one, and the disabled
   * "Create image" entry of an anonymous session was reported as a spent
   * quota. Signed-in sessions carry the Google account chip; signed-out ones
   * show a sign-in prompt and no chip.
   */
  private async isAuthenticated(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await this.page.evaluate(() => {
        if (document.querySelector('[aria-label*="Google Account"]')) return true;
        if (document.querySelector('a[href*="accounts.google.com/ServiceLogin"]')) {
          return false;
        }
        if (/sign in to save activity/i.test(document.body.innerText)) return false;
        // No explicit marker either way (Google changed the chrome): keep the
        // old behaviour rather than blocking every run on an unknown selector.
        return (
          document.querySelector('[contenteditable="true"], textarea, [role="textbox"]') !== null
        );
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
      await new Promise((r) => setTimeout(r, 2000));
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
        assetType === 'video'
          ? await this.media.snapshotVideoSrcs()
          : await this.media.snapshotImageSrcs();

      const input = await this.resolveInput();
      // Clear and type through the keyboard only. `Locator.fill()` resets a
      // contenteditable's text without moving the editor's internal selection,
      // and on the Images composer that left `insertText` with nowhere to go:
      // the prompt was never submitted and the run polled an empty page.
      await input.click().catch(() => this.focusInput());
      await this.page.keyboard.press('ControlOrMeta+A').catch(() => {});
      await this.page.keyboard.press('Backspace').catch(() => {});
      // Insert the prompt as text, not as keystrokes: Gemini's composer submits
      // on Enter, so `keyboard.type()` sends a multi-line prompt as several
      // messages and only the first line reaches the model. It is also an
      // order of magnitude faster for the ~2 kB prompts the story pipeline
      // composes.
      //
      // The Images surface additionally rejects a prompt shaped as several
      // editor blocks ("I seem to be encountering an error"), so flatten line
      // breaks there. The chat composer keeps its paragraphs.
      const placeholder = await input.getAttribute('data-placeholder').catch(() => null);
      const text = placeholder === 'Describe your image' ? normalizeImagesPrompt(prompt) : prompt;
      await this.page.keyboard.insertText(text);

      const submitted = await this.submitPrompt(input);
      if (!submitted) throw new Error('Could not submit prompt');

      let buffers =
        assetType === 'video'
          ? await this.media.collectVideos(responseCache, oldSrcs)
          : await this.media.collectImages(responseCache, oldSrcs);
      if (buffers.length === 0) {
        // The UI renders its failure text a beat after the spinner stops, so a
        // single read races the message and reports a bare "nothing generated".
        let errorMsg = await this.errorDetector.detectGenerationError();
        const deadline = Date.now() + 10000;
        while (!errorMsg && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          errorMsg = await this.errorDetector.detectGenerationError();
        }
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
              ? await this.media.collectVideos(responseCache, oldSrcs)
              : await this.media.collectImages(responseCache, oldSrcs);
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
      this._createModeActive.delete(assetType);
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

    // Image creation moved to the dedicated Images surface, which has its own
    // composer ("Describe your image") and no tools-menu entry. Use it when it
    // renders; the menu path below stays as the fallback for accounts or
    // locales where that surface is not served.
    //
    // The surface is probed on every request, before the cached-mode shortcut:
    // a finished generation navigates to its conversation, so the composer
    // that was live for the previous request is gone even though the mode flag
    // still says "image". `chooseCreateMode` holds that ordering rule.
    const imagesSurfaceReady = assetType === 'image' ? await this.enterImagesPage() : false;
    const action = chooseCreateMode(
      assetType,
      this._createModeActive.has(assetType),
      imagesSurfaceReady,
    );

    if (action === 'images') {
      this._createModeActive.add(assetType);
      this.logger.debug('Using the Gemini Images composer');
      return;
    }

    if (action === 'cached') {
      this.logger.debug('Create mode already active (cached)', { assetType });
      return;
    }

    const label = assetType === 'video' ? 'Create video' : 'Create image';
    const expectedPlaceholder =
      assetType === 'video' ? 'Describe your video' : 'Describe your image';

    const isComposerInMode = async (): Promise<boolean> => {
      if (!this.page) return false;
      return this.page.evaluate((expected) => {
        const e = document.querySelector('[contenteditable="true"]');
        const ph = e?.getAttribute('data-placeholder') ?? '';
        return ph === expected;
      }, expectedPlaceholder);
    };

    if (await isComposerInMode()) {
      this._createModeActive.add(assetType);
      this.logger.debug('Create mode already active', { assetType, label });
      return;
    }

    const plusBtn = this.page.locator('button[aria-label="Upload & tools"]').first();
    const item = this.page.locator('[role="menuitemcheckbox"]').filter({ hasText: label }).first();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await plusBtn.click();
      await item.waitFor({ state: 'visible', timeout: 5000 });

      // A spent quota disables the menu entry rather than failing the request,
      // so the old path sat through three generation timeouts (~9 minutes per
      // image) before reporting a generic error. Surface it immediately as a
      // distinct, non-retryable status: the caller reruns after the refill and
      // only the missing scenes are generated.
      if (await this.isDisabled(item)) {
        await this.page.keyboard.press('Escape').catch(() => {});
        if (!(await this.isAuthenticated())) {
          throw new ProviderError(
            'Gemini is signed out; sign in before generating images',
            'authentication',
            'sign-in prompt visible in the browser',
          );
        }
        throw new ProviderError(
          `Gemini ${label} is disabled and the Images page did not load; the account allowance may be spent or Gemini's UI changed`,
          'quota_exhausted',
          'menu item reported aria-disabled=true',
        );
      }

      await item.click();
      await this.page.keyboard.press('Escape').catch(() => {});

      for (let v = 0; v < 8; v += 1) {
        await new Promise((r) => setTimeout(r, 500));
        if (await isComposerInMode()) {
          this._createModeActive.add(assetType);
          this.logger.debug('Selected create mode', { assetType, label, attempt, verify: v });
          return;
        }
      }
    }

    throw new ProviderError(
      `Failed to select ${label} in Gemini menu`,
      'server_error',
      `composer placeholder did not become "${expectedPlaceholder}" after retries`,
    );
  }

  /**
   * Enter the Images surface and report whether its composer is ready.
   *
   * `/images` is a client-side route — a direct load redirects to `/app` — so
   * entering it means clicking the sidebar entry and waiting for the composer.
   * When the surface is not served to this account the click is a no-op (or a
   * redirect) and the caller falls back to the tools menu.
   */
  private async enterImagesPage(): Promise<boolean> {
    if (!this.page) return false;
    const composer = this.page.locator(IMAGES_COMPOSER).first();

    if (await composer.isVisible().catch(() => false)) return true;

    const entries = this.page.locator('a[href="/images"]');
    // The sidebar hydrates after the chat shell; clicking before it is mounted
    // (or before the SPA has attached its router) leaves the page on /app.
    await entries
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .catch(() => {});

    const count = await entries.count();
    for (let i = 0; i < count; i += 1) {
      const entry = entries.nth(i);
      if (!(await entry.isVisible().catch(() => false))) continue;
      await entry.click({ timeout: 5000 }).catch(() => {});
      break;
    }

    const ready = await composer
      .waitFor({ state: 'visible', timeout: IMAGES_PAGE_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

    if (!ready) {
      this.logger.warn('Gemini Images page did not render; falling back to the tools menu');
    }
    return ready;
  }

  /** Playwright's isDisabled() ignores aria-disabled on menu items. */
  private async isDisabled(locator: Locator): Promise<boolean> {
    return locator
      .evaluate((element) => {
        const node = element as HTMLElement;
        return (
          node.getAttribute('aria-disabled') === 'true' ||
          node.hasAttribute('disabled') ||
          node.getAttribute('data-disabled') === 'true'
        );
      })
      .catch(() => false);
  }

  private async resolveInput(): Promise<Locator> {
    if (!this.page) throw new Error('Page closed');

    // The Images composer first: the generic selector can land on the hidden
    // Quill clipboard on that surface.
    const imagesComposer = this.page.locator(IMAGES_COMPOSER).first();
    if (await imagesComposer.isVisible().catch(() => false)) return imagesComposer;

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

    // Match on aria-label, not inner text: the submit controls are icon-only.
    const sendPattern = /(send|submit|generate|create)/i;
    const buttons = this.page.locator('button[aria-label]');
    const count = await buttons.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const button = buttons.nth(i);
      const label = (await button.getAttribute('aria-label').catch(() => null)) ?? '';
      if (!sendPattern.test(label)) continue;
      if (!(await button.isVisible().catch(() => false))) continue;
      if (!(await button.isEnabled().catch(() => false))) continue;
      await button.click();
      return true;
    }

    // The generic icon fallback clicks the last button on the page, which on
    // the Images surface is the microphone. Only use it on the chat surface.
    const placeholder = await input.getAttribute('data-placeholder').catch(() => null);
    if (placeholder === 'Describe your image') return false;

    const iconBtn = this.page.locator('button').filter({ hasNotText: /\S/ }).last();
    const iconEnabled = await iconBtn.isEnabled().catch(() => false);
    if (iconEnabled) {
      await iconBtn.click();
      return true;
    }

    return false;
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
