import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  assertReferenceUploadCount,
  GeminiClient,
  uploadReferenceImages,
} from '../src/gemini-client';
import { GenerateRequestSchema, MAX_REFERENCE_IMAGE_BYTES } from '../src/server';
import { loadConfig } from '../src/config';
import { Logger } from '../src/logger';

test('uploads reference image through Upload & tools file input', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button aria-label="Upload & tools">Upload</button>
      <input type="file" multiple>
    `);

    await uploadReferenceImages(page, [
      {
        id: 'source-1',
        filename: 'source.png',
        mime: 'image/png',
        base64: Buffer.from('source-image').toString('base64'),
      },
    ]);

    const uploaded = await page.locator('input[type="file"]').evaluate((input) => {
      const file = (input as HTMLInputElement).files?.[0];
      return file ? { name: file.name, type: file.type, size: file.size } : null;
    });

    assert.deepEqual(uploaded, {
      name: 'source.png',
      type: 'image/png',
      size: 'source-image'.length,
    });
  } finally {
    await browser.close();
  }
});

test('rejects partial reference upload acceptance', () => {
  assert.throws(() => assertReferenceUploadCount(1, 2), /accepted 1 of 2 image\(s\)/);
});

test('enforces explicit reference-image limits', () => {
  const exact = Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES).toString('base64');
  const exactResult = GenerateRequestSchema.safeParse({
    prompt: 'test',
    referenceImages: [{ id: 'exact', filename: 'exact.png', mime: 'image/png', base64: exact }],
  });
  assert.equal(exactResult.success, true);

  const oversized = Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES + 1).toString('base64');
  const result = GenerateRequestSchema.safeParse({
    prompt: 'test',
    referenceImages: [{ id: 'large', filename: 'large.png', mime: 'image/png', base64: oversized }],
  });

  assert.equal(result.success, false);

  const invalid = GenerateRequestSchema.safeParse({
    prompt: 'test',
    referenceImages: [
      { id: 'invalid', filename: 'invalid.png', mime: 'image/png', base64: 'not-base64!*' },
    ],
  });
  assert.equal(invalid.success, false);

  const tooMany = GenerateRequestSchema.safeParse({
    prompt: 'test',
    referenceImages: Array.from({ length: 5 }, (_, index) => ({
      id: `image-${index}`,
      filename: `${index}.png`,
      mime: 'image/png',
      base64: 'c291cmNl',
    })),
  });
  assert.equal(tooMany.success, false);
});

test(
  'uploads a local reference and generates source_composite output through Gemini UI',
  { skip: process.env.RUN_GEMINI_REFERENCE_INTEGRATION !== 'true' },
  async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'gemini-reference-composite-'));
    const sourcePath = join(workDir, 'source.png');
    const outputDir = join(workDir, 'outputs');
    const cacheDir = join(workDir, 'cache');
    const sourcePng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await writeFile(sourcePath, Buffer.from(sourcePng, 'base64'));
    const client = new GeminiClient(
      loadConfig({ downloadDir: outputDir, cacheDir }),
      new Logger('info'),
    );
    const png = (await readFile(sourcePath)).toString('base64');
    try {
      await client.start();
      await client.waitForAuthentication();
      const result = await client.generate(
        'Use the attached local source image as the identity reference. Preserve its exact subject and distinctive colors, and place it in a simple neutral studio scene. Return one generated image.',
        'image',
        {
          mode: 'image_to_image',
          referenceImages: [
            { id: 'integration-source', filename: 'source.png', mime: 'image/png', base64: png },
          ],
        },
      );
      assert.ok(result.assets.length > 0);
      assert.ok(result.assets[0].buffer.length > 2048);
      await mkdir(outputDir, { recursive: true });
      const outputPath = join(outputDir, 'source-composite.png');
      await writeFile(outputPath, result.assets[0].buffer);
      console.log(`source_composite output: ${outputPath}`);
    } finally {
      await client.shutdown();
      if (process.env.KEEP_GEMINI_REFERENCE_OUTPUTS !== 'true') {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  },
);

test(
  'uploads a local reference and generates source_edit output through Gemini UI',
  { skip: process.env.RUN_GEMINI_REFERENCE_INTEGRATION !== 'true' },
  async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'gemini-reference-edit-'));
    const sourcePath = join(workDir, 'source.png');
    const outputDir = join(workDir, 'outputs');
    const cacheDir = join(workDir, 'cache');
    const sourcePng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await writeFile(sourcePath, Buffer.from(sourcePng, 'base64'));
    const client = new GeminiClient(
      loadConfig({ downloadDir: outputDir, cacheDir }),
      new Logger('info'),
    );
    try {
      await client.start();
      await client.waitForAuthentication();
      const result = await client.generate(
        'Edit the attached local source image. Preserve its exact subject and distinctive colors, add a thin red border, and return one generated image.',
        'image',
        {
          mode: 'edit',
          referenceImages: [
            {
              id: 'local-source-edit',
              filename: 'source.png',
              mime: 'image/png',
              base64: (await readFile(sourcePath)).toString('base64'),
            },
          ],
        },
      );
      assert.ok(result.assets.length > 0);
      assert.ok(result.assets[0].buffer.length > 2048);
      await mkdir(outputDir, { recursive: true });
      const outputPath = join(outputDir, 'source-edit.png');
      await writeFile(outputPath, result.assets[0].buffer);
      console.log(`source_edit output: ${outputPath}`);
    } finally {
      await client.shutdown();
      if (process.env.KEEP_GEMINI_REFERENCE_OUTPUTS !== 'true') {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  },
);
