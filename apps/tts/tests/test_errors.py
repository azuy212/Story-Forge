"""Contract tests for the TTS service error envelope."""

import pytest

from app.errors import (
    EmptyTextError,
    EngineBusyError,
    TTSEngineError,
    TTSRequestError,
    VoiceNotFoundError,
    error_envelope,
)


def test_envelope_shape():
    assert error_envelope("ENGINE_BUSY", "busy", "abc123") == {
        "error": {"code": "ENGINE_BUSY", "message": "busy", "requestId": "abc123"}
    }


def test_envelope_without_request_id():
    assert error_envelope("INTERNAL", "failed", None) == {
        "error": {"code": "INTERNAL", "message": "failed", "requestId": None}
    }


def test_only_expected_keys_are_present():
    body = error_envelope("C", "M", "R")
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message", "requestId"}


@pytest.mark.parametrize(
    "error,expected_status",
    [
        (VoiceNotFoundError("nope"), 400),
        (EmptyTextError("empty"), 400),
        (TTSRequestError("bad"), 400),
    ],
)
def test_request_errors_map_to_400(error, expected_status):
    assert error.status_code == expected_status
    assert isinstance(error, ValueError)


def test_engine_errors_map_to_503_and_still_are_runtime_errors():
    error = TTSEngineError("failed")
    assert error.status_code == 503
    assert isinstance(error, RuntimeError)


def test_engine_busy_maps_to_429():
    assert EngineBusyError("busy").status_code == 429


def test_error_codes_are_distinct_per_failure_mode():
    codes = {
        TTSEngineError.code,
        EngineBusyError.code,
        VoiceNotFoundError.code,
        EmptyTextError.code,
        TTSRequestError.code,
    }
    assert len(codes) == 5
