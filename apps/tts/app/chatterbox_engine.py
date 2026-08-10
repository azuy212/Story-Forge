import os
import re
import uuid

import torch
import torchaudio as ta
from chatterbox.tts_turbo import ChatterboxTurboTTS

from .config import DEVICE, OUTPUT_DIR

MAX_CHUNK_CHARS = 280
MIN_CHUNK_CHARS = 20
GAP_SECONDS = 0.2


class ChatterboxEngine:
    def __init__(self):
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        torch.set_float32_matmul_precision("high")
        self.device = DEVICE
        print(f"Loading Chatterbox on {self.device}")
        self.model = ChatterboxTurboTTS.from_pretrained(device=self.device)
        print("Chatterbox loaded")

    def _split_oversize(self, sentence: str, max_chars: int):
        parts = []
        remaining = sentence
        while len(remaining) > max_chars:
            window = remaining[:max_chars]
            cut = max_chars
            min_cut = len(window) // 2
            for delim in (",", ";", "—", "-", " "):
                idx = window.rfind(delim)
                if idx >= min_cut:
                    cut = idx + 1
                    break
            parts.append(remaining[:cut].strip())
            remaining = remaining[cut:].lstrip()
        parts.append(remaining.strip())
        return [part for part in parts if part]

    def _split_into_chunks(self, text: str, max_chars: int = MAX_CHUNK_CHARS):
        sentences = re.split(r"(?<=[.!?])\s+", text.strip())
        chunks = []
        current = ""
        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue
            if len(current) + len(sentence) + 1 <= max_chars:
                current = f"{current} {sentence}".strip()
                continue
            if current:
                chunks.append(current)
            if len(sentence) > max_chars:
                chunks.extend(self._split_oversize(sentence, max_chars))
                current = ""
            else:
                current = sentence
        if current:
            chunks.append(current)
        merged = []
        for chunk in chunks:
            if merged and len(chunk) < MIN_CHUNK_CHARS:
                merged[-1] = f"{merged[-1]} {chunk}".strip()
            else:
                merged.append(chunk)
        if merged and len(merged) > 1 and len(merged[0]) < MIN_CHUNK_CHARS:
            merged[1] = f"{merged[0]} {merged[1]}".strip()
            merged = merged[1:]
        return merged

    def generate(self, text: str, voice: str | None = None):
        voice_name = voice or "narrator"
        voice_path = os.path.join("app/voices", f"{voice_name}.wav")
        if not os.path.exists(voice_path):
            raise ValueError(f"Voice '{voice_name}' not found")
        chunks = self._split_into_chunks(text)
        if not chunks:
            raise ValueError("Text must not be empty")
        print(f"Generating {len(chunks)} chunks")
        chunk_wavs = []
        for i, chunk in enumerate(chunks):
            print(f"Chunk {i + 1}/{len(chunks)}: {len(chunk)} chars")
            print(chunk[:80])
            try:
                wav = self.model.generate(chunk, audio_prompt_path=voice_path).squeeze(
                    0
                )
            except Exception as e:
                raise RuntimeError(
                    f"TTS generation failed on chunk {i + 1}/{len(chunks)}"
                ) from e
            chunk_wavs.append(wav)
        silence_gap = torch.zeros(
            int(GAP_SECONDS * self.model.sr),
            dtype=chunk_wavs[0].dtype,
            device=chunk_wavs[0].device,
        )
        combined_parts = []
        for i, wav in enumerate(chunk_wavs):
            if i > 0:
                combined_parts.append(silence_gap)
            combined_parts.append(wav)
        combined = torch.cat(combined_parts).unsqueeze(0)
        filename = f"{uuid.uuid4()}.wav"
        filepath = os.path.join(OUTPUT_DIR, filename)
        ta.save(filepath, combined, self.model.sr)
        return {"filename": filename, "path": filepath}
