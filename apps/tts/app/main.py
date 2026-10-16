import logging
import threading
import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .chatterbox_engine import ChatterboxEngine
from .config import OUTPUT_DIR
from .errors import TTSEngineError, TTSRequestError, error_envelope

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("app")

app = FastAPI(title="Chatterbox TTS API", version="1.0.0")

engine = ChatterboxEngine()

# The engine owns a single non-reentrant model instance, so only one
# generation may run at a time. FastAPI threadpools sync handlers, which means
# concurrent requests would otherwise contend on shared model/GPU state and
# race for the same output directory. Acquire is non-blocking so a saturated
# service fails fast with 429 instead of queueing work it cannot do.
GENERATION_SEMAPHORE = threading.Semaphore(1)

app.mount("/audio", StaticFiles(directory=OUTPUT_DIR), name="audio")


class GenerateRequest(BaseModel):
    text: str
    voice: str | None = None


def _request_id() -> str:
    return uuid.uuid4().hex[:12]


def _error_response(
    status_code: int,
    code: str,
    message: str,
    request_id: str,
) -> JSONResponse:
    """Envelope shared by all provider services (see AGENTS.md)."""
    return JSONResponse(
        status_code=status_code,
        content=error_envelope(code, message, request_id),
    )


@app.get("/health")
def health():
    return {"status": "running", "service": "chatterbox"}


# Deprecated alias kept for older orchestrator configurations; returns the
# identical payload as /health and will be removed in a future release.
@app.get("/")
def health_alias():
    return health()


@app.post("/generate")
def generate(request: GenerateRequest):
    request_id = _request_id()

    if not GENERATION_SEMAPHORE.acquire(blocking=False):
        logger.warning("generate saturated request_id=%s", request_id)
        return _error_response(
            429,
            "ENGINE_BUSY",
            "TTS engine is busy with another generation; retry shortly.",
            request_id,
        )

    try:
        result = engine.generate(request.text, request.voice)
    except TTSRequestError as error:
        # Caller-fixable input (bad voice, empty text): the message describes
        # what the caller sent, so it carries no internals.
        logger.warning("invalid request request_id=%s: %s", request_id, error)
        return _error_response(400, error.code, str(error), request_id)
    except TTSEngineError:
        # Correlation ID points at the server-side traceback; the raw cause
        # (file paths, model internals) never leaves the service.
        logger.exception("engine failure request_id=%s", request_id)
        return _error_response(
            503,
            TTSEngineError.code,
            "TTS generation failed.",
            request_id,
        )
    except Exception:
        logger.exception("unexpected failure request_id=%s", request_id)
        return _error_response(
            500,
            "INTERNAL",
            "TTS generation failed.",
            request_id,
        )
    finally:
        GENERATION_SEMAPHORE.release()

    logger.info(
        "generate complete request_id=%s file=%s",
        request_id,
        result["filename"],
    )
    return {
        "status": "success",
        "file": result["filename"],
        "url": f"/audio/{result['filename']}",
    }
