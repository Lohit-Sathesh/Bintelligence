"""
predict.py — Single-image and batch inference for wet/dry classification.

Usage:
  python -m src.predict path/to/image.jpg
  python -m src.predict path/to/folder/
"""

import os
import sys
import logging
from pathlib import Path

import numpy as np
import yaml
import tensorflow as tf
import keras
from PIL import Image

from src.dataset import CLASS_NAMES

logger = logging.getLogger(__name__)


def load_config(config_path: str = "config/config.yaml") -> dict:
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def load_model(config: dict, model_path: str | None = None) -> keras.Model:
    """Load the best trained model."""
    if model_path is None:
        candidates = [
            os.path.join(config["output"]["models_dir"], "best_model_phase2.keras"),
            os.path.join(config["output"]["models_dir"], "final_model.keras"),
        ]
        for c in candidates:
            if os.path.exists(c):
                model_path = c
                break

    if model_path is None or not os.path.exists(model_path):
        raise FileNotFoundError("No trained model found. Train the model first.")

    logger.info(f"Loading model: {model_path}")
    return keras.models.load_model(model_path)


def preprocess_image(
    image_path: str,
    image_size: int = 224,
) -> np.ndarray:
    """Load and preprocess a single image for inference."""
    img = Image.open(image_path).convert("RGB")
    img = img.resize((image_size, image_size), Image.LANCZOS)
    arr = np.array(img, dtype=np.float32)
    arr = tf.keras.applications.efficientnet.preprocess_input(arr)
    return np.expand_dims(arr, axis=0)  # add batch dim


def predict_single(
    model: keras.Model,
    image_path: str,
    image_size: int = 224,
) -> dict:
    """
    Predict a single image.

    Returns:
        Dict with 'class', 'confidence', and 'probabilities'.
    """
    x = preprocess_image(image_path, image_size)
    prob = float(model.predict(x, verbose=0)[0][0])

    pred_class = CLASS_NAMES[1] if prob >= 0.5 else CLASS_NAMES[0]
    confidence = prob if prob >= 0.5 else 1.0 - prob

    from src.gradcam import gradcam_bbox

    return {
        "image": image_path,
        "class": pred_class,
        "confidence": round(confidence * 100, 2),
        "probabilities": {
            "dry": round((1 - prob) * 100, 2),
            "wet": round(prob * 100, 2),
        },
        "bbox": gradcam_bbox(model, x),
    }


def predict_batch(
    model: keras.Model,
    image_dir: str,
    image_size: int = 224,
) -> list[dict]:
    """Predict all images in a directory."""
    valid_ext = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    results = []

    image_files = sorted(
        f for f in Path(image_dir).iterdir() if f.suffix.lower() in valid_ext
    )

    if not image_files:
        logger.warning(f"No images found in {image_dir}")
        return results

    logger.info(f"Processing {len(image_files)} images ...")
    for img_path in image_files:
        try:
            result = predict_single(model, str(img_path), image_size)
            results.append(result)
        except Exception as e:
            logger.error(f"Error processing {img_path}: {e}")

    return results


def print_results(results: list[dict]) -> None:
    """Pretty-print prediction results."""
    print("\n" + "=" * 70)
    print(f"{'Image':<40} {'Class':<8} {'Confidence':>10}")
    print("=" * 70)
    for r in results:
        name = os.path.basename(r["image"])
        if len(name) > 38:
            name = name[:35] + "..."
        print(f"{name:<40} {r['class'].upper():<8} {r['confidence']:>9.1f}%")
    print("=" * 70)

    # Summary
    wet_count = sum(1 for r in results if r["class"] == "wet")
    dry_count = sum(1 for r in results if r["class"] == "dry")
    print(f"\nSummary: {wet_count} wet, {dry_count} dry (total: {len(results)})")


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%H:%M:%S",
    )

    if len(sys.argv) < 2:
        print("Usage: python -m src.predict <image_or_folder>")
        sys.exit(1)

    target = sys.argv[1]
    cfg = load_config()
    model = load_model(cfg)
    img_size = cfg["data"]["image_size"]

    if os.path.isdir(target):
        results = predict_batch(model, target, img_size)
    elif os.path.isfile(target):
        results = [predict_single(model, target, img_size)]
    else:
        print(f"Path not found: {target}")
        sys.exit(1)

    print_results(results)
