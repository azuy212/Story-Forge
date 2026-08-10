#!/usr/bin/env node
import { Command, type OptionValues } from 'commander';
import * as clack from '@clack/prompts';
import { loadConfig, type Config, type ConfigOverrides } from './config';
import { Logger } from './logger';
import { GeminiClient } from './gemini-client';
import { PromptReader } from './prompt-reader';
import { startServer } from './server';
import type { AssetType } from './types';

const VERSION = '1.0.0';

const program = new Command();

program
  .name('gemini-image')
  .description('Generate images or videos through Google Gemini using Playwright automation')
  .version(VERSION)
  .option('--headless', 'run the browser in headless mode')
  .option('-o, --output <dir>', 'asset output directory')
  .option('-l, --log-level <level>', 'log level: debug, info, warn, error')
  .option('-p, --profile <dir>', 'browser user data directory (saved login session)');

function buildOverrides(opts: OptionValues, extra: Record<string, unknown> = {}): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  if (typeof opts.headless === 'boolean') overrides.headless = opts.headless;
  if (typeof opts.output === 'string') overrides.downloadDir = opts.output;
  if (typeof opts.logLevel === 'string') overrides.logLevel = opts.logLevel;
  if (typeof opts.profile === 'string') overrides.userDataDir = opts.profile;
  if (typeof opts.type === 'string') overrides.generationType = opts.type as AssetType;
  return { ...overrides, ...extra };
}

function parseAssetType(value: string | undefined, logger: Logger): AssetType {
  const type = value || 'image';
  if (type !== 'image' && type !== 'video') {
    logger.error(`Invalid type "${type}" — expected "image" or "video"`);
    process.exit(1);
  }
  return type;
}

function registerSignals(client: GeminiClient, logger: Logger): void {
  const handleSignal = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    await client.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
}

async function runGeneration(
  config: Config,
  logger: Logger,
  prompts: string[],
  assetType: AssetType,
): Promise<void> {
  const client = new GeminiClient(config, logger);
  registerSignals(client, logger);

  try {
    await client.start();
    await client.waitForAuthentication();
    await client.processAllPrompts(prompts, assetType);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Fatal error', { error: msg });
    process.exitCode = 1;
  } finally {
    await client.shutdown();
  }

  logger.info('All prompts processed');
}

async function promptForAssetType(): Promise<AssetType> {
  const type = await clack.select({
    message: 'What would you like to generate?',
    options: [
      { value: 'image', label: 'Image' },
      { value: 'video', label: 'Video' },
    ],
  });

  if (clack.isCancel(type)) {
    clack.cancel('Cancelled');
    process.exit(0);
  }

  return type as AssetType;
}

async function promptForPrompts(logger: Logger): Promise<string[]> {
  if (!process.stdin.isTTY) {
    logger.error(
      'No prompt provided and no interactive terminal detected — pass a prompt or use --prompts-file',
    );
    process.exit(1);
  }

  clack.intro('Gemini generation');

  const first = await clack.text({
    message: 'Enter a prompt for generation',
    placeholder: 'e.g. a cute cat wearing a wizard hat, digital art',
  });

  if (clack.isCancel(first)) {
    clack.cancel('Cancelled');
    process.exit(0);
  }

  const prompts: string[] = [first];

  let addingMore = true;
  while (addingMore) {
    const more = await clack.confirm({ message: 'Add another prompt?' });
    if (clack.isCancel(more) || !more) {
      addingMore = false;
      continue;
    }

    const next = await clack.text({ message: 'Enter prompt' });
    if (clack.isCancel(next)) {
      clack.cancel('Cancelled');
      process.exit(0);
    }
    prompts.push(next);
  }

  clack.outro(`Generating ${prompts.length} prompt${prompts.length === 1 ? '' : 's'}...`);
  return prompts;
}

program
  .command('generate')
  .description('Generate images or videos from a prompt or a prompts file')
  .argument('[prompt...]', 'prompt text (multiple words are joined into one prompt)')
  .option('-f, --prompts-file <file>', 'file with prompts, one per line (comments with #)')
  .option('-c, --concurrency <n>', 'number of prompts to process in parallel')
  .option('-t, --type <type>', 'asset type to generate: image or video (default image)')
  .action(async (promptArgs: string[], opts: OptionValues) => {
    const optsAll = { ...program.opts(), ...opts };
    const logger = new Logger(loadConfig().logLevel);
    const assetType = parseAssetType(optsAll.type as string | undefined, logger);

    const config = loadConfig(
      buildOverrides(optsAll, {
        promptsFile: typeof optsAll.promptsFile === 'string' ? optsAll.promptsFile : undefined,
        concurrency: optsAll.concurrency ? parseInt(optsAll.concurrency, 10) : undefined,
        generationType: assetType,
      }),
    );

    if (!optsAll.promptsFile && promptArgs.length === 0 && !optsAll.type) {
      config.generationType = await promptForAssetType();
    }

    let prompts: string[] = [];

    if (optsAll.promptsFile) {
      try {
        prompts = await new PromptReader(config.promptsFile).read();
      } catch (error) {
        logger.error('Failed to read prompts file', {
          path: config.promptsFile,
          error: String(error),
        });
        process.exit(1);
      }
    }

    if (promptArgs.length > 0) {
      prompts = prompts.concat(promptArgs.join(' '));
    }

    if (prompts.length === 0) {
      prompts = await promptForPrompts(logger);
    }

    logger.info('Loaded prompts', { count: prompts.length });
    await runGeneration(config, logger, prompts, config.generationType);
  });

program
  .command('login')
  .description('Launch the browser and wait for you to sign in to Google')
  .action(async (opts: OptionValues) => {
    const optsAll = { ...program.opts(), ...opts };
    const config = loadConfig(buildOverrides(optsAll));
    const logger = new Logger(config.logLevel);

    const client = new GeminiClient(config, logger);
    registerSignals(client, logger);

    try {
      await client.start();
      await client.waitForAuthentication();
      logger.info('Authentication complete — session saved to profile');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to authenticate', { error: msg });
      process.exitCode = 1;
    } finally {
      await client.shutdown();
    }
  });

program
  .command('server')
  .description('Start the HTTP API server')
  .option('--port <port>', 'port to listen on')
  .action(async (opts: OptionValues) => {
    const optsAll = { ...program.opts(), ...opts };
    const config = loadConfig(buildOverrides(optsAll));
    const port = optsAll.port
      ? parseInt(optsAll.port, 10)
      : parseInt(process.env.PORT || '3000', 10);
    await startServer(config, port);
  });

program.parse();
