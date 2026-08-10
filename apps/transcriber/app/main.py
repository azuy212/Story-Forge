import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from .config import Config
from .schemas import AlignResponse, HealthResponse
from .whisperx_engine import (
    AlignmentError,
    AudioDecodeError,
    LanguageRequiredError,
    WhisperXEngine,
)

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
        alignment_model_loaded=bool(engine and engine.alignment_model_loaded),
        asr_loaded=bool(engine and engine.asr_loaded),
        device=engine.device if engine else "unknown",
        asr_device=engine.asr_device if engine else "unknown",
        compute_type=engine.config.compute_type if engine else "unknown",
        model=engine.config.model if engine else "unknown",
        language=engine.config.language if engine else None,
    )


@app.post("/align", response_model=AlignResponse)
def align(
    audio: UploadFile | None = File(default=None),
    text: str | None = Form(default=None),
):
    if engine is None:
        raise HTTPException(status_code=503, detail="service not ready")

    if audio is None or not audio.filename:
        raise HTTPException(status_code=400, detail="audio file is required")

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
        except AudioDecodeError as error:
            logger.warning("audio decode failed: %s", error)
            raise HTTPException(status_code=422, detail=str(error))
        except LanguageRequiredError as error:
            logger.warning("language required: %s", error)
            raise HTTPException(status_code=400, detail=str(error))
        except AlignmentError as error:
            logger.error("alignment failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"alignment failed: {error}",
            )
        except Exception:
            logger.exception("WhisperX processing failed")
            raise HTTPException(
                status_code=500,
                detail="WhisperX processing failed",
            )

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
