"""
main.py — FastAPI server for wet/dry waste classification.

Differences from api/main.py:
  - Inference uses TFLite (app.predictor) instead of full TensorFlow.
    Removes ~500 MB from the Docker image.
  - sys.path hack removed; proper package layout used instead.
  - Dashboard router excluded: it reads data/raw + outputs/ which are
    training-time directories, not present in the Docker image.
    Re-add it locally by importing api.dashboard if needed.
  - Startup no longer silently swallows a missing model file — it logs a
    clear error and the /health endpoint returns 503 until the model loads.
  - /predict-url kept; note below re: SSRF.
"""

import io
import logging
import os
import urllib.request
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from app import devices
from app.predictor import WasteClassifier

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODEL_PATH = os.getenv("MODEL_PATH", "app/model/waste_classifier.tflite")
WEBAPP_DIR = os.getenv("WEBAPP_DIR", "webapp")

classifier: WasteClassifier | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global classifier
    logger.info("Starting up...")
    try:
        classifier = WasteClassifier(MODEL_PATH)
        logger.info("Model loaded: %s", MODEL_PATH)
    except Exception as e:
        # Don't crash — /health will return 503 instead.
        logger.error("Failed to load model: %s", e)
    yield
    classifier = None
    logger.info("Shutting down.")


app = FastAPI(
    title="Wet/Dry Waste Classification API",
    description="Classify images as wet or dry waste.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(devices.router)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class URLRequest(BaseModel):
    url: str


# ---------------------------------------------------------------------------
# Inference helper
# ---------------------------------------------------------------------------

def _infer(contents: bytes) -> dict:
    image = Image.open(io.BytesIO(contents))
    return classifier.predict(image)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health_check():
    if classifier is None:
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "message": "Model not loaded."},
        )
    return {"status": "healthy", "message": "API and model are ready."}


@app.post("/predict")
async def predict(
    file: UploadFile = File(...),
    x_device_id: str | None = Header(None),
    x_device_key: str | None = Header(None),
):
    if classifier is None:
        raise HTTPException(status_code=503, detail="Model not loaded.")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image.")
    try:
        contents = await file.read()
        result = _infer(contents)
        result["filename"] = file.filename
    except Exception as e:
        logger.error("Prediction failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Prediction failed: {e}")

    # Requests from a dustbin are also logged for the mobile app's live feed.
    if x_device_id:
        devices.record_event(x_device_id, x_device_key, result, contents)
    return result


@app.post("/predict-url")
async def predict_url(request: URLRequest):
    """
    Predict from an image URL.

    SSRF note: only http/https schemes are accepted. In a public deployment
    consider also blocking private/loopback ranges (RFC-1918) or routing
    requests through an egress proxy.
    """
    if classifier is None:
        raise HTTPException(status_code=503, detail="Model not loaded.")
    if not request.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Only http/https URLs accepted.")
    try:
        req = urllib.request.Request(
            request.url, headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            contents = resp.read()
        result = _infer(contents)
        result["url"] = request.url
        return result
    except Exception as e:
        logger.error("URL prediction failed: %s", e)
        raise HTTPException(status_code=500, detail=f"URL prediction failed: {e}")


# ---------------------------------------------------------------------------
# Static frontend — must be mounted last (catches all unmatched routes)
# ---------------------------------------------------------------------------

if os.path.isdir(WEBAPP_DIR):
    app.mount("/", StaticFiles(directory=WEBAPP_DIR, html=True), name="static")
else:
    logger.warning("webapp dir not found at '%s' — frontend not served.", WEBAPP_DIR)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
