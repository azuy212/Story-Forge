import { z } from 'zod/v4';

export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_REFERENCE_REQUEST_BYTES = 64 * 1024 * 1024;

/**
 * `import.meta.url`-root char-check + canonical round-trip: padding and
 * whitespace are not accepted as valid Base64, so an encoded payload that
 * merely *looks* base64 is rejected instead of being silently truncated.
 */
export function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;

  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;

  const normalized = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  const decoded = Buffer.from(normalized, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/, '');
  return canonical === unpadded && decoded.length > 0 ? decoded : null;
}

const ReferenceImageSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mime: z.string().regex(/^image\//),
  base64: z.string().min(1),
});

export const GenerateRequestSchema = z
  .object({
    prompt: z.string().min(1, 'Prompt is required').max(4000, 'Prompt too long'),
    type: z.enum(['image', 'video']).optional().default('image'),
    mode: z.enum(['text_to_image', 'image_to_image', 'edit']).optional().default('text_to_image'),
    referenceImages: z.array(ReferenceImageSchema).max(4).optional().default([]),
  })
  .superRefine((request, ctx) => {
    request.referenceImages.forEach((reference, index) => {
      const decoded = decodeBase64(reference.base64);
      if (!decoded) {
        ctx.addIssue({
          code: 'custom',
          path: ['referenceImages', index, 'base64'],
          message: 'Reference image must contain valid Base64 data',
        });
      } else if (decoded.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
        ctx.addIssue({
          code: 'custom',
          path: ['referenceImages', index, 'base64'],
          message: `Reference image exceeds ${MAX_REFERENCE_IMAGE_BYTES} raw bytes`,
        });
      }
    });
  });

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
