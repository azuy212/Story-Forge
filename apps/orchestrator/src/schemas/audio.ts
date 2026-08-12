import { z } from "zod";

export const SceneAudioSchema = z.object({
  sceneId: z.number().int().positive(),
  artifactId: z.string().min(1).optional(),
  narration: z.string().min(1),
  durationMs: z.number().positive(),
  // Local filesystem path consumed by FFmpeg concat/composer. Remote URLs are
  // rejected by concatAudio; TTS providers must persist audio to disk.
  url: z.string().min(1),
});

export const CombinedAudioSchema = z.object({
  artifactId: z.string().min(1).optional(),
  durationMs: z.number().positive(),
  url: z.string().min(1),
  sourceSceneArtifactIds: z.array(z.string().min(1)),
});

export const AudioSchema = z.object({
  narrationUrl: z.string().optional(),
  narrationDurationMs: z.number().optional(),
  voice: z.string().optional(),
  generatedAt: z.string().optional(),
  version: z.literal(2).optional(),
  scenes: z.array(SceneAudioSchema).optional(),
  combinedAudio: CombinedAudioSchema.optional(),
});

export type SceneAudio = z.input<typeof SceneAudioSchema>;
export type CombinedAudio = z.input<typeof CombinedAudioSchema>;
export type Audio = z.input<typeof AudioSchema>;
