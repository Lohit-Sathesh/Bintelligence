"""
dashboard.py — FastAPI router for the Developer Dashboard.

Provides endpoints for:
  - Dataset exploration (folder listing, image pagination, filtering)
  - Model info (config, evaluation results, training history, classification report)
  - Serving raw images and evaluation plots
"""

import json
import os
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
import yaml
from sklearn.model_selection import train_test_split

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(PROJECT_ROOT)

router = APIRouter()

CONFIG_PATH = os.path.join(PROJECT_ROOT, "config", "config.yaml")


def _load_config() -> dict:
    with open(CONFIG_PATH, "r") as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Dataset Cache
# ---------------------------------------------------------------------------
_cached_dataset: list | None = None
_cached_stats: dict | None = None
_cached_datasets_list: list = []

VALID_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def _find_class_dirs(root: str) -> dict:
    """Walk *root* and return {class_name: absolute_path} for every leaf
    directory that contains at least one image file."""
    class_dirs = {}
    for dirpath, _, filenames in os.walk(root):
        has_images = any(
            Path(f).suffix.lower() in VALID_IMAGE_EXTS for f in filenames
        )
        if has_images:
            class_dirs[os.path.basename(dirpath)] = dirpath
    return class_dirs


def _resolve_label(class_name: str, mapping: dict) -> str | None:
    """Try to match *class_name* against *mapping* keys (case-insensitive,
    substring fallback)."""
    label = mapping.get(class_name) or mapping.get(class_name.lower())
    if label:
        return label
    for key, val in mapping.items():
        if key.lower() in class_name.lower():
            return val
    return None


def build_dataset_cache() -> None:
    """Scan ``data/raw`` and build a flat list of every image with metadata."""
    global _cached_dataset, _cached_stats, _cached_datasets_list

    config = _load_config()
    raw_dir = os.path.join(PROJECT_ROOT, config["data"]["raw_dir"])
    valid_ext = set(config["data"]["valid_extensions"])

    all_images: list[dict] = []

    if not os.path.isdir(raw_dir):
        _cached_dataset = []
        _cached_stats = {"total": 0, "message": "Raw data directory not found"}
        _cached_datasets_list = []
        return

    # 1. Discover images --------------------------------------------------
    for ds_name, ds_cfg in config["datasets"].items():
        ds_dir = os.path.join(raw_dir, ds_name)
        if not os.path.isdir(ds_dir):
            continue

        mapping = ds_cfg["mapping"]
        for class_name, class_path in _find_class_dirs(ds_dir).items():
            label = _resolve_label(class_name, mapping)
            if not label:
                continue
            for fname in os.listdir(class_path):
                if Path(fname).suffix.lower() in valid_ext:
                    rel_path = os.path.relpath(
                        os.path.join(class_path, fname), raw_dir
                    )
                    all_images.append(
                        {
                            "id": None,
                            "path": rel_path,
                            "dataset": ds_name,
                            "original_class": class_name,
                            "target_class": label,
                            "split": None,
                        }
                    )

    if not all_images:
        _cached_dataset = []
        _cached_stats = {
            "total": 0,
            "message": "No images found in raw data directory",
        }
        _cached_datasets_list = []
        return

    # 2. Re-apply split logic --------------------------------------------
    ratios = config["data"]["split_ratios"]
    seed = config["data"]["random_seed"]
    paths = [img["path"] for img in all_images]
    labels = [img["target_class"] for img in all_images]

    try:
        val_test = ratios["val"] + ratios["test"]
        train_p, temp_p, _, temp_l = train_test_split(
            paths, labels, test_size=val_test, stratify=labels, random_state=seed
        )
        val_frac = ratios["val"] / val_test
        val_p, test_p, _, _ = train_test_split(
            temp_p, temp_l, test_size=(1 - val_frac), stratify=temp_l, random_state=seed
        )
        splits = {}
        for p in train_p:
            splits[p] = "train"
        for p in val_p:
            splits[p] = "val"
        for p in test_p:
            splits[p] = "test"
    except Exception:
        splits = {}

    # 3. Sort & assign ids ------------------------------------------------
    all_images.sort(
        key=lambda x: (x["dataset"], x["target_class"], x["original_class"], x["path"])
    )

    wet_count = dry_count = 0
    dataset_stats: dict[str, dict] = {}

    for i, img in enumerate(all_images):
        img["id"] = i + 1
        img["split"] = splits.get(img["path"], "unknown")
        if img["target_class"] == "wet":
            wet_count += 1
        else:
            dry_count += 1

        ds = img["dataset"]
        if ds not in dataset_stats:
            dataset_stats[ds] = {"name": ds, "total": 0, "wet": 0, "dry": 0, "categories": set()}
        dataset_stats[ds]["total"] += 1
        dataset_stats[ds]["categories"].add(img["original_class"])
        if img["target_class"] == "wet":
            dataset_stats[ds]["wet"] += 1
        else:
            dataset_stats[ds]["dry"] += 1

    # Convert sets → sorted lists for JSON serialisation
    for ds in dataset_stats.values():
        ds["categories"] = sorted(ds["categories"])

    _cached_dataset = all_images
    _cached_stats = {
        "total": len(all_images),
        "wet_count": wet_count,
        "dry_count": dry_count,
        "message": "Success",
    }
    _cached_datasets_list = list(dataset_stats.values())


def _ensure_cache():
    if _cached_dataset is None:
        build_dataset_cache()


# ---------------------------------------------------------------------------
# Routes — Dataset Explorer
# ---------------------------------------------------------------------------
@router.get("/dataset")
async def get_dataset_info():
    """High-level stats for the entire raw dataset."""
    _ensure_cache()
    return _cached_stats


@router.get("/datasets_list")
async def get_datasets_list():
    """List of datasets with per-dataset stats and original category names."""
    _ensure_cache()
    return _cached_datasets_list


@router.get("/images")
async def get_images(
    dataset: Optional[str] = None,
    target_class: Optional[str] = None,
    original_class: Optional[str] = None,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
):
    """Paginate images with optional filters."""
    _ensure_cache()
    filtered = _cached_dataset
    if dataset:
        filtered = [i for i in filtered if i["dataset"] == dataset]
    if target_class:
        filtered = [i for i in filtered if i["target_class"] == target_class]
    if original_class:
        filtered = [i for i in filtered if i["original_class"] == original_class]

    start = (page - 1) * limit
    return {
        "items": filtered[start : start + limit],
        "total": len(filtered),
        "page": page,
        "limit": limit,
        "pages": (len(filtered) + limit - 1) // limit if filtered else 0,
    }


# ---------------------------------------------------------------------------
# Routes — Model Insights
# ---------------------------------------------------------------------------
@router.get("/model_info")
async def get_model_info():
    """Return model config, evaluation metrics, classification report, and
    training history data."""
    config = _load_config()
    plots_dir = os.path.join(PROJECT_ROOT, config["output"]["plots_dir"])
    logs_dir = os.path.join(PROJECT_ROOT, config["output"]["logs_dir"])

    # Available plot images
    available_plots = []
    if os.path.isdir(plots_dir):
        available_plots = [
            f for f in os.listdir(plots_dir) if f.endswith((".png", ".jpg"))
        ]

    # Evaluation results JSON
    eval_results = {}
    results_path = os.path.join(plots_dir, "evaluation_results.json")
    if os.path.exists(results_path):
        try:
            with open(results_path) as f:
                eval_results = json.load(f)
        except Exception:
            pass

    # Classification report text
    report_text = ""
    report_path = os.path.join(plots_dir, "classification_report.txt")
    if os.path.exists(report_path):
        try:
            with open(report_path) as f:
                report_text = f.read()
        except Exception:
            pass

    # Training history JSON (for charts)
    history_data = {}
    history_path = os.path.join(logs_dir, "full_history.json")
    if os.path.exists(history_path):
        try:
            with open(history_path) as f:
                history_data = json.load(f)
        except Exception:
            pass

    return {
        "model": config["model"],
        "training": config["training"],
        "data_config": config["data"],
        "plots": available_plots,
        "evaluation": eval_results,
        "classification_report": report_text,
        "training_history": history_data,
    }


# ---------------------------------------------------------------------------
# Routes — File Serving
# ---------------------------------------------------------------------------
def _safe_resolve(base_dir: str, relative: str) -> str:
    """Resolve *relative* under *base_dir* and ensure it doesn't escape."""
    full = os.path.abspath(os.path.join(base_dir, relative))
    if not full.startswith(os.path.abspath(base_dir)):
        raise HTTPException(status_code=400, detail="Invalid path")
    if not os.path.isfile(full):
        raise HTTPException(status_code=404, detail="File not found")
    return full


@router.get("/serve_image")
async def serve_image(path: str = Query(..., description="Relative path in raw dataset")):
    config = _load_config()
    raw_dir = os.path.join(PROJECT_ROOT, config["data"]["raw_dir"])
    return FileResponse(_safe_resolve(raw_dir, path))


@router.get("/serve_plot")
async def serve_plot(filename: str):
    config = _load_config()
    plots_dir = os.path.join(PROJECT_ROOT, config["output"]["plots_dir"])
    return FileResponse(_safe_resolve(plots_dir, filename))
