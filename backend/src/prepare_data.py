"""
prepare_data.py — Clean, map, deduplicate, and split images into wet/dry.

Pipeline:
  1. Discover raw images from both downloaded datasets
  2. Validate images (remove corrupt / too-small)
  3. Map fine-grained categories → wet or dry
  4. Remove duplicate images (MD5 hash)
  5. Stratified split → train / val / test
  6. Copy into data/processed/{train,val,test}/{wet,dry}/
"""

import os
import sys
import hashlib
import shutil
import logging
from pathlib import Path
from collections import defaultdict

import yaml
import numpy as np
from PIL import Image
from sklearn.model_selection import train_test_split
from tqdm import tqdm

logger = logging.getLogger(__name__)


def load_config(config_path: str = "config/config.yaml") -> dict:
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Discover raw images
# ─────────────────────────────────────────────────────────────────────────────


def _find_class_dirs(root: str) -> dict[str, str]:
    """
    Recursively find leaf directories that contain images and return
    a mapping of {class_name: directory_path}.
    """
    class_dirs = {}
    for dirpath, dirnames, filenames in os.walk(root):
        # Leaf-ish directory: has image files
        image_files = [
            f
            for f in filenames
            if Path(f).suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
        ]
        if image_files and not dirnames:
            # Use the directory name as the class name
            class_name = os.path.basename(dirpath)
            class_dirs[class_name] = dirpath
        elif image_files and dirnames:
            # Mixed directory — still treat as class
            class_name = os.path.basename(dirpath)
            class_dirs[class_name] = dirpath
    return class_dirs


def discover_images(config: dict) -> list[tuple[str, str]]:
    """
    Walk through all raw datasets and return a list of
    (image_path, wet_or_dry_label) tuples.
    """
    raw_dir = config["data"]["raw_dir"]
    valid_ext = set(config["data"]["valid_extensions"])
    all_images = []

    for ds_name, ds_cfg in config["datasets"].items():
        ds_dir = os.path.join(raw_dir, ds_name)
        if not os.path.isdir(ds_dir):
            logger.warning(f"Dataset directory not found: {ds_dir} — skipping")
            continue

        mapping = ds_cfg["mapping"]  # e.g. {"O": "wet", "R": "dry"}
        class_dirs = _find_class_dirs(ds_dir)

        logger.info(f"[{ds_name}] Found class directories: {list(class_dirs.keys())}")

        matched = 0
        for class_name, class_path in class_dirs.items():
            # Try exact match first, then case-insensitive
            label = mapping.get(class_name)
            if label is None:
                label = mapping.get(class_name.lower())
            if label is None:
                # Try matching by stripping common prefixes/suffixes
                for map_key, map_val in mapping.items():
                    if map_key.lower() in class_name.lower():
                        label = map_val
                        break

            if label is None:
                logger.warning(
                    f"  [{ds_name}] Class '{class_name}' has no mapping — skipping"
                )
                continue

            for fname in os.listdir(class_path):
                if Path(fname).suffix.lower() in valid_ext:
                    fpath = os.path.join(class_path, fname)
                    all_images.append((fpath, label))
                    matched += 1

        logger.info(f"[{ds_name}] Mapped {matched} images")

    logger.info(f"Total discovered images: {len(all_images)}")
    return all_images


# ─────────────────────────────────────────────────────────────────────────────
# 2. Validate images
# ─────────────────────────────────────────────────────────────────────────────


def validate_images(
    images: list[tuple[str, str]],
    min_size: int = 10,
) -> list[tuple[str, str]]:
    """Remove corrupt or too-small images."""
    valid = []
    removed = 0
    for path, label in tqdm(images, desc="Validating images", unit="img"):
        try:
            with Image.open(path) as img:
                img.load()
            # Re-open after verify (verify closes internal state)
            with Image.open(path) as img:
                w, h = img.size
                if w >= min_size and h >= min_size:
                    valid.append((path, label))
                else:
                    removed += 1
        except Exception:
            removed += 1

    logger.info(f"Validation: {len(valid)} valid, {removed} removed")
    return valid


# ─────────────────────────────────────────────────────────────────────────────
# 3. Deduplicate
# ─────────────────────────────────────────────────────────────────────────────


def _file_hash(path: str) -> str:
    """Compute MD5 hash of a file."""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def deduplicate(images: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Remove duplicate images based on MD5 hash."""
    seen: set[str] = set()
    unique = []
    duplicates = 0
    for path, label in tqdm(images, desc="Deduplicating", unit="img"):
        h = _file_hash(path)
        if h not in seen:
            seen.add(h)
            unique.append((path, label))
        else:
            duplicates += 1

    logger.info(f"Deduplication: {len(unique)} unique, {duplicates} duplicates removed")
    return unique


# ─────────────────────────────────────────────────────────────────────────────
# 4. Split & copy
# ─────────────────────────────────────────────────────────────────────────────


def split_and_copy(
    images: list[tuple[str, str]],
    config: dict,
) -> dict[str, int]:
    """
    Stratified split into train/val/test and copy files.

    Returns:
        Dict with counts per split and class.
    """
    processed_dir = config["data"]["processed_dir"]
    ratios = config["data"]["split_ratios"]
    seed = config["data"]["random_seed"]

    paths = [p for p, _ in images]
    labels = [l for _, l in images]

    # First split: train vs (val+test)
    val_test_ratio = ratios["val"] + ratios["test"]
    train_paths, temp_paths, train_labels, temp_labels = train_test_split(
        paths,
        labels,
        test_size=val_test_ratio,
        stratify=labels,
        random_state=seed,
    )

    # Second split: val vs test (from the remaining)
    val_fraction = ratios["val"] / val_test_ratio
    val_paths, test_paths, val_labels, test_labels = train_test_split(
        temp_paths,
        temp_labels,
        test_size=(1 - val_fraction),
        stratify=temp_labels,
        random_state=seed,
    )

    splits = {
        "train": list(zip(train_paths, train_labels)),
        "val": list(zip(val_paths, val_labels)),
        "test": list(zip(test_paths, test_labels)),
    }

    # Clean processed directory
    if os.path.exists(processed_dir):
        shutil.rmtree(processed_dir)

    stats: dict[str, int] = {}
    for split_name, split_data in splits.items():
        for label in ["wet", "dry"]:
            dest = os.path.join(processed_dir, split_name, label)
            os.makedirs(dest, exist_ok=True)

        for i, (src_path, label) in enumerate(
            tqdm(split_data, desc=f"Copying {split_name}", unit="img")
        ):
            ext = Path(src_path).suffix
            dst_name = f"{split_name}_{label}_{i:06d}{ext}"
            dst_path = os.path.join(processed_dir, split_name, label, dst_name)
            shutil.copy2(src_path, dst_path)

        # Counts
        for label in ["wet", "dry"]:
            key = f"{split_name}/{label}"
            count = len(os.listdir(os.path.join(processed_dir, split_name, label)))
            stats[key] = count

    return stats


# ─────────────────────────────────────────────────────────────────────────────
# Main pipeline
# ─────────────────────────────────────────────────────────────────────────────


def prepare_data(config: dict) -> dict[str, int]:
    """Run the full preparation pipeline."""
    min_size = config["data"].get("min_image_size", 10)

    logger.info("=" * 60)
    logger.info("Step 1/4 — Discovering images ...")
    logger.info("=" * 60)
    images = discover_images(config)
    if not images:
        logger.error("No images found! Check that datasets are downloaded.")
        sys.exit(1)

    # Class distribution
    counts = defaultdict(int)
    for _, label in images:
        counts[label] += 1
    logger.info(f"Class distribution: {dict(counts)}")

    logger.info("\n" + "=" * 60)
    logger.info("Step 2/4 — Validating images ...")
    logger.info("=" * 60)
    images = validate_images(images, min_size=min_size)

    logger.info("\n" + "=" * 60)
    logger.info("Step 3/4 — Deduplicating ...")
    logger.info("=" * 60)
    images = deduplicate(images)

    # Updated distribution
    counts = defaultdict(int)
    for _, label in images:
        counts[label] += 1
    logger.info(f"After cleaning — Class distribution: {dict(counts)}")

    logger.info("\n" + "=" * 60)
    logger.info("Step 4/4 — Splitting & copying ...")
    logger.info("=" * 60)
    stats = split_and_copy(images, config)

    logger.info("\n" + "=" * 60)
    logger.info("Preparation Complete!")
    logger.info("=" * 60)
    for key, count in sorted(stats.items()):
        logger.info(f"  {key}: {count} images")
    logger.info("=" * 60)

    return stats


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%H:%M:%S",
    )
    cfg = load_config()
    prepare_data(cfg)
