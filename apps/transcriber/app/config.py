import os

import torch


class Config:
    def __init__(
        self,
        model: str,
        device: str,
        compute_type: str,
        language: str | None,
        force_transcribe: bool,
    ):
        self.model = model
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self.force_transcribe = force_transcribe

    @property
    def torch_device(self) -> str:
        if self.device == "mps":
            return "mps" if torch.backends.mps.is_available() else "cpu"
        if self.device == "cpu":
            return "cpu"
        return "mps" if torch.backends.mps.is_available() else "cpu"

    @classmethod
    def from_env(cls) -> "Config":
        device = os.getenv("WHISPERX_DEVICE", "auto").strip().lower()
        if device not in ("auto", "mps", "cpu"):
            device = "auto"

        language = os.getenv("WHISPERX_LANGUAGE", "").strip() or None

        # A blank value is the same as unset: `os.getenv` only substitutes the
        # default when the variable is ABSENT, so an empty override would
        # otherwise hand the engine an empty model name.
        return cls(
            model=(os.getenv("WHISPERX_MODEL") or "").strip() or "large-v3",
            device=device,
            compute_type=(
                os.getenv("WHISPERX_COMPUTE_TYPE") or ""
            ).strip()
            or "int8",
            language=language,
            force_transcribe=(os.getenv("WHISPERX_FORCE_TRANSCRIBE") or "")
            .strip()
            .lower()
            in ("1", "true"),
        )
