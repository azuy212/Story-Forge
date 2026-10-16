import os

from dotenv import load_dotenv

load_dotenv()


def _env(name: str, default: str) -> str:
    """Read an env var, treating a blank value the same as unset."""
    return os.getenv(name, "").strip() or default


DEVICE = _env("DEVICE", "mps")
OUTPUT_DIR = _env("OUTPUT_DIR", "outputs")
