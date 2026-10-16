"""Unit tests for the pure TTS text-chunking helpers.

These import `app.text_splitting` directly, which must stay dependency-free
(no torch, no chatterbox) so this suite runs on CPU-only CI with just pytest
installed.
"""

import pytest

from app.text_splitting import (
    MAX_CHUNK_CHARS,
    _is_valid_sentence_end,
    _split_text_by_punctuation,
    chunk_text_by_sentences,
    split_into_sentences,
)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Hello world.", ["Hello world."]),
        ("Hello world. Second sentence!", ["Hello world.", "Second sentence!"]),
        ("One? Two. Three!", ["One?", "Two.", "Three!"]),
        ("", []),
        ("   ", []),
        ("No terminal punctuation", ["No terminal punctuation"]),
    ],
)
def test_split_into_sentences_basic(text, expected):
    assert split_into_sentences(text) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        # Abbreviations must not terminate a sentence.
        ("Dr. Smith arrived.", ["Dr. Smith arrived."]),
        ("It happened in the U.S. last year.", ["It happened in the U.S. last year."]),
        ("See e.g. this case.", ["See e.g. this case."]),
        ("They met Mr. and Mrs. Jones.", ["They met Mr. and Mrs. Jones."]),
    ],
)
def test_abbreviations_do_not_split(text, expected):
    assert split_into_sentences(text) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        # Decimals are not sentence ends.
        ("The value is 3.14 exactly.", ["The value is 3.14 exactly."]),
        (
            "It grew 0.5 percent. Then it fell.",
            ["It grew 0.5 percent.", "Then it fell."],
        ),
        # Version strings are not sentence ends.
        ("Software v1.2.3 shipped.", ["Software v1.2.3 shipped."]),
        (
            "Model 2.0.1 was released. It was fast.",
            ["Model 2.0.1 was released.", "It was fast."],
        ),
    ],
)
def test_numbers_and_versions_do_not_split(text, expected):
    assert split_into_sentences(text) == expected


def test_ellipsis_does_not_split():
    assert split_into_sentences("He paused... then spoke.") == [
        "He paused... then spoke."
    ]


def test_bullet_lists_keep_items_together():
    text = "Shopping list:\n- milk\n- eggs\n- bread"
    sentences = split_into_sentences(text)
    assert sentences == ["Shopping list:", "- milk", "- eggs", "- bread"]


def test_numbered_lists_keep_items_together():
    text = "Steps:\n1. First\n2. Second\n3. Third"
    sentences = split_into_sentences(text)
    assert sentences == ["Steps:", "1. First", "2. Second", "3. Third"]


def test_single_bullet_is_not_treated_as_a_list():
    # A lone bullet is prose, not a list: the bullet path needs >= 2 markers.
    text = "Note:\n- only one item follows here."
    assert split_into_sentences(text) == ["Note:\n- only one item follows here."]


@pytest.mark.parametrize(
    "text,index,expected",
    [
        ("Dr. Smith arrived.", 2, False),  # abbreviation
        ("ca. 1990", 2, False),  # abbreviation
        ("e.g. it", 3, False),  # dotted abbreviation
        ("the value is 3.14", 14, False),  # decimal, not the final digit
        ("v1.2.3", 1, False),  # version: not the final digit
        ("v1.2.3", 3, False),  # version: not the final digit
        ("v1.2.3", 4, False),  # version: not the final digit
        ("end of it.", 9, True),
    ],
)
def test_is_valid_sentence_end(text, index, expected):
    assert _is_valid_sentence_end(text, index) is expected


def test_split_by_punctuation_preserves_quotes_after_terminator():
    assert _split_text_by_punctuation('He said "stop." Then left.') == [
        'He said "stop."',
        "Then left.",
    ]


def test_chunk_empty_and_blank_text():
    assert chunk_text_by_sentences("", 10) == []
    assert chunk_text_by_sentences("   \n  ", 10) == []


def test_chunk_zero_size_is_unlimited():
    text = "One sentence here. Two sentence there. Three sentence everywhere."
    assert chunk_text_by_sentences(text, 0) == [text]


def test_chunk_respects_size_without_losing_words():
    text = (
        "This is the first sentence. This is the second sentence. "
        "This is the third sentence. This is the fourth sentence."
    )
    chunks = chunk_text_by_sentences(text, 60)
    for chunk in chunks:
        assert len(chunk) <= 60
    assert " ".join(chunks) == " ".join(text.split())
    assert "".join(chunks).replace(" ", "") == "".join(text.split())


def test_chunk_never_drops_or_duplicates_a_sentence():
    sentences = [f"This is sentence number {i}." for i in range(20)]
    text = " ".join(sentences)
    chunks = chunk_text_by_sentences(text, 100)
    rebuilt = " ".join(chunks)
    assert rebuilt == " ".join(text.split())


def test_chunk_oversized_single_sentence_is_kept_whole():
    text = "A" * (MAX_CHUNK_CHARS * 2)
    assert chunk_text_by_sentences(text, MAX_CHUNK_CHARS) == [text]


def test_chunk_returns_single_chunk_when_text_fits():
    text = "Short text. Still fits."
    assert chunk_text_by_sentences(text, 500) == ["Short text. Still fits."]
