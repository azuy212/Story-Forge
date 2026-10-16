"""Shared pytest fixtures/stubs for the transcriber service tests.

`app.config` imports torch only to resolve the MPS device. On CI neither torch
nor the model weights are installed, so a minimal torch stub is injected when
the real library is absent. When torch IS installed the real module is used, and
tests that depend on MPS availability patch `torch.backends.mps.is_available`
explicitly.
"""

import sys
import types

try:  # pragma: no cover - exercised only where torch is installed
    import torch  # noqa: F401
except ModuleNotFoundError:  # pragma: no cover - CI / CPU-only environments
    _torch = types.ModuleType("torch")
    _torch.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: False)
    )
    sys.modules.setdefault("torch", _torch)
