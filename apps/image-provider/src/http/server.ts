import { pathToFileURL } from 'url';
import { Logger } from '../logger';
import { loadConfig, type Config } from '../config';
import { GeminiClient } from '../core/gemini-client';
import { createApp } from './app';

// Re-exported: these are the HTTP contract other modules (and the integration
// tests) import from the server entry point.
export {
  GenerateRequestSchema,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_REQUEST_BYTES,
} from './request-schema';

/**
 * Server lifecycle: lazy browser start, signal handling, and listen. Route
 * registration and request handling live in ./app and ./routes, the error
 * envelope in ./error-envelope, and payload shaping in ./payloads.
 */
export async function startServer(config: Config, port: number): Promise<void> {
  const logger = new Logger(config.logLevel);
  const client = new GeminiClient(config, logger);

  // The browser is launched on the first non-cached /generate, never at
  // startup, so /health answers immediately.
  let browserStarting: Promise<void> | null = null;
  const startBrowser = (): Promise<void> => {
    if (browserStarting) return browserStarting;
    browserStarting = (async () => {
      logger.info('Starting browser (lazy init)...');
      await client.start();
      await client.waitForAuthentication();
    })().catch((error) => {
      browserStarting = null;
      throw error;
    });
    return browserStarting;
  };

  const app = createApp({ config, logger, client, ensureBrowser: startBrowser });

  app.addHook('onClose', async () => {
    logger.info('Shutting down browser...');
    await client.shutdown();
  });

  const handleSignal = async (received: string) => {
    logger.info(`Received ${received}, shutting down...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  await app.listen({ port, host: '0.0.0.0' });
  logger.info(`API server ready at http://localhost:${port}`);
  logger.info('Endpoints:');
  logger.info('  GET  /health');
  logger.info(
    '  POST /generate  body: { "prompt": "...", "type": "image|video", "mode": "text_to_image|image_to_image|edit", "referenceImages": [] }',
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env.PORT || '3000', 10);
  await startServer(config, port);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    process.exit(1);
  });
}
