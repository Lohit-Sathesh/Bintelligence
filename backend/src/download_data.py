"""
download_data.py — Download waste classification datasets from Kaggle.

Uses the Kaggle API with legacy token (~/.kaggle/kaggle.json).
Downloads two complementary datasets and extracts them to data/raw/.
"""

import os
import sys
import logging
import yaml

logger = logging.getLogger(__name__)


def load_config(config_path: str = "config/config.yaml") -> dict:
    """Load project configuration from YAML file."""
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def download_datasets(config: dict) -> None:
    """
    Download all configured Kaggle datasets.

    Args:
        config: Project configuration dict.
    """
    try:
        from kaggle.api.kaggle_api_extended import KaggleApi
    except ImportError:
        logger.error(
            "Kaggle package not installed. Run: pip install kaggle\n"
            "Also ensure kaggle.json is at: C:\\Users\\<you>\\.kaggle\\kaggle.json"
        )
        sys.exit(1)

    api = KaggleApi()
    try:
        api.authenticate()
    except Exception as e:
        logger.error(
            f"Kaggle authentication failed: {e}\n"
            "Make sure kaggle.json exists at ~/.kaggle/kaggle.json"
        )
        sys.exit(1)

    raw_dir = config["data"]["raw_dir"]
    os.makedirs(raw_dir, exist_ok=True)

    datasets = config["datasets"]
    for name, ds_cfg in datasets.items():
        slug = ds_cfg["slug"]
        dest = os.path.join(raw_dir, name)

        if os.path.exists(dest) and os.listdir(dest):
            logger.info(f"[{name}] Already downloaded at {dest} — skipping.")
            continue

        os.makedirs(dest, exist_ok=True)
        logger.info(f"[{name}] Downloading {slug} ...")
        try:
            api.dataset_download_files(slug, path=dest, unzip=True)
            logger.info(f"[{name}] ✓ Downloaded and extracted to {dest}")
        except Exception as e:
            logger.error(f"[{name}] ✗ Download failed: {e}")
            raise

    # Print summary
    logger.info("\n" + "=" * 60)
    logger.info("Download Summary")
    logger.info("=" * 60)
    for name, ds_cfg in datasets.items():
        dest = os.path.join(raw_dir, name)
        count = sum(len(files) for _, _, files in os.walk(dest))
        logger.info(f"  {name}: {count} files in {dest}")
    logger.info("=" * 60)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%H:%M:%S",
    )
    cfg = load_config()
    download_datasets(cfg)
