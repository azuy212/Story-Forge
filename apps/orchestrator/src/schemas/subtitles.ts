import { z } from "zod";

export const WordTimestampSchema = z.object({
  word: z.string().min(1),
  start: z.number().min(0),
  end: z.number().positive(),
});

export const SubtitlesSchema = z.object({
  srt: z.string().optional(),
  ass: z.string().optional(),
  wordTimestamps: z.array(WordTimestampSchema).optional(),
  generatedAt: z.string().optional(),
});

export type Subtitles = z.input<typeof SubtitlesSchema>;
export type WordTimestamp = z.input<typeof WordTimestampSchema>;
