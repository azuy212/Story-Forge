import dotenv from 'dotenv';
import path from 'path';
import type { AssetType } from './types';

dotenv.config();

export interface Config {
  geminiUrl: string;
  headless: boolean;
  browserExecutablePath: string | undefined;
  userDataDir: string;
  concurrency: number;
  timeout: number;
  videoTimeout: number;
  navigationTimeout: number;
  authenticationTimeout: number;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  downloadDir: string;
  cacheDir: string;
  promptsFile: string;
  generationType: AssetType;
  logLevel: string;
}

export interface ConfigOverrides {
  geminiUrl?: string;
  headless?: boolean;
  browserExecutablePath?: string;
  userDataDir?: string;
  concurrency?: number;
  timeout?: number;
  videoTimeout?: number;
  navigationTimeout?: number;
  authenticationTimeout?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  downloadDir?: string;
  cacheDir?: string;
  promptsFile?: string;
  generationType?: AssetType;
  logLevel?: string;
}

function parseAssetType(value: string | undefined, fallback: AssetType): AssetType {
  return value === 'video' ? 'video' : value === 'image' ? 'image' : fallback;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  return {
    geminiUrl: overrides.geminiUrl || process.env.GEMINI_URL || 'https://gemini.google.com',
    headless: overrides.headless ?? process.env.BROWSER_HEADLESS === 'true',
    browserExecutablePath:
      overrides.browserExecutablePath || process.env.BROWSER_EXECUTABLE_PATH || undefined,
    userDataDir: path.resolve(
      overrides.userDataDir || process.env.USER_DATA_DIR || './browser-profile',
    ),
    concurrency: Math.max(1, overrides.concurrency ?? parseInt(process.env.CONCURRENCY || '1', 10)),
    timeout: overrides.timeout ?? parseInt(process.env.TIMEOUT || '180000', 10),
    videoTimeout: overrides.videoTimeout ?? parseInt(process.env.VIDEO_TIMEOUT || '300000', 10),
    navigationTimeout:
      overrides.navigationTimeout ?? parseInt(process.env.NAVIGATION_TIMEOUT || '30000', 10),
    authenticationTimeout:
      overrides.authenticationTimeout ??
      parseInt(process.env.AUTHENTICATION_TIMEOUT || '300000', 10),
    retryMaxAttempts:
      overrides.retryMaxAttempts ?? parseInt(process.env.RETRY_MAX_ATTEMPTS || '3', 10),
    retryBaseDelayMs:
      overrides.retryBaseDelayMs ?? parseInt(process.env.RETRY_BASE_DELAY_MS || '2000', 10),
    downloadDir: path.resolve(overrides.downloadDir || process.env.DOWNLOAD_DIR || './outputs'),
    cacheDir: path.resolve(overrides.cacheDir || process.env.CACHE_DIR || './cache'),
    promptsFile: path.resolve(overrides.promptsFile || process.env.PROMPTS_FILE || './prompts.txt'),
    generationType: overrides.generationType
      ? parseAssetType(overrides.generationType, 'image')
      : process.env.GENERATION_TYPE === 'video'
        ? 'video'
        : 'image',
    logLevel: overrides.logLevel || process.env.LOG_LEVEL || 'info',
  };
}
