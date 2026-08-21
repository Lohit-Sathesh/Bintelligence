"""
evaluate_external.py — Evaluate the trained model on an external raw dataset.

Scans data/raw/<dataset_key>/ for images, maps categories via config.yaml,
and runs the trained model to compute accuracy and a classification report.

Can be invoked via:
    python main.py --evaluate-external garbage_classification_v2
Or standalone:
    python src/evaluate_external.py --dataset garbage_classification_v2
"""

import os
import logging
from pathlib import Path

import numpy as np
import yaml
import tensorflow as tf
import keras
from sklearn.metrics import classification_report

logger = logging.getLogger(__name__)


def load_config(config_path: str = "config/config.yaml") -> dict:
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def _resolve_label(class_name: str, mapping: dict) -> str | None:
    """Try exact match, then lowercase, then substring fallback."""
    label = mapping.get(class_name) or mapping.get(class_name.lower())
    if label:
        return label
    for key, val in mapping.items():
        if key.lower() in class_name.lower():
            return val
    return None


def evaluate_external(dataset_key: str) -> None:
    config = load_config()
    ds_cfg = config["datasets"].get(dataset_key)

    if not ds_cfg:
        logger.error("Dataset '%s' not found in config.yaml.", dataset_key)
        return

    mapping = ds_cfg["mapping"]
    raw_dir = os.path.join(config["data"]["raw_dir"], dataset_key)
    if not os.path.isdir(raw_dir):
        logger.error("Raw directory not found: %s", raw_dir)
        return

    # ── Locate model ────────────────────────────────────────────────────
    models_dir = config["output"]["models_dir"]
    model_path = os.path.join(models_dir, "final_model.keras")
    if not os.path.exists(model_path):
        model_path = os.path.join(models_dir, "best_model_phase2.keras")
    if not os.path.exists(model_path):
        logger.error("No trained model found in %s", models_dir)
        return

    logger.info("Loading model from: %s", model_path)
    model = keras.models.load_model(model_path)

    # ── Discover images ─────────────────────────────────────────────────
    img_size = config["data"]["image_size"]
    valid_ext = set(config["data"]["valid_extensions"])
    batch_size = config["training"]["batch_size"]

    image_paths: list[str] = []
    image_labels: list[int] = []  # 0=dry, 1=wet

    for dirpath, _, filenames in os.walk(raw_dir):
        class_name = os.path.basename(dirpath)
        label = _resolve_label(class_name, mapping)
        if label is None:
            continue
        target_int = 1 if label == "wet" else 0
        for fname in filenames:
            if Path(fname).suffix.lower() in valid_ext:
                image_paths.append(os.path.join(dirpath, fname))
                image_labels.append(target_int)

    if not image_paths:
        logger.error("No valid images found in %s", raw_dir)
        return

    logger.info("Discovered %d images for evaluation.", len(image_paths))

    # ── Stream through model via generator ──────────────────────────────
    # We collect both predictions and true labels in a single pass so the
    # generator is only consumed once.
    y_true: list[int] = []
    y_prob_list: list[float] = []
    loaded = 0
    skipped = 0

    batch_imgs = []
    batch_labels = []

    def _flush_batch():
        nonlocal loaded
        if not batch_imgs:
            return
        arr = np.array(batch_imgs, dtype=np.float32)
        # EfficientNetB0 preprocess: rescale to [-1, 1]
        arr = tf.keras.applications.efficientnet.preprocess_input(arr)
        preds = model.predict(arr, verbose=0).flatten()
        y_prob_list.extend(preds.tolist())
        y_true.extend(batch_labels)
        loaded += len(batch_imgs)
        if loaded % (batch_size * 20) == 0 or loaded == len(image_paths):
            logger.info("  Processed %d / %d images...", loaded, len(image_paths))
        batch_imgs.clear()
        batch_labels.clear()

    for path, label in zip(image_paths, image_labels):
        try:
            img = keras.preprocessing.image.load_img(
                path, target_size=(img_size, img_size)
            )
            img_array = keras.preprocessing.image.img_to_array(img)
            batch_imgs.append(img_array)
            batch_labels.append(label)
        except Exception:
            skipped += 1
            continue

        if len(batch_imgs) >= batch_size:
            _flush_batch()

    _flush_batch()  # remaining images

    if not y_true:
        logger.error("No valid images could be loaded.")
        return

    y_true = np.array(y_true)
    y_prob = np.array(y_prob_list)
    y_pred = (y_prob >= 0.5).astype(int)

    accuracy = np.mean(y_true == y_pred)

    logger.info("\n" + "=" * 60)
    logger.info("EVALUATION RESULTS FOR %s", dataset_key)
    logger.info("=" * 60)
    logger.info("Images evaluated : %d", len(y_true))
    if skipped:
        logger.info("Images skipped   : %d (corrupt / unreadable)", skipped)
    logger.info("Overall Accuracy : %.2f%%\n", accuracy * 100)

    report = classification_report(
        y_true, y_pred, target_names=["dry", "wet"], digits=4
    )
    logger.info(report)


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(
        description="Evaluate model on an external raw dataset"
    )
    parser.add_argument(
        "--dataset", type=str, required=True, help="Dataset key from config.yaml"
    )
    args = parser.parse_args()
    evaluate_external(args.dataset)
