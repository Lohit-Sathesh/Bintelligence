import io
import logging
import sys
import os
from contextlib import asynccontextmanager

# Add parent directory to sys.path to allow imports from src/
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi.staticfiles import StaticFiles
from api.dashboard import router as dashboard_router
import urllib.request
from PIL import Image
import numpy as np
import tensorflow as tf

from src.predict import load_model, load_config
from src.dataset import CLASS_NAMES

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global variables for model and config
model = None
config = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load model and config on startup
    global model, config
    logger.info("Starting up FastAPI application...")
    try:
        config = load_config()
        model = load_model(config)
        logger.info("Model loaded successfully.")
    except Exception as e:
        logger.error(f"Failed to load the model on startup: {e}")
        # We don't raise here so the app can start and return an informative error message
    
    yield
    # Cleanup on shutdown
    logger.info("Shutting down FastAPI application...")

app = FastAPI(
    title="Wet/Dry Waste Classification API",
    description="API for classifying images as either wet or dry waste.",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(dashboard_router, prefix="/api/dashboard", tags=["dashboard"])

class URLRequest(BaseModel):
    url: str

def _run_inference(contents: bytes) -> dict:
    image = Image.open(io.BytesIO(contents)).convert("RGB")
    
    # Preprocess image
    image_size = config["data"]["image_size"] if config else 224
    image = image.resize((image_size, image_size), Image.LANCZOS)
    arr = np.array(image, dtype=np.float32)
    arr = tf.keras.applications.efficientnet.preprocess_input(arr)
    x = np.expand_dims(arr, axis=0)  # Add batch dimension
    
    # Predict
    prob = float(model.predict(x, verbose=0)[0][0])
    pred_class = CLASS_NAMES[1] if prob >= 0.5 else CLASS_NAMES[0]
    confidence = prob if prob >= 0.5 else 1.0 - prob

    from src.gradcam import gradcam_bbox

    return {
        "class": pred_class,
        "confidence": round(confidence * 100, 2),
        "probabilities": {
            "dry": round((1 - prob) * 100, 2),
            "wet": round(prob * 100, 2)
        },
        "bbox": gradcam_bbox(model, x)
    }

@app.get("/health")
async def health_check():
    """Health check endpoint to ensure API is running and model is loaded."""
    if model is None:
        return JSONResponse(status_code=503, content={"status": "unhealthy", "message": "Model not loaded. Please train the model first."})
    return {"status": "healthy", "message": "API and model are ready"}

@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    """Predict whether the uploaded image is wet or dry waste."""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded. Please ensure the model is trained.")
    
    if not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File provided is not an image.")
    
    try:
        contents = await file.read()
        result = _run_inference(contents)
        result["filename"] = file.filename
        return result
    except Exception as e:
        logger.error(f"Prediction failed: {e}")
        raise HTTPException(status_code=500, detail=f"Prediction failed: {str(e)}")

@app.post("/predict-url")
async def predict_url(request: URLRequest):
    """Predict whether the image at the provided URL is wet or dry waste."""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded. Please ensure the model is trained.")
    
    try:
        req = urllib.request.Request(request.url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response:
            contents = response.read()
            
        result = _run_inference(contents)
        result["url"] = request.url
        return result
    except Exception as e:
        logger.error(f"URL Prediction failed: {e}")
        raise HTTPException(status_code=500, detail=f"URL Prediction failed: {str(e)}")

# Mount the 'webapp' static directory at the root
webapp_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "webapp")
app.mount("/", StaticFiles(directory=webapp_path, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)
