"""
main.py — CLI entry point for the Wet/Dry Waste Classification pipeline.

Usage:
  python main.py --download --prepare --train --evaluate   # Full pipeline
  python main.py --train                                   # Train only
  python main.py --evaluate                                # Evaluate only
  python main.py --predict path/to/image.jpg               # Predict
  python main.py --convert-tflite --quantize float16       # Export TFLite
  python main.py --serve                                   # Launch Dashboard
  python main.py --evaluate-external garbage_classification_v2  # Test on external data
"""

import os

os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"
os.environ["ABSL_MIN_LOG_LEVEL"] = "2"

import argparse
import logging
import sys

import yaml


def load_config(config_path: str = "config/config.yaml") -> dict:
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def main():
    parser = argparse.ArgumentParser(
        description="Wet/Dry Waste Classification Pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py --download --prepare --train --evaluate
  python main.py --train --evaluate
  python main.py --predict samples/test_image.jpg
  python main.py --convert-tflite --quantize float16
        """,
    )

    parser.add_argument(
        "--download",
        action="store_true",
        help="Download datasets from Kaggle",
    )
    parser.add_argument(
        "--prepare",
        action="store_true",
        help="Clean, map, and split datasets into train/val/test",
    )
    parser.add_argument(
        "--train",
        action="store_true",
        help="Train the CNN model (two-phase training)",
    )
    parser.add_argument(
        "--evaluate",
        action="store_true",
        help="Evaluate the model on the test set",
    )
    parser.add_argument(
        "--predict",
        type=str,
        default=None,
        help="Run inference on an image or directory",
    )
    parser.add_argument(
        "--convert-tflite",
        action="store_true",
        help="Convert trained model to TensorFlow Lite",
    )
    parser.add_argument(
        "--quantize",
        type=str,
        default="float32",
        choices=["float32", "float16", "int8"],
        help="TFLite quantisation method (default: float32)",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Launch the Dashboard web server (FastAPI + webapp)",
    )
    parser.add_argument(
        "--evaluate-external",
        type=str,
        default=None,
        metavar="DATASET_KEY",
        help="Evaluate the model on an external raw dataset (key from config.yaml)",
    )
    parser.add_argument(
        "--config",
        type=str,
        default="config/config.yaml",
        help="Path to config file (default: config/config.yaml)",
    )

    args = parser.parse_args()

    # If no action specified, show help
    if not any(
        [
            args.download,
            args.prepare,
            args.train,
            args.evaluate,
            args.predict,
            args.convert_tflite,
            args.serve,
            args.evaluate_external,
        ]
    ):
        parser.print_help()
        sys.exit(0)

    # Setup logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%H:%M:%S",
    )
    logger = logging.getLogger(__name__)

    # Load config
    config = load_config(args.config)
    logger.info("Configuration loaded from: %s", args.config)

    # ── Download ─────────────────────────────────────────────────────────
    if args.download:
        logger.info("\n" + "█" * 60)
        logger.info("  STEP: Download Datasets")
        logger.info("█" * 60)
        from src.download_data import download_datasets

        download_datasets(config)

    # ── Prepare ──────────────────────────────────────────────────────────
    if args.prepare:
        logger.info("\n" + "█" * 60)
        logger.info("  STEP: Prepare Data")
        logger.info("█" * 60)
        from src.prepare_data import prepare_data

        prepare_data(config)

    # ── Train ────────────────────────────────────────────────────────────
    if args.train:
        logger.info("\n" + "█" * 60)
        logger.info("  STEP: Train Model")
        logger.info("█" * 60)
        from src.train import train

        train(config)

    # ── Evaluate ─────────────────────────────────────────────────────────
    if args.evaluate:
        logger.info("\n" + "█" * 60)
        logger.info("  STEP: Evaluate Model")
        logger.info("█" * 60)
        from src.evaluate import evaluate

        evaluate(config)

    # ── Predict ──────────────────────────────────────────────────────────
    if args.predict:
        logger.info("\n" + "█" * 60)
        logger.info("  STEP: Predict")
        logger.info("█" * 60)
        import os
        from src.predict import load_model, predict_single, predict_batch, print_results

        model = load_model(config)
        img_size = config["data"]["image_size"]

        if os.path.isdir(args.predict):
            results = predict_batch(model, args.predict, img_size)
        elif os.path.isfile(args.predict):
            results = [predict_single(model, args.predict, img_size)]
        else:
            logger.error(f"Path not found: {args.predict}")
            sys.exit(1)

        print_results(results)

    # ── Convert to TFLite ────────────────────────────────────────────────
    if args.convert_tflite:
        logger.info("\n" + "█" * 60)
        logger.info("  STEP: Convert to TFLite")
        logger.info("█" * 60)
        from src.convert_tflite import convert_to_tflite

        convert_to_tflite(config, quantize=args.quantize)

    # ── Evaluate External ────────────────────────────────────────────────
    if args.evaluate_external:
        logger.info("\n" + "█" * 60)
        logger.info("  STEP: Evaluate External Dataset")
        logger.info("█" * 60)
        from src.evaluate_external import evaluate_external

        evaluate_external(args.evaluate_external)

    # ── Serve Dashboard ──────────────────────────────────────────────────
    if args.serve:
        logger.info("\n" + "█" * 60)
        logger.info("  LAUNCHING DASHBOARD")
        logger.info("█" * 60)
        import uvicorn
        logger.info("Starting server at http://localhost:8000")
        uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)
        return  # uvicorn blocks, so skip the final message

    logger.info("\n✓ All requested steps completed successfully.")


if __name__ == "__main__":
    main()
