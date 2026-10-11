"""Unit tests for the transcriber's environment configuration."""

import pytest
from app.config import Config


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in (
        "WHISPERX_MODEL",
        "WHISPERX_DEVICE",
        "WHISPERX_COMPUTE_TYPE",
        "WHISPERX_LANGUAGE",
        "WHISPERX_FORCE_TRANSCRIBE",
    ):
        monkeypatch.delenv(name, raising=False)


def test_defaults():
    config = Config.from_env()
    assert config.model == "large-v3"
    assert config.compute_type == "int8"
    assert config.device == "auto"
    assert config.language is None
    assert config.force_transcribe is False


@pytest.mark.parametrize(
    "value,expected",
    [
        ("auto", "auto"),
        ("AUTO", "auto"),
        (" mps ", "mps"),
        ("MPS", "mps"),
        ("cpu", "cpu"),
        ("bogus", "auto"),
        ("", "auto"),
    ],
)
def test_device_normalization(monkeypatch, value, expected):
    monkeypatch.setenv("WHISPERX_DEVICE", value)
    assert Config.from_env().device == expected


def test_language_blank_becomes_none(monkeypatch):
    monkeypatch.setenv("WHISPERX_LANGUAGE", "   ")
    assert Config.from_env().language is None


def test_language_is_normalized_and_kept(monkeypatch):
    monkeypatch.setenv("WHISPERX_LANGUAGE", " EN ")
    assert Config.from_env().language == "EN"


@pytest.mark.parametrize("value", ["1", "true", "True", " true ", "TRUE"])
def test_force_transcribe_truthy(monkeypatch, value):
    monkeypatch.setenv("WHISPERX_FORCE_TRANSCRIBE", value)
    assert Config.from_env().force_transcribe is True


def test_model_and_compute_type_are_stripped(monkeypatch):
    monkeypatch.setenv("WHISPERX_MODEL", "  medium.en  ")
    monkeypatch.setenv("WHISPERX_COMPUTE_TYPE", " float16 ")
    config = Config.from_env()
    assert config.model == "medium.en"
    assert config.compute_type == "float16"


def test_blank_model_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("WHISPERX_MODEL", "   ")
    assert Config.from_env().model == "large-v3"


def test_blank_compute_type_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("WHISPERX_COMPUTE_TYPE", "")
    assert Config.from_env().compute_type == "int8"


@pytest.mark.parametrize("value", ["0", "", "false", "no", "TRUEISH", "yes"])
def test_force_transcribe_falsy(monkeypatch, value):
    monkeypatch.setenv("WHISPERX_FORCE_TRANSCRIBE", value)
    assert Config.from_env().force_transcribe is False


def test_torch_device_cpu_is_cpu(monkeypatch):
    monkeypatch.setenv("WHISPERX_DEVICE", "cpu")
    assert Config.from_env().torch_device == "cpu"


def test_torch_device_explicit_mps_requires_availability(monkeypatch):
    monkeypatch.setenv("WHISPERX_DEVICE", "mps")
    monkeypatch.setattr(
        "torch.backends.mps.is_available", lambda: True, raising=False
    )
    assert Config.from_env().torch_device == "mps"


def test_torch_device_mps_without_mps_support_falls_back_to_cpu(monkeypatch):
    monkeypatch.setenv("WHISPERX_DEVICE", "mps")
    monkeypatch.setattr(
        "torch.backends.mps.is_available", lambda: False, raising=False
    )
    assert Config.from_env().torch_device == "cpu"


def test_torch_device_auto_with_mps_support(monkeypatch):
    monkeypatch.setenv("WHISPERX_DEVICE", "auto")
    monkeypatch.setattr(
        "torch.backends.mps.is_available", lambda: True, raising=False
    )
    assert Config.from_env().torch_device == "mps"


def test_torch_device_auto_without_mps_support(monkeypatch):
    monkeypatch.setattr(
        "torch.backends.mps.is_available", lambda: False, raising=False
    )
    assert Config.from_env().torch_device == "cpu"
