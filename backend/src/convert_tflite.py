"""
convert_tflite.py — Convert the trained Keras model to TensorFlow Lite.

Supports:
  - Standard float32 conversion
  - Dynamic-range quantisation (float16)
  - Full integer quantisation (int8) for edge / microcontroller deployment
"""

import os
import logging
import zipfile

import numpy as np
import yaml
import tensorflow as tf
import keras
import h5py

from src.dataset import get_dataset, CLASS_NAMES
from src.model import build_model

logger = logging.getLogger(__name__)


def load_config(config_path: str = "config/config.yaml") -> dict:
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def _get_representative_dataset(config: dict):
    """
    Generator that yields representative samples for int8 quantisation.
    Uses a subset of the training data.
    """
    train_dir = os.path.join(config["data"]["processed_dir"], "train")
    img_size = config["data"]["image_size"]

    ds = get_dataset(
        train_dir,
        image_size=img_size,
        batch_size=1,
        shuffle=True,
        augment=False,
    )

    for images, _ in ds.take(200):
        yield [images]


def _load_keras2_h5_weights(model: keras.Model, h5_path: str) -> None:
    """
    Load Keras 2.x HDF5 weights-only file into a Keras 3 model by matching
    layer and weight names. Handles nested sub-models (e.g. EfficientNetB0).
    """

    def _set_layer_from_group(layer, group):
        """Set weights on a single (non-nested) layer from an h5 group."""
        w_map = {
            k.rsplit(":", 1)[0]: np.asarray(group[k])
            for k in group.keys()
            if isinstance(group[k], h5py.Dataset)
        }
        if not w_map:
            return
        ordered = []
        for w in layer.weights:
            if w.name in w_map:
                ordered.append(w_map[w.name])
        if len(ordered) == len(layer.weights):
            layer.set_weights(ordered)
        elif ordered:
            logger.warning(
                f"Partial weight match for layer '{layer.name}': "
                f"{len(ordered)}/{len(layer.weights)} weights set."
            )

    with h5py.File(h5_path, "r") as f:
        for group_name in f.keys():
            if group_name == "top_level_model_weights":
                continue
            group = f[group_name]
            if not isinstance(group, h5py.Group):
                continue

            try:
                layer = model.get_layer(group_name)
            except ValueError:
                continue

            if hasattr(layer, "layers"):
                # Nested model (e.g. EfficientNetB0) — recurse one level
                for sub_name in group.keys():
                    sub_item = group[sub_name]
                    if not isinstance(sub_item, h5py.Group):
                        continue
                    try:
                        sub_layer = layer.get_layer(sub_name)
                    except ValueError:
                        continue
                    _set_layer_from_group(sub_layer, sub_item)
            else:
                # Regular layer — weights sit in a sub-group named after the layer
                if group_name in group:
                    _set_layer_from_group(layer, group[group_name])

    logger.info("Weights loaded from Keras 2.x HDF5 file.")


def _load_model(config: dict, model_path: str) -> keras.Model:
    """
    Load a model from model_path.

    Tries full-model loading first (zip .keras format).
    Falls back to architecture rebuild + Keras-2 HDF5 weight loading.
    """
    # Full model save (Keras 3 zip format)?
    is_zip = False
    try:
        with zipfile.ZipFile(model_path):
            is_zip = True
    except Exception:
        pass

    if is_zip:
        logger.info("Detected Keras 3 zip format — using load_model.")
        return keras.models.load_model(model_path)

    # Legacy HDF5 weights-only file
    logger.info("Detected legacy HDF5 weights file — rebuilding architecture.")
    model = build_model(config)
    _load_keras2_h5_weights(model, model_path)
    return model


def convert_to_tflite(
    config: dict,
    model_path: str | None = None,
    quantize: str = "float32",
) -> str:
    """
    Convert a saved Keras model to TFLite format.

    Args:
        config: Project config dict.
        model_path: Path to saved .keras / .h5 model. Auto-detected if None.
        quantize: One of 'float32', 'float16', 'int8'.

    Returns:
        Path to the saved .tflite file.
    """
    tflite_dir = config["output"]["tflite_dir"]
    os.makedirs(tflite_dir, exist_ok=True)

    # ── Locate model ─────────────────────────────────────────────────────
    if model_path is None:
        candidates = [
            os.path.join(config["output"]["models_dir"], "best_model_phase2.keras"),
            os.path.join(config["output"]["models_dir"], "final_model.keras"),
        ]
        for c in candidates:
            if os.path.exists(c):
                model_path = c
                break

    if not model_path or not os.path.exists(model_path):
        raise FileNotFoundError("No trained model found. Train the model first.")

    logger.info(f"Loading model: {model_path}")
    model = _load_model(config, model_path)

    # For non-int8 exports, add a class-aware saliency output used for bounding boxes.
    if quantize != "int8":
        from src.gradcam import build_localizer

        wrapped = build_localizer(model)
        if wrapped is not None:
            model = wrapped

    # ── Convert ──────────────────────────────────────────────────────────
    converter = tf.lite.TFLiteConverter.from_keras_model(model)

    if quantize == "float16":
        logger.info("Applying float16 quantisation ...")
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
        converter.target_spec.supported_types = [tf.float16]
        suffix = "_float16"

    elif quantize == "int8":
        logger.info("Applying int8 full-integer quantisation ...")
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
        converter.representative_dataset = lambda: _get_representative_dataset(config)
        converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
        converter.inference_input_type = tf.uint8
        converter.inference_output_type = tf.uint8
        suffix = "_int8"

    else:
        logger.info("Standard float32 conversion ...")
        suffix = "_float32"

    tflite_model = converter.convert()

    # ── Save ─────────────────────────────────────────────────────────────
    output_path = os.path.join(tflite_dir, f"waste_classifier{suffix}.tflite")
    with open(output_path, "wb") as f:
        f.write(tflite_model)

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    logger.info(f"✓ TFLite model saved: {output_path} ({size_mb:.2f} MB)")

    # ── Quick verification ───────────────────────────────────────────────
    interpreter = tf.lite.Interpreter(model_path=output_path)
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()
    logger.info(f"  Input shape  : {input_details[0]['shape']}")
    logger.info(f"  Input dtype  : {input_details[0]['dtype']}")
    logger.info(f"  Output shape : {output_details[0]['shape']}")
    logger.info(f"  Output dtype : {output_details[0]['dtype']}")

    return output_path


if __name__ == "__main__":
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(description="Convert model to TFLite")
    parser.add_argument(
        "--quantize",
        choices=["float32", "float16", "int8"],
        default="float32",
        help="Quantisation method (default: float32)",
    )
    parser.add_argument("--model", type=str, default=None, help="Model path")
    args = parser.parse_args()

    cfg = load_config()
    convert_to_tflite(cfg, model_path=args.model, quantize=args.quantize)
