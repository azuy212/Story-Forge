import os

from dotenv import load_dotenv

load_dotenv()

DEVICE = os.getenv("DEVICE", "mps")
OUTPUT_DIR = os.getenv("OUTPUT_DIR", "outputs")
