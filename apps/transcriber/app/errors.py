"""Service-boundary errors and the shared provider error envelope.

Every failure that leaves this service is reported as the envelope documented
in AGENTS.md (Provider HTTP Contracts) and mirrored by the TTS service and the
image provider:

    {"error": {"code": str, "message": str, "requestId": str | null}}

`message` is always caller-safe: never a file path, a model name, or raw
exception text. Correlating a failure back to the server-side traceback uses
`requestId`.
"""


class WhisperXRequestError(Exception):
    """Caller sent something this service will not attempt (HTTP 400)."""

    status_code = 400
    code = "INVALID_REQUEST"


class AudioDecodeError(WhisperXRequestError):
    status_code = 422
    code = "AUDIO_DECODE_FAILED"


class LanguageRequiredError(WhisperXRequestError):
    code = "LANGUAGE_REQUIRED"


class AlignmentError(Exception):
    """Alignment failed for a request we cannot attribute to the caller."""

    status_code = 500
    code = "ALIGNMENT_FAILED"


def error_envelope(code: str, message: str, request_id: str | None) -> dict:
    """Build the error body shared by all provider services (AGENTS.md)."""
    return {
        "error": {
            "code": code,
            "message": message,
            "requestId": request_id,
        }
    }
