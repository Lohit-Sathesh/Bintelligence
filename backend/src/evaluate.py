"""
evaluate.py — Evaluate the trained model and generate visualisations.

Produces:
  - Classification report (precision / recall / F1)
  - Confusion matrix heatmap
  - ROC-AUC curve
  - Training history plots (loss & accuracy)
"""

import os
import json
import logging

import numpy as np
import yaml
import tensorflow as tf
from tensorflow import keras
import matplotlib

matplotlib.use("Agg")  # non-interactive backend
import matplotlib.pyplot as plt
import seaborn as sns
from sklearn.metrics import (
    classification_report,
    confusion_matrix,
    roc_curve,
    auc,
)

from src.dataset import get_dataset, CLASS_NAMES

logger = logging.getLogger(__name__)


def load_config(config_path: str = "config/config.yaml") -> dict:
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


# ─────────────────────────────────────────────────────────────────────────────
# Plotting helpers
# ─────────────────────────────────────────────────────────────────────────────

def _save_fig(fig, path: str) -> None:
    fig.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    logger.info(f"  Saved: {path}")


def plot_training_history(history: dict, output_dir: str) -> None:
    """Plot loss and accuracy curves from training history."""
    epochs = range(1, len(history["loss"]) + 1)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

    # Loss
    ax1.plot(epochs, history["loss"], "b-", label="Train Loss", linewidth=2)
    ax1.plot(epochs, history["val_loss"], "r-", label="Val Loss", linewidth=2)
    ax1.set_title("Training & Validation Loss", fontsize=14, fontweight="bold")
    ax1.set_xlabel("Epoch")
    ax1.set_ylabel("Loss")
    ax1.legend()
    ax1.grid(True, alpha=0.3)

    # Accuracy
    ax2.plot(epochs, history["accuracy"], "b-", label="Train Accuracy", linewidth=2)
    ax2.plot(
        epochs, history["val_accuracy"], "r-", label="Val Accuracy", linewidth=2
    )
    ax2.set_title("Training & Validation Accuracy", fontsize=14, fontweight="bold")
    ax2.set_xlabel("Epoch")
    ax2.set_ylabel("Accuracy")
    ax2.legend()
    ax2.grid(True, alpha=0.3)

    fig.suptitle("Training History", fontsize=16, fontweight="bold", y=1.02)
    fig.tight_layout()
    _save_fig(fig, os.path.join(output_dir, "training_history.png"))


def plot_confusion_matrix(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    output_dir: str,
) -> None:
    """Plot a pretty confusion matrix heatmap."""
    cm = confusion_matrix(y_true, y_pred)
    fig, ax = plt.subplots(figsize=(8, 6))

    sns.heatmap(
        cm,
        annot=True,
        fmt="d",
        cmap="Blues",
        xticklabels=CLASS_NAMES,
        yticklabels=CLASS_NAMES,
        ax=ax,
        annot_kws={"size": 16},
        linewidths=1,
        linecolor="white",
    )
    ax.set_xlabel("Predicted", fontsize=13)
    ax.set_ylabel("Actual", fontsize=13)
    ax.set_title("Confusion Matrix", fontsize=15, fontweight="bold")
    fig.tight_layout()
    _save_fig(fig, os.path.join(output_dir, "confusion_matrix.png"))


def plot_roc_curve(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    output_dir: str,
) -> float:
    """Plot ROC curve and return AUC score."""
    fpr, tpr, _ = roc_curve(y_true, y_prob)
    roc_auc = auc(fpr, tpr)

    fig, ax = plt.subplots(figsize=(7, 6))
    ax.plot(fpr, tpr, "b-", linewidth=2.5, label=f"AUC = {roc_auc:.4f}")
    ax.plot([0, 1], [0, 1], "k--", alpha=0.5, linewidth=1)
    ax.fill_between(fpr, tpr, alpha=0.1, color="blue")
    ax.set_xlabel("False Positive Rate", fontsize=13)
    ax.set_ylabel("True Positive Rate", fontsize=13)
    ax.set_title("ROC Curve", fontsize=15, fontweight="bold")
    ax.legend(fontsize=13, loc="lower right")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    _save_fig(fig, os.path.join(output_dir, "roc_curve.png"))

    return roc_auc


# ─────────────────────────────────────────────────────────────────────────────
# Main evaluation
# ─────────────────────────────────────────────────────────────────────────────

def evaluate(config: dict, model_path: str | None = None) -> dict:
    """
    Run full evaluation on the test set.

    Args:
        config: Project configuration.
        model_path: Path to saved model. If None, uses the best phase2 checkpoint.

    Returns:
        Dict with evaluation metrics.
    """
    plots_dir = config["output"]["plots_dir"]
    logs_dir = config["output"]["logs_dir"]
    os.makedirs(plots_dir, exist_ok=True)

    # ── Load model ───────────────────────────────────────────────────────
    if model_path is None:
        # Try best phase2 model first, fallback to final
        candidates = [
            os.path.join(config["output"]["models_dir"], "best_model_phase2.keras"),
            os.path.join(config["output"]["models_dir"], "final_model.keras"),
        ]
        for c in candidates:
            if os.path.exists(c):
                model_path = c
                break

    if model_path is None or not os.path.exists(model_path):
        raise FileNotFoundError(
            f"No trained model found. Run training first.\n"
            f"Looked at: {candidates}"
        )

    logger.info(f"Loading model from: {model_path}")
    model = keras.models.load_model(model_path)

    # ── Load test dataset ────────────────────────────────────────────────
    test_dir = os.path.join(config["data"]["processed_dir"], "test")
    img_size = config["data"]["image_size"]
    batch_size = config["training"]["batch_size"]

    test_ds = get_dataset(
        test_dir,
        image_size=img_size,
        batch_size=batch_size,
        shuffle=False,
        augment=False,
    )

    # ── Predict ──────────────────────────────────────────────────────────
    logger.info("Running predictions on test set ...")
    y_prob = model.predict(test_ds, verbose=1).flatten()
    y_pred = (y_prob >= 0.5).astype(int)

    # Collect true labels
    y_true = np.concatenate([labels.numpy().flatten() for _, labels in test_ds])

    # ── Metrics ──────────────────────────────────────────────────────────
    logger.info("\n" + "=" * 60)
    logger.info("CLASSIFICATION REPORT")
    logger.info("=" * 60)
    report = classification_report(
        y_true, y_pred, target_names=CLASS_NAMES, digits=4
    )
    logger.info("\n" + report)

    # Overall accuracy
    accuracy = np.mean(y_true == y_pred)
    logger.info(f"Overall Test Accuracy: {accuracy:.4f} ({accuracy * 100:.2f}%)")

    # ── Plots ────────────────────────────────────────────────────────────
    logger.info("\nGenerating evaluation plots ...")

    # Confusion matrix
    plot_confusion_matrix(y_true, y_pred, plots_dir)

    # ROC curve
    roc_auc = plot_roc_curve(y_true, y_prob, plots_dir)
    logger.info(f"ROC-AUC: {roc_auc:.4f}")

    # Training history (if available)
    history_path = os.path.join(logs_dir, "full_history.json")
    if os.path.exists(history_path):
        with open(history_path) as f:
            history = json.load(f)
        plot_training_history(history, plots_dir)

    # ── Save results ─────────────────────────────────────────────────────
    results = {
        "accuracy": float(accuracy),
        "roc_auc": float(roc_auc),
        "report": report,
        "model_path": model_path,
    }

    results_path = os.path.join(plots_dir, "evaluation_results.json")
    with open(results_path, "w") as f:
        json.dump(
            {k: v for k, v in results.items() if k != "report"},
            f,
            indent=2,
        )
    logger.info(f"Results saved to: {results_path}")

    # Save text report
    report_path = os.path.join(plots_dir, "classification_report.txt")
    with open(report_path, "w") as f:
        f.write(f"Model: {model_path}\n")
        f.write(f"Accuracy: {accuracy:.4f}\n")
        f.write(f"ROC-AUC: {roc_auc:.4f}\n\n")
        f.write(report)
    logger.info(f"Text report saved to: {report_path}")

    return results


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%H:%M:%S",
    )
    cfg = load_config()
    evaluate(cfg)
