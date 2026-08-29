import os
import re
import uuid

import torch
import torchaudio as ta
from chatterbox.tts_turbo import ChatterboxTurboTTS

from .config import DEVICE, OUTPUT_DIR

MAX_CHUNK_CHARS = 450
SENTENCE_PAUSE_MS = 200
CROSSFADE_MS = 20

ABBREVIATIONS: set[str] = {
    "mr.",
    "mrs.",
    "ms.",
    "dr.",
    "prof.",
    "rev.",
    "hon.",
    "st.",
    "etc.",
    "e.g.",
    "i.e.",
    "vs.",
    "approx.",
    "apt.",
    "dept.",
    "fig.",
    "gen.",
    "gov.",
    "inc.",
    "jr.",
    "sr.",
    "ltd.",
    "no.",
    "p.",
    "pp.",
    "vol.",
    "op.",
    "cit.",
    "ca.",
    "cf.",
    "ed.",
    "esp.",
    "et.",
    "al.",
    "ibid.",
    "id.",
    "inf.",
    "sup.",
    "viz.",
    "sc.",
    "fl.",
    "d.",
    "b.",
    "r.",
    "c.",
    "v.",
    "u.s.",
    "u.k.",
    "a.m.",
    "p.m.",
    "a.d.",
    "b.c.",
}

NUMBER_DOT_NUMBER_PATTERN = re.compile(r"(?<!\d\.)\d*\.\d+")
VERSION_PATTERN = re.compile(r"[vV]?\d+(\.\d+)+")
POTENTIAL_END_PATTERN = re.compile(r'([.!?])(["\']?)(\s+|$)')
BULLET_POINT_PATTERN = re.compile(r"(?:^|\n)([-•*]|\d+\.)[ \t]+")
NON_VERBAL_CUE_PATTERN = re.compile(r"(\([\w\s'-]+\))")


def _is_valid_sentence_end(text: str, period_index: int) -> bool:
    word_start_before_period = period_index - 1
    scan_limit = max(0, period_index - 10)
    while (
        word_start_before_period >= scan_limit
        and not text[word_start_before_period].isspace()
    ):
        word_start_before_period -= 1
    word_before_period = text[word_start_before_period + 1 : period_index + 1].lower()
    if word_before_period in ABBREVIATIONS:
        return False

    context_start = max(0, period_index - 10)
    context_end = min(len(text), period_index + 10)
    context_segment = text[context_start:context_end]
    relative_period_index_in_context = period_index - context_start

    for pattern in [NUMBER_DOT_NUMBER_PATTERN, VERSION_PATTERN]:
        for match in pattern.finditer(context_segment):
            if match.start() <= relative_period_index_in_context < match.end():
                is_last_char_of_numeric_match = (
                    relative_period_index_in_context == match.end() - 1
                )
                is_followed_by_space_or_eos = (
                    period_index + 1 == len(text) or text[period_index + 1].isspace()
                )
                if not (
                    is_last_char_of_numeric_match and is_followed_by_space_or_eos
                ):
                    return False
    return True


def _split_text_by_punctuation(text: str) -> list[str]:
    sentences: list[str] = []
    last_split_index = 0
    text_length = len(text)

    for match in POTENTIAL_END_PATTERN.finditer(text):
        punctuation_char_index = match.start(1)
        punctuation_char = text[punctuation_char_index]
        slice_end_after_punctuation = match.start(1) + 1 + len(match.group(2) or "")

        if punctuation_char in ["!", "?"]:
            current_sentence_text = text[
                last_split_index:slice_end_after_punctuation
            ].strip()
            if current_sentence_text:
                sentences.append(current_sentence_text)
            last_split_index = match.end()
            continue

        if punctuation_char == ".":
            if (
                punctuation_char_index > 0
                and text[punctuation_char_index - 1] == "."
            ) or (
                punctuation_char_index < text_length - 1
                and text[punctuation_char_index + 1] == "."
            ):
                continue

            if _is_valid_sentence_end(text, punctuation_char_index):
                current_sentence_text = text[
                    last_split_index:slice_end_after_punctuation
                ].strip()
                if current_sentence_text:
                    sentences.append(current_sentence_text)
                last_split_index = match.end()

    remaining_text_segment = text[last_split_index:].strip()
    if remaining_text_segment:
        sentences.append(remaining_text_segment)

    sentences = [s for s in sentences if s]
    if not sentences and text.strip():
        return [text.strip()]
    return sentences


def split_into_sentences(text: str) -> list[str]:
    if not text or text.isspace():
        return []

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    bullet_point_matches = list(BULLET_POINT_PATTERN.finditer(text))

    if len(bullet_point_matches) >= 2:
        processed_sentences: list[str] = []
        current_position = 0
        for i, bullet_match in enumerate(bullet_point_matches):
            bullet_actual_start_index = bullet_match.start()
            if i == 0 and bullet_actual_start_index > current_position:
                pre_bullet_segment = text[
                    current_position:bullet_actual_start_index
                ].strip()
                if pre_bullet_segment:
                    processed_sentences.extend(
                        s for s in _split_text_by_punctuation(pre_bullet_segment) if s
                    )

            next_bullet_start_index = (
                bullet_point_matches[i + 1].start()
                if i + 1 < len(bullet_point_matches)
                else len(text)
            )
            bullet_item_segment = text[
                bullet_actual_start_index:next_bullet_start_index
            ].strip()
            if bullet_item_segment:
                processed_sentences.append(bullet_item_segment)
            current_position = next_bullet_start_index

        if current_position < len(text):
            post_bullet_segment = text[current_position:].strip()
            if post_bullet_segment:
                processed_sentences.extend(
                    s for s in _split_text_by_punctuation(post_bullet_segment) if s
                )
        return [s for s in processed_sentences if s]
    else:
        return _split_text_by_punctuation(text)


def chunk_text_by_sentences(full_text: str, chunk_size: int) -> list[str]:
    if not full_text or full_text.isspace():
        return []
    if chunk_size <= 0:
        chunk_size = float("inf")

    processed_segments = split_into_sentences(full_text)
    if not processed_segments:
        return []

    text_chunks: list[str] = []
    current_chunk_sentences: list[str] = []
    current_chunk_length = 0

    for segment_text in processed_segments:
        segment_len = len(segment_text)

        if not current_chunk_sentences:
            current_chunk_sentences.append(segment_text)
            current_chunk_length = segment_len
        elif current_chunk_length + 1 + segment_len <= chunk_size:
            current_chunk_sentences.append(segment_text)
            current_chunk_length += 1 + segment_len
        else:
            if current_chunk_sentences:
                text_chunks.append(" ".join(current_chunk_sentences))
            current_chunk_sentences = [segment_text]
            current_chunk_length = segment_len

        if current_chunk_length > chunk_size and len(current_chunk_sentences) == 1:
            text_chunks.append(" ".join(current_chunk_sentences))
            current_chunk_sentences = []
            current_chunk_length = 0

    if current_chunk_sentences:
        text_chunks.append(" ".join(current_chunk_sentences))

    text_chunks = [chunk for chunk in text_chunks if chunk.strip()]

    if not text_chunks and full_text.strip():
        return [full_text.strip()]

    return text_chunks


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
        print(f"Loading Chatterbox on {self.device}")
        self.model = ChatterboxTurboTTS.from_pretrained(device=self.device)
        print("Chatterbox loaded")

    def generate(self, text: str, voice: str | None = None):
        voice_name = voice or "narrator"
        voice_path = os.path.join("app/voices", f"{voice_name}.wav")
        if not os.path.exists(voice_path):
            raise ValueError(f"Voice '{voice_name}' not found")
        chunks = chunk_text_by_sentences(text, MAX_CHUNK_CHARS)
        if not chunks:
            raise ValueError("Text must not be empty")
        print(f"Generating {len(chunks)} chunks")
        chunk_wavs = []
        for i, chunk in enumerate(chunks):
            print(f"Chunk {i + 1}/{len(chunks)}: {len(chunk)} chars")
            print(chunk[:80])
            try:
                wav = self.model.generate(
                    chunk,
                    audio_prompt_path=voice_path,
                ).squeeze(0)

                print(f"[tts] Voice path: {os.path.abspath(voice_path)}")
                print(f"[tts] Voice exists: {os.path.exists(voice_path)}")
                print(f"[tts] Voice size: {os.path.getsize(voice_path)} bytes")

                print(f"[tts] Sample rate: {self.model.sr}")
                print(f"[tts] Tensor shape: {tuple(wav.shape)}")

                duration = wav.shape[-1] / self.model.sr
                words = len(re.findall(r"\b[\w'-]+\b", chunk))
                wpm = words / (duration / 60)

                print(
                    f"[tts] Chunk duration: {duration:.3f}s | "
                    f"Words: {words} | "
                    f"WPM: {wpm:.1f}"
                )

            except Exception as e:
                raise RuntimeError(
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

        print(
            f"Final narration duration: {final_duration:.3f}s"
        )

        filename = f"{uuid.uuid4()}.wav"
        filepath = os.path.join(OUTPUT_DIR, filename)
        ta.save(filepath, combined, sr)
        return {"filename": filename, "path": filepath}
