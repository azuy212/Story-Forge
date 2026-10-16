"""Service-boundary errors and the shared provider error envelope.

Every failure that leaves this service is reported as the envelope documented
in AGENTS.md (Provider HTTP Contracts) and mirrored by the transcriber:

    {"error": {"code": str, "message": str, "requestId": str | null}}

`message` is always caller-safe: never a file path, a model name, or raw
exception text. Correlating a failure back to the server-side traceback uses
`requestId`, which is generated per request in `main.py`.

Status mapping at the boundary:
    400  TTSRequestError   (bad voice name, empty text — caller can fix it)
    503  TTSEngineError    (model/device/encoding failure — transient)
    429  engine saturated  (another generation is already running)
"""


class TTSRequestError(ValueError):
    """Caller sent something this service will not attempt (HTTP 400).

    Subclasses keep the original message: it describes caller input, so it
    carries no internals. Never raise this with content derived from
    filesystem paths or a stack trace.
    """

    status_code = 400
    code = "INVALID_REQUEST"


class VoiceNotFoundError(TTSRequestError):
    code = "VOICE_NOT_FOUND"


class EmptyTextError(TTSRequestError):
    code = "EMPTY_TEXT"


class TTSEngineError(RuntimeError):
    """The engine could not produce audio (model, device, or encoding).

    Subclasses RuntimeError so existing callers that catch RuntimeError keep
    working, while the boundary distinguishes a transient engine failure (503)
    from a genuine programming error (500).
    """

    status_code = 503
    code = "ENGINE_FAILURE"


class EngineBusyError(Exception):
    """Another generation holds the single engine slot (HTTP 429)."""

    status_code = 429
    code = "ENGINE_BUSY"


def error_envelope(code: str, message: str, request_id: str | None) -> dict:
    """Build the error body shared by all provider services (AGENTS.md).

    Pure and dependency-free so the contract is unit-testable without
    importing FastAPI or the engine.
    """
    return {
        "error": {
            "code": code,
            "message": message,
            "requestId": request_id,
        }
    }
