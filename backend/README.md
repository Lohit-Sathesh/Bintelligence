---
title: Waste Classifier
emoji: 🌖
colorFrom: blue
colorTo: gray
sdk: docker
pinned: false
---

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference

`/predict` and `/predict-url` return `class`, `confidence`, `probabilities`, and a normalized `bbox` (`{x, y, w, h}` in [0,1], or `null`) locating the waste in the image. Re-export the TFLite model (`python main.py --convert-tflite --quantize float16`) to enable `bbox` in the deployed app.
