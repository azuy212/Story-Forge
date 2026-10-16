import logging
import os
import tempfile
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

from .config import Config
from .errors import (
    AlignmentError,
    AudioDecodeError,
    LanguageRequiredError,
    error_envelope,
)
from .schemas import AlignResponse, HealthResponse
from .whisperx_engine import WhisperXEngine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("app")

engine: WhisperXEngine | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global engine

    engine = WhisperXEngine(Config.from_env())
    engine.load()

    yield

    engine = None


app = FastAPI(title="WhisperX Alignment Service", lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(
        status="ok" if engine else "loading",
        service="whisperx",
        alignment_model_loaded=bool(engine and engine.alignment_model_loaded),
        asr_loaded=bool(engine and engine.asr_loaded),
        device=engine.device if engine else "unknown",
        asr_device=engine.asr_device if engine else "unknown",
        compute_type=engine.config.compute_type if engine else "unknown",
        model=engine.config.model if engine else "unknown",
        language=engine.config.language if engine else None,
    )


def _fail(
    status_code: int,
    code: str,
    message: str,
    request_id: str,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=error_envelope(code, message, request_id),
    )


@app.post("/align", response_model=AlignResponse)
def align(
    audio: UploadFile | None = File(default=None),
    text: str | None = Form(default=None),
):
    request_id = uuid.uuid4().hex[:12]

    if engine is None:
        return _fail(503, "SERVICE_NOT_READY", "service not ready", request_id)

    if audio is None or not audio.filename:
        logger.warning("missing audio request_id=%s", request_id)
        return _fail(400, "AUDIO_REQUIRED", "audio file is required", request_id)

    text = text.strip() if text else None
    request_start = time.perf_counter()

    path = None

    try:
        with tempfile.NamedTemporaryFile(
            prefix="whisperx_",
            suffix=".wav",
            delete=False,
        ) as temp:
            path = temp.name
            temp.write(audio.file.read())

        try:
            result = engine.align_audio(path, text)
        except (AudioDecodeError, LanguageRequiredError) as error:
            logger.warning("invalid request request_id=%s: %s", request_id, error)
            return _fail(error.status_code, error.code, str(error), request_id)
        except AlignmentError:
            logger.exception("alignment failed request_id=%s", request_id)
            return _fail(
                AlignmentError.status_code,
                AlignmentError.code,
                "alignment failed",
                request_id,
            )
        except Exception:
            logger.exception("WhisperX processing failed request_id=%s", request_id)
            return _fail(500, "INTERNAL", "alignment failed", request_id)

        logger.info(
            "request_complete duration=%.2fs words=%d "
            "request_time=%.2fs device=%s",
            result["duration"],
            len(result["words"]),
            time.perf_counter() - request_start,
            engine.device,
        )

        return AlignResponse(**result)
    finally:
        if path is not None:
            try:
                os.unlink(path)
            except OSError:
                logger.warning("failed to remove temp file %s", path)
