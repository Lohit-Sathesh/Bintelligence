"""
train.py — Two-phase training pipeline for the waste classifier.

Phase 1: Feature extraction  — backbone frozen, train only the head
Phase 2: Fine-tuning          — unfreeze top backbone layers, low LR

Includes callbacks for early stopping, LR scheduling, model checkpointing,
and CSV logging.
"""

import os
import logging
import json
from datetime import datetime

import yaml
import tensorflow as tf
import keras

from src.model import build_model, unfreeze_for_finetuning
from src.dataset import get_all_datasets, compute_class_weights

logger = logging.getLogger(__name__)


def load_config(config_path: str = "config/config.yaml") -> dict:
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


class FixTensorLogs(keras.callbacks.Callback):
    def _convert(self, logs):
        if not logs:
            return

        import numpy as np

        for k, v in logs.items():
            # Tensor → float
            if isinstance(v, tf.Tensor):
                logs[k] = float(v.numpy())

            # Numpy → float
            elif isinstance(v, np.ndarray):
                logs[k] = float(v.item()) if v.size == 1 else v.tolist()

            # List of tensors → list of floats
            elif isinstance(v, list):
                new_list = []
                for item in v:
                    if isinstance(item, tf.Tensor):
                        new_list.append(float(item.numpy()))
                    else:
                        new_list.append(item)
                logs[k] = new_list

    def on_epoch_end(self, epoch, logs=None):
        self._convert(logs)

    def on_train_batch_end(self, batch, logs=None):
        self._convert(logs)

    def on_test_batch_end(self, batch, logs=None):
        self._convert(logs)


def _build_callbacks(
    config: dict,
    phase: str,
) -> list[keras.callbacks.Callback]:
    """Build training callbacks for a given phase."""
    models_dir = config["output"]["models_dir"]
    logs_dir = config["output"]["logs_dir"]
    os.makedirs(models_dir, exist_ok=True)
    os.makedirs(logs_dir, exist_ok=True)

    checkpoint_path = os.path.join(models_dir, f"best_model_{phase}.keras")
    csv_path = os.path.join(logs_dir, f"training_log_{phase}.csv")

    callbacks = [
        FixTensorLogs(),
        keras.callbacks.ModelCheckpoint(
            filepath=checkpoint_path,
            monitor="val_loss",
            mode="min",
            save_best_only=True,
            save_weights_only=False,
            verbose=1,
        ),
        keras.callbacks.EarlyStopping(
            monitor="val_loss",
            mode="min",
            patience=config["training"]["early_stopping_patience"],
            restore_best_weights=True,
            verbose=1,
        ),
        keras.callbacks.ReduceLROnPlateau(
            monitor="val_loss",
            factor=config["training"]["reduce_lr_factor"],
            patience=config["training"]["reduce_lr_patience"],
            min_lr=1e-7,
            verbose=1,
        ),
        keras.callbacks.CSVLogger(csv_path, append=False),
    ]

    # TensorBoard (optional — skip if not installed)
    try:
        import tensorboard  # noqa: F401

        tb_dir = os.path.join(logs_dir, "tensorboard", phase)
        callbacks.append(keras.callbacks.TensorBoard(log_dir=tb_dir, histogram_freq=0))
    except ImportError:
        logger.debug("TensorBoard not installed — skipping TB callback.")

    return callbacks


def train(config: dict) -> keras.Model:
    """
    Run the full two-phase training pipeline.

    Returns:
        The trained Keras model.
    """
    # ── GPU check ────────────────────────────────────────────────────────
    gpus = tf.config.list_physical_devices("GPU")
    if gpus:
        logger.info(f"✓ GPU detected: {[g.name for g in gpus]}")
        for gpu in gpus:
            tf.config.experimental.set_memory_growth(gpu, True)
        # Disable XLA JIT to avoid cuDNN autotuner compilation issues
        tf.config.optimizer.set_jit(False)
    else:
        logger.warning("No GPU found — training will be slow on CPU.")

    # ── Data ─────────────────────────────────────────────────────────────
    train_ds, val_ds, test_ds = get_all_datasets(config)
    class_weights = compute_class_weights(config)

    # ── Model ────────────────────────────────────────────────────────────
    model = build_model(config)

    # ══════════════════════════════════════════════════════════════════════
    # Phase 1 — Feature extraction (frozen backbone)
    # ══════════════════════════════════════════════════════════════════════
    logger.info("\n" + "=" * 70)
    logger.info("PHASE 1 — Feature Extraction (backbone frozen)")
    logger.info("=" * 70)

    phase1_epochs = config["training"]["phase1_epochs"]
    callbacks_p1 = _build_callbacks(config, "phase1")

    history_p1 = model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=phase1_epochs,
        callbacks=callbacks_p1,
        class_weight=class_weights,
        verbose=1,
    )

    p1_val_acc = max(history_p1.history["val_accuracy"])
    logger.info(f"Phase 1 best val accuracy: {p1_val_acc:.4f}")

    # ══════════════════════════════════════════════════════════════════════
    # Phase 2 — Fine-tuning (unfreeze top layers)
    # ══════════════════════════════════════════════════════════════════════
    logger.info("\n" + "=" * 70)
    logger.info("PHASE 2 — Fine-tuning (top backbone layers unfrozen)")
    logger.info("=" * 70)

    model = unfreeze_for_finetuning(model, config)
    phase2_epochs = config["training"]["phase2_epochs"]
    callbacks_p2 = _build_callbacks(config, "phase2")

    history_p2 = model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=phase2_epochs,
        callbacks=callbacks_p2,
        class_weight=class_weights,
        verbose=1,
    )

    p2_val_acc = max(history_p2.history["val_accuracy"])
    logger.info(f"Phase 2 best val accuracy: {p2_val_acc:.4f}")

    # ── Save final model ─────────────────────────────────────────────────
    models_dir = config["output"]["models_dir"]
    final_path = os.path.join(models_dir, "final_model.keras")
    model.save(final_path)
    logger.info(f"Final model saved to: {final_path}")

    # ── Save combined history ────────────────────────────────────────────
    combined_history = {}
    for key in history_p1.history:
        combined_history[key] = history_p1.history[key] + history_p2.history[key]

    history_path = os.path.join(config["output"]["logs_dir"], "full_history.json")
    # Convert numpy values to Python floats for JSON serialization
    serializable = {k: [float(v) for v in vals] for k, vals in combined_history.items()}
    with open(history_path, "w") as f:
        json.dump(serializable, f, indent=2)
    logger.info(f"Training history saved to: {history_path}")

    # ── Quick test evaluation ────────────────────────────────────────────
    logger.info("\n" + "=" * 70)
    logger.info("Quick Test Evaluation")
    logger.info("=" * 70)
    test_results = model.evaluate(test_ds, verbose=1, return_dict=True)
    for metric, value in test_results.items():
        logger.info(f"  Test {metric}: {value:.4f}")

    return model


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%H:%M:%S",
    )
    cfg = load_config()
    train(cfg)
