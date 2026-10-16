"""Pytest bootstrap for the TTS service tests.

`app.*` is imported the way the service is actually run — with `apps/tts` as
the working directory. This makes the same import work when pytest is started
from the repository root (`pnpm test:python`), where CWD would otherwise not
be on sys.path.
"""

import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))
