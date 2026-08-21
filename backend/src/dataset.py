"""
dataset.py — TensorFlow data pipeline with augmentation.

Creates efficient tf.data.Dataset objects from the processed image directories
with proper augmentation, preprocessing, and prefetching.
"""

import os
import logging

import tensorflow as tf
import yaml

logger = logging.getLogger(__name__)

# Fixed class order so label encoding is consistent everywhere
CLASS_NAMES = ["dry", "wet"]


def load_config(config_path: str = "config/config.yaml") -> dict:
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


# ─────────────────────────────────────────────────────────────────────────────
# Augmentation layers (applied only to training data)
# ─────────────────────────────────────────────────────────────────────────────


def build_augmentation_layer() -> tf.keras.Sequential:
    """Create a Keras Sequential augmentation pipeline."""
    return tf.keras.Sequential(
        [
            tf.keras.layers.RandomFlip("horizontal"),
            tf.keras.layers.RandomRotation(0.15),
            tf.keras.layers.RandomTranslation(0.1, 0.1),
            tf.keras.layers.RandomZoom(0.15),
            tf.keras.layers.RandomContrast(0.2),
            tf.keras.layers.RandomBrightness(0.1),
        ],
        name="data_augmentation",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Dataset builders
# ─────────────────────────────────────────────────────────────────────────────


def get_dataset(
    directory: str,
    image_size: int = 224,
    batch_size: int = 32,
    shuffle: bool = True,
    augment: bool = False,
    seed: int = 42,
) -> tf.data.Dataset:
    """
    Build a tf.data.Dataset from an image directory.

    The directory must have sub-folders named 'dry/' and 'wet/'.

    Args:
        directory: Path to split directory (e.g. data/processed/train).
        image_size: Target image size (square).
        batch_size: Batch size.
        shuffle: Whether to shuffle.
        augment: Whether to apply augmentation.
        seed: Random seed.

    Returns:
        A batched, prefetched tf.data.Dataset yielding (images, labels).
        Labels are 0 = dry, 1 = wet.
    """
    ds = tf.keras.utils.image_dataset_from_directory(
        directory,
        labels="inferred",
        label_mode="binary",
        class_names=CLASS_NAMES,
        image_size=(image_size, image_size),
        batch_size=batch_size,
        shuffle=shuffle,
        seed=seed,
    )

    # EfficientNet preprocessing: rescale [0,255] → [-1, 1]
    preprocess = tf.keras.applications.efficientnet.preprocess_input

    if augment:
        aug_layer = build_augmentation_layer()
        ds = ds.map(
            lambda x, y: (preprocess(aug_layer(x, training=True)), y),
            num_parallel_calls=tf.data.AUTOTUNE,
        )
    else:
        ds = ds.map(
            lambda x, y: (preprocess(x), y),
            num_parallel_calls=tf.data.AUTOTUNE,
        )

    ds = ds.apply(tf.data.experimental.ignore_errors())
    ds = ds.prefetch(tf.data.AUTOTUNE)
    return ds


def get_all_datasets(
    config: dict,
) -> tuple[tf.data.Dataset, tf.data.Dataset, tf.data.Dataset]:
    """
    Create train, validation, and test datasets from config.

    Returns:
        (train_ds, val_ds, test_ds)
    """
    proc_dir = config["data"]["processed_dir"]
    img_size = config["data"]["image_size"]
    batch_size = config["training"]["batch_size"]
    seed = config["data"]["random_seed"]

    train_dir = os.path.join(proc_dir, "train")
    val_dir = os.path.join(proc_dir, "val")
    test_dir = os.path.join(proc_dir, "test")

    for d in [train_dir, val_dir, test_dir]:
        if not os.path.isdir(d):
            raise FileNotFoundError(
                f"Processed data directory not found: {d}\n"
                "Run data preparation first: python main.py --prepare"
            )

    train_ds = get_dataset(
        train_dir,
        image_size=img_size,
        batch_size=batch_size,
        shuffle=True,
        augment=True,
        seed=seed,
    )
    val_ds = get_dataset(
        val_dir,
        image_size=img_size,
        batch_size=batch_size,
        shuffle=False,
        augment=False,
        seed=seed,
    )
    test_ds = get_dataset(
        test_dir,
        image_size=img_size,
        batch_size=batch_size,
        shuffle=False,
        augment=False,
        seed=seed,
    )

    logger.info("Datasets created:")
    logger.info(f"  Train : {train_dir}")
    logger.info(f"  Val   : {val_dir}")
    logger.info(f"  Test  : {test_dir}")

    return train_ds, val_ds, test_ds


def compute_class_weights(config: dict) -> dict[int, float]:
    """
    Compute class weights to handle class imbalance.

    Returns:
        Dict mapping class index → weight.
    """
    train_dir = os.path.join(config["data"]["processed_dir"], "train")
    counts = {}
    for i, cls in enumerate(CLASS_NAMES):
        cls_dir = os.path.join(train_dir, cls)
        counts[i] = len(os.listdir(cls_dir)) if os.path.isdir(cls_dir) else 0

    total = sum(counts.values())
    n_classes = len(counts)
    weights = {
        i: total / (n_classes * count) if count > 0 else 1.0
        for i, count in counts.items()
    }

    logger.info(f"Class counts: { {CLASS_NAMES[i]: c for i, c in counts.items()} }")
    logger.info(
        f"Class weights: { {CLASS_NAMES[i]: f'{w:.3f}' for i, w in weights.items()} }"
    )
    return weights


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    cfg = load_config()
    train_ds, val_ds, test_ds = get_all_datasets(cfg)
    weights = compute_class_weights(cfg)

    # Quick sanity check
    for images, labels in train_ds.take(1):
        print(f"Batch shape : {images.shape}")
        print(f"Labels shape: {labels.shape}")
        print(f"Pixel range : [{images.numpy().min():.2f}, {images.numpy().max():.2f}]")
