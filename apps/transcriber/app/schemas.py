from pydantic import BaseModel


class Word(BaseModel):
    word: str
    start: float
    end: float
    score: float | None = None


class Segment(BaseModel):
    start: float
    end: float
    text: str
    words: list[Word]


class AlignResponse(BaseModel):
    duration: float
    language: str
    segments: list[Segment]
    words: list[Word]


class HealthResponse(BaseModel):
    status: str
    alignment_model_loaded: bool
    asr_loaded: bool
    device: str
    asr_device: str
    compute_type: str
    model: str
    language: str | None
