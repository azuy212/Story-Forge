from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .chatterbox_engine import ChatterboxEngine
from .config import OUTPUT_DIR

app = FastAPI(title="Chatterbox TTS API", version="1.0.0")

engine = ChatterboxEngine()

app.mount("/audio", StaticFiles(directory=OUTPUT_DIR), name="audio")


class GenerateRequest(BaseModel):
    text: str
    voice: str | None = None


@app.get("/")
def health():
    return {"status": "running", "service": "chatterbox"}


@app.post("/generate")
def generate(request: GenerateRequest):
    try:
        result = engine.generate(request.text, request.voice)
        return {
            "status": "success",
            "file": result["filename"],
            "url": f"/audio/{result['filename']}",
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
