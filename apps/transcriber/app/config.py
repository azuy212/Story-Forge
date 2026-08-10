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

        return cls(
            model=os.getenv("WHISPERX_MODEL", "large-v3").strip(),
            device=device,
            compute_type=os.getenv("WHISPERX_COMPUTE_TYPE", "int8").strip(),
            language=language,
            force_transcribe=os.getenv(
                "WHISPERX_FORCE_TRANSCRIBE", "0"
            ).strip() in ("1", "true", "True"),
        )
