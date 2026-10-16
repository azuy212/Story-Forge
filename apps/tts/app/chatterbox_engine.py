import logging
import os
import re
import uuid

import torch
import torchaudio as ta
from chatterbox.tts_turbo import ChatterboxTurboTTS

from .config import DEVICE, OUTPUT_DIR
from .errors import EmptyTextError, TTSEngineError, VoiceNotFoundError
from .text_splitting import (
    CROSSFADE_MS,
    MAX_CHUNK_CHARS,
    SENTENCE_PAUSE_MS,
    chunk_text_by_sentences,
    split_into_sentences,
)

# Re-exported so callers importing from this module keep working; the
# implementations live in `text_splitting` (pure, no torch).
__all__ = [
    "CROSSFADE_MS",
    "MAX_CHUNK_CHARS",
    "SENTENCE_PAUSE_MS",
    "ChatterboxEngine",
    "chunk_text_by_sentences",
    "split_into_sentences",
]

logger = logging.getLogger("app.chatterbox_engine")


def _crossfade_equal_power(
    chunk_a: torch.Tensor, chunk_b: torch.Tensor, fade_samples: int
) -> torch.Tensor:
    if fade_samples <= 0:
        return torch.cat([chunk_a, chunk_b])

    fade_samples = min(fade_samples, chunk_a.shape[-1], chunk_b.shape[-1])

    t = torch.linspace(0, torch.pi / 2, fade_samples, dtype=torch.float32)
    fade_out = torch.cos(t) ** 2
    fade_in = torch.sin(t) ** 2

    a_tail = chunk_a[..., -fade_samples:].to(torch.float32) * fade_out
    b_head = chunk_b[..., :fade_samples].to(torch.float32) * fade_in
    crossfaded = a_tail + b_head

    return torch.cat(
        [chunk_a[..., :-fade_samples], crossfaded, chunk_b[..., fade_samples:]],
        dim=-1,
    )


class ChatterboxEngine:
    def __init__(self):
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        torch.set_float32_matmul_precision("high")
        self.device = DEVICE
        logger.info("loading Chatterbox on %s", self.device)
        self.model = ChatterboxTurboTTS.from_pretrained(device=self.device)
        logger.info("Chatterbox loaded")

    def generate(self, text: str, voice: str | None = None):
        voice_name = voice or "narrator"
        voice_path = os.path.join("app/voices", f"{voice_name}.wav")
        if not os.path.exists(voice_path):
            raise VoiceNotFoundError(f"Voice '{voice_name}' not found")
        chunks = chunk_text_by_sentences(text, MAX_CHUNK_CHARS)
        if not chunks:
            raise EmptyTextError("Text must not be empty")
        logger.info("generating %d chunk(s) for voice=%s", len(chunks), voice_name)
        chunk_wavs = []
        for i, chunk in enumerate(chunks):
            logger.debug(
                "chunk %d/%d: %d chars", i + 1, len(chunks), len(chunk)
            )
            try:
                wav = self.model.generate(
                    chunk,
                    audio_prompt_path=voice_path,
                ).squeeze(0)

                duration = wav.shape[-1] / self.model.sr
                words = len(re.findall(r"\b[\w'-]+\b", chunk))
                wpm = words / (duration / 60)

                logger.debug(
                    "chunk %d/%d duration=%.3fs words=%d wpm=%.1f sr=%s shape=%s",
                    i + 1,
                    len(chunks),
                    duration,
                    words,
                    wpm,
                    self.model.sr,
                    tuple(wav.shape),
                )

            except Exception as e:
                raise TTSEngineError(
                    f"TTS generation failed on chunk {i + 1}/{len(chunks)}"
                ) from e
            chunk_wavs.append(wav)

        sr = self.model.sr
        if len(chunk_wavs) == 1:
            combined = chunk_wavs[0].unsqueeze(0)
        else:
            silence_samples = int(SENTENCE_PAUSE_MS / 1000 * sr)
            fade_samples = int(CROSSFADE_MS / 1000 * sr)
            silence = torch.zeros(
                silence_samples,
                dtype=chunk_wavs[0].dtype,
                device=chunk_wavs[0].device,
            )
            result = chunk_wavs[0]
            for next_wav in chunk_wavs[1:]:
                result = _crossfade_equal_power(
                    torch.cat([result, silence], dim=-1), next_wav, fade_samples
                )
            combined = result.unsqueeze(0)

        final_duration = combined.shape[-1] / sr

        logger.info("final narration duration=%.3fs", final_duration)

        filename = f"{uuid.uuid4()}.wav"
        filepath = os.path.join(OUTPUT_DIR, filename)
        ta.save(filepath, combined, sr)
        return {"filename": filename, "path": filepath}
