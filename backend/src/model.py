"""
model.py — EfficientNetB0 transfer-learning model for wet/dry classification.

Architecture:
  EfficientNetB0 (ImageNet) → GlobalAvgPool → Dropout → Dense(256) → Dropout → Dense(1, sigmoid)

Two-phase training:
  Phase 1 — Freeze backbone, train head
  Phase 2 — Unfreeze last N layers, fine-tune at low LR
"""

import logging

import tensorflow as tf
import keras
from keras import layers

logger = logging.getLogger(__name__)


def build_model(config: dict) -> keras.Model:
    """
    Build the EfficientNetB0-based binary classifier.

    Args:
        config: Project configuration dict.

    Returns:
        Compiled Keras model.
    """
    input_shape = tuple(config["model"]["input_shape"])
    dropout_rate = config["model"]["dropout_rate"]
    dense_units = config["model"]["dense_units"]
    freeze_base = config["model"].get("freeze_base", True)
    l2 = config["model"].get("l2", 0.0)
    label_smoothing = config["model"].get("label_smoothing", 0.0)

    # ── Base model ──────────────────────────────────────────────────────
    base_model = keras.applications.EfficientNetB0(
        include_top=False,
        weights="imagenet",
        input_shape=input_shape,
        pooling="avg",
    )
    base_model.trainable = not freeze_base

    logger.info(
        f"EfficientNetB0 loaded | "
        f"Total layers: {len(base_model.layers)} | "
        f"Trainable: {base_model.trainable}"
    )

    # ── Classification head ──────────────────────────────────────────────
    inputs = keras.Input(shape=input_shape, name="input_image")
    x = base_model(inputs, training=False)
    x = layers.Dropout(dropout_rate, name="head_dropout_1")(x)
    x = layers.Dense(
        dense_units,
        activation="relu",
        kernel_regularizer=keras.regularizers.l2(l2),
        name="head_dense",
    )(x)
    x = layers.Dropout(dropout_rate * 0.67, name="head_dropout_2")(x)
    outputs = layers.Dense(1, activation="sigmoid", name="output")(x)

    model = keras.Model(inputs, outputs, name="WetDryClassifier")

    # ── Compile ──────────────────────────────────────────────────────────
    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=config["training"]["phase1_lr"]),
        loss=keras.losses.BinaryCrossentropy(label_smoothing=label_smoothing),
        metrics=[
            "accuracy",
            keras.metrics.Precision(name="precision"),
            keras.metrics.Recall(name="recall"),
            keras.metrics.AUC(name="auc"),
        ],
        jit_compile=False,
    )

    model.summary(print_fn=logger.info, line_length=100)
    return model


def unfreeze_for_finetuning(
    model: keras.Model,
    config: dict,
) -> keras.Model:
    """
    Unfreeze the top layers of the backbone for fine-tuning.

    Args:
        model: The compiled model (with frozen backbone).
        config: Project configuration dict.

    Returns:
        Re-compiled model with unfrozen top backbone layers.
    """
    fine_tune_at = config["training"]["fine_tune_at_layer"]
    fine_tune_lr = config["training"]["phase2_lr"]
    freeze_bn = config["model"].get("freeze_batchnorm", True)
    label_smoothing = config["model"].get("label_smoothing", 0.0)

    # The base model is the second layer (index 1) in our functional model
    base_model = model.layers[1]
    base_model.trainable = True

    for i, layer in enumerate(base_model.layers):
        is_bn = isinstance(layer, keras.layers.BatchNormalization)
        layer.trainable = i >= fine_tune_at and not (freeze_bn and is_bn)

    trainable_count = sum(1 for layer in base_model.layers if layer.trainable)
    frozen_count = len(base_model.layers) - trainable_count

    logger.info(
        f"Fine-tune mode: {trainable_count} trainable, "
        f"{frozen_count} frozen (unfreeze from layer {fine_tune_at})"
    )

    # Re-compile with lower learning rate
    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=fine_tune_lr),
        loss=keras.losses.BinaryCrossentropy(label_smoothing=label_smoothing),
        metrics=[
            "accuracy",
            keras.metrics.Precision(name="precision"),
            keras.metrics.Recall(name="recall"),
            keras.metrics.AUC(name="auc"),
        ],
        jit_compile=False,
    )

    return model


if __name__ == "__main__":
    import yaml

    logging.basicConfig(level=logging.INFO)
    with open("config/config.yaml") as f:
        cfg = yaml.safe_load(f)

    model = build_model(cfg)
    print(f"\nTotal parameters     : {model.count_params():,}")
    print(
        f"Trainable parameters : {sum(tf.keras.backend.count_params(w) for w in model.trainable_weights):,}"
    )
