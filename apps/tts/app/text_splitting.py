"""Pure text-splitting helpers for TTS chunking.

Deliberately dependency-free: importing this module must not pull torch,
torchaudio, or chatterbox into the process, so the sentence/chunk logic is
unit-testable without a model, GPU, or the model weights.
"""

import re

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
