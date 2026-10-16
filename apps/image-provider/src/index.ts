import { loadConfig } from './config.js';
import { Logger } from './logger.js';
import { PromptReader } from './cli/prompt-reader.js';
import { GeminiClient } from './core/gemini-client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  logger.info('Gemini Image Automation starting', {
    headless: config.headless,
    promptsFile: config.promptsFile,
  });

  let prompts: string[];
  try {
    prompts = await new PromptReader(config.promptsFile).read();
  } catch (error) {
    logger.error('Failed to read prompts file', {
      path: config.promptsFile,
      error: String(error),
    });
    process.exit(1);
  }

  if (prompts.length === 0) {
    logger.warn('No prompts found — add prompts to prompts.txt');
    process.exit(0);
  }

  logger.info(`Loaded ${prompts.length} prompts`);

  const client = new GeminiClient(config, logger);

  const handleSignal = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    await client.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  try {
    await client.start();
    await client.waitForAuthentication();
    await client.processAllPrompts(prompts, config.generationType);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Fatal error', { error: msg });
  } finally {
    await client.shutdown();
  }

  logger.info('All prompts processed');
}

// Entry point: deliberately fire-and-forget, hence the explicit void.
void main();
