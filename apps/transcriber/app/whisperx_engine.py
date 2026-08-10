import logging
import math
import threading
import time

import whisperx

from .config import Config

logger = logging.getLogger("whisperx_engine")

EPS = 0.05
SAMPLE_RATE = 16000


class AlignmentError(Exception):
    pass


class AudioDecodeError(Exception):
    pass


class LanguageRequiredError(Exception):
    pass


class WhisperXEngine:
    def __init__(self, config: Config):
        self.config = config
        self._lock = threading.Lock()
        self.device = config.torch_device
        self.asr_device = "cpu"
        self._model = None
        self._align_models: dict[str, tuple] = {}

    def load(self) -> None:
        logger.info("Loading WhisperX")
        logger.info("device=%s", self.device)
        logger.info("asr_device=%s", self.asr_device)
        logger.info("compute_type=%s", self.config.compute_type)
        logger.info("model=%s", self.config.model)

        if self.config.language:
            self._get_align_model(self.config.language)

        logger.info("WhisperX ready (ASR model lazy-loaded on demand)")

    def _get_asr_model(self):
        if self._model is None:
            logger.info(
                "Loading ASR model=%s device=%s compute_type=%s",
                self.config.model,
                self.asr_device,
                self.config.compute_type,
            )
            self._model = whisperx.load_model(
                self.config.model,
                device=self.asr_device,
                compute_type=self.config.compute_type,
            )
            logger.info("ASR model loaded")
        return self._model

    @property
    def alignment_model_loaded(self) -> bool:
        return bool(self._align_models)

    @property
    def asr_loaded(self) -> bool:
        return self._model is not None

    def _get_align_model(self, language: str):
        if language not in self._align_models:
            logger.info("Loading alignment model language=%s", language)
            model, metadata = whisperx.load_align_model(
                language_code=language,
                device=self.device,
            )
            self._align_models[language] = (model, metadata)
            logger.info(
                "Alignment model loaded language=%s device=%s",
                language,
                self.device,
            )
        return self._align_models[language]

    def align_audio(self, audio_path: str, text: str | None) -> dict:
        text = text.strip() if text else None

        with self._lock:
            try:
                audio = whisperx.load_audio(audio_path)
            except Exception as error:
                raise AudioDecodeError(f"failed to decode audio: {error}") from error

            duration = audio.shape[0] / SAMPLE_RATE
            inference_start = time.perf_counter()

            if text and not self.config.force_transcribe:
                if not self.config.language:
                    raise LanguageRequiredError(
                        "WHISPERX_LANGUAGE is required when text is supplied "
                        "unless WHISPERX_FORCE_TRANSCRIBE=1"
                    )
                language = self.config.language
                align_model, metadata = self._get_align_model(language)
                transcript = [{"text": text, "start": 0, "end": duration}]
            else:
                language = self.config.language
                model = self._get_asr_model()
                result = model.transcribe(
                    audio,
                    batch_size=8,
                    language=language,
                )
                language = result.get("language") or language
                align_model, metadata = self._get_align_model(language)
                transcript = result["segments"]

            aligned = whisperx.align(
                transcript,
                align_model,
                metadata,
                audio,
                self.device,
                return_char_alignments=False,
            )

        segments = []
        words = []

        for segment in aligned.get("segments", []):
            segment_words = []

            for word in segment.get("words", []):
                if (
                    word.get("word") is None
                    or word.get("start") is None
                    or word.get("end") is None
                ):
                    continue
                segment_words.append(
                    {
                        "word": word["word"],
                        "start": float(word["start"]),
                        "end": float(word["end"]),
                        "score": float(word["score"])
                        if word.get("score") is not None
                        else None,
                    }
                )

            words.extend(segment_words)
            segments.append(
                {
                    "start": float(segment.get("start") or 0.0),
                    "end": float(segment.get("end") or 0.0),
                    "text": segment.get("text") or "",
                    "words": segment_words,
                }
            )

        stats = self._validate(words, duration, text)
        whisperx_time = time.perf_counter() - inference_start

        logger.info(
            "Alignment complete duration=%.2fs language=%s words=%d "
            "whisperx_time=%.2fs device=%s word_count_ratio=%.3f",
            duration,
            language,
            len(words),
            whisperx_time,
            self.device,
            stats["word_count_ratio"] if text else None,
        )

        return {
            "duration": duration,
            "language": language,
            "segments": segments,
            "words": words,
        }

    def _validate(
        self, words: list[dict], duration: float, transcript_text: str | None
    ) -> dict:
        if not words:
            raise AlignmentError("no word timestamps produced")

        for word in words:
            start = word["start"]
            end = word["end"]

            if not math.isfinite(start) or not math.isfinite(end):
                raise AlignmentError("word timestamps are not finite")

            if start < -EPS or end > duration + EPS:
                raise AlignmentError(
                    "word timestamp out of range: "
                    f"start={start} end={end} duration={duration}"
                )

            if end <= start:
                raise AlignmentError(
                    f"word end before start: {word['word']} "
                    f"start={start} end={end}"
                )

        starts = [word["start"] for word in words]

        for index in range(1, len(starts)):
            if starts[index] < starts[index - 1] - EPS:
                raise AlignmentError("word timestamps are not monotonic")

        stats = {"word_count_ratio": None}

        if transcript_text:
            expected = len(transcript_text.split())
            ratio = min(1.0, len(words) / max(expected, 1))

            stats["word_count_ratio"] = ratio

        return stats
