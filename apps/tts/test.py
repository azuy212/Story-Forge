import os
import re
import time

import torch
import torchaudio as ta
from chatterbox.tts_turbo import ChatterboxTurboTTS


DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

VOICE_PATH = "app/voices/narrator.wav"
OUTPUT_DIR = "test_output"

TEXT = (
    "On January 15, 1919, a wave of sticky syrup crashed through "
    "Boston's streets at 35 miles per hour."
)


def word_count(text: str) -> int:
    return len(re.findall(r"\b[\w'-]+\b", text))


def duration_seconds(wav: torch.Tensor, sample_rate: int) -> float:
    # wav shape can be [samples] or [channels, samples]
    if wav.ndim == 2:
        samples = wav.shape[-1]
    else:
        samples = wav.shape[0]

    return samples / sample_rate


def calculate_wpm(words: int, duration: float) -> float:
    if duration <= 0:
        return 0.0

    return words / (duration / 60.0)


def save_wav(wav: torch.Tensor, sample_rate: int, path: str):
    if wav.ndim == 1:
        wav = wav.unsqueeze(0)

    ta.save(path, wav.cpu(), sample_rate)


def generate_and_report(
    model,
    text: str,
    output_path: str,
    voice_path: str | None = None,
):
    print()
    print("=" * 70)

    if voice_path:
        print("TEST: WITH VOICE PROMPT")
        print(f"Voice: {voice_path}")
    else:
        print("TEST: WITHOUT VOICE PROMPT")

    print("=" * 70)
    print(f"Text: {text}")

    words = word_count(text)
    print(f"Words: {words}")

    start = time.perf_counter()

    if voice_path:
        wav = model.generate(
            text,
            audio_prompt_path=voice_path,
        )
    else:
        wav = model.generate(text)

    generation_time = time.perf_counter() - start

    wav = wav.squeeze(0)

    duration = duration_seconds(wav, model.sr)
    wpm = calculate_wpm(words, duration)

    save_wav(wav, model.sr, output_path)

    print()
    print(f"Audio duration:  {duration:.3f} seconds")
    print(f"WPM:             {wpm:.1f}")
    print(f"Generation time: {generation_time:.3f} seconds")
    print(f"Sample rate:     {model.sr}")
    print(f"Saved to:        {output_path}")

    return {
        "duration": duration,
        "wpm": wpm,
        "generation_time": generation_time,
        "path": output_path,
    }


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if not os.path.exists(VOICE_PATH):
        raise FileNotFoundError(
            f"Voice file not found: {VOICE_PATH}"
        )

    print(f"Using device: {DEVICE}")
    print("Loading Chatterbox Turbo...")

    torch.set_float32_matmul_precision("high")

    model = ChatterboxTurboTTS.from_pretrained(
        device=DEVICE
    )

    print("Chatterbox loaded.")

    words = word_count(TEXT)

    print()
    print("=" * 70)
    print("NARRATION SPEED TEST")
    print("=" * 70)
    print(f"Text:  {TEXT}")
    print(f"Words: {words}")
    print("=" * 70)

    # ---------------------------------------------------------
    # Test 1: No voice prompt
    # ---------------------------------------------------------

    without_voice = generate_and_report(
        model=model,
        text=TEXT,
        output_path=os.path.join(
            OUTPUT_DIR,
            "without_voice.wav",
        ),
        voice_path=None,
    )

    # ---------------------------------------------------------
    # Test 2: With your narrator voice
    # ---------------------------------------------------------

    with_voice = generate_and_report(
        model=model,
        text=TEXT,
        output_path=os.path.join(
            OUTPUT_DIR,
            "with_voice.wav",
        ),
        voice_path=VOICE_PATH,
    )

    # ---------------------------------------------------------
    # Comparison
    # ---------------------------------------------------------

    print()
    print()
    print("=" * 70)
    print("RESULT")
    print("=" * 70)

    print(
        f"{'':20}"
        f"{'Without Voice':>20}"
        f"{'With Voice':>20}"
    )

    print(
        f"{'Duration':20}"
        f"{without_voice['duration']:>19.3f}s"
        f"{with_voice['duration']:>19.3f}s"
    )

    print(
        f"{'WPM':20}"
        f"{without_voice['wpm']:>20.1f}"
        f"{with_voice['wpm']:>20.1f}"
    )

    print(
        f"{'Generation time':20}"
        f"{without_voice['generation_time']:>19.3f}s"
        f"{with_voice['generation_time']:>19.3f}s"
    )

    duration_difference = (
        with_voice["duration"]
        - without_voice["duration"]
    )

    wpm_difference = (
        with_voice["wpm"]
        - without_voice["wpm"]
    )

    print()
    print(
        f"Voice duration difference: "
        f"{duration_difference:+.3f}s"
    )

    print(
        f"Voice WPM difference: "
        f"{wpm_difference:+.1f}"
    )

    print("=" * 70)


if __name__ == "__main__":
    main()