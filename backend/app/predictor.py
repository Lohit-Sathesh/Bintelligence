import numpy as np
from PIL import Image

from ai_edge_litert.interpreter import Interpreter

CLASS_NAMES = ["dry", "wet"]
IMAGE_SIZE = 224


def _heatmap_to_bbox(heatmap: np.ndarray, thresh: float = 0.35) -> dict | None:
    h = np.asarray(heatmap, dtype=np.float32)
    if h.size == 0 or not np.isfinite(h).any():
        return None
    h = h - h.min()
    peak = h.max()
    if peak <= 0:
        return None
    h = h / peak
    ys, xs = np.where(h >= thresh)
    if ys.size == 0:
        return None
    rows, cols = h.shape
    x0, x1 = xs.min(), xs.max() + 1
    y0, y1 = ys.min(), ys.max() + 1
    return {
        "x": round(float(x0 / cols), 4),
        "y": round(float(y0 / rows), 4),
        "w": round(float((x1 - x0) / cols), 4),
        "h": round(float((y1 - y0) / rows), 4),
    }


class WasteClassifier:
    def __init__(self, model_path: str) -> None:
        self._interp = Interpreter(model_path=model_path)
        self._interp.allocate_tensors()

        input_detail = self._interp.get_input_details()[0]
        self._input_idx = input_detail["index"]
        self._input_dtype = input_detail["dtype"]
        self._outputs = self._interp.get_output_details()

    def _preprocess(self, image: Image.Image) -> np.ndarray:
        img = image.convert("RGB").resize((IMAGE_SIZE, IMAGE_SIZE), Image.LANCZOS)
        # EfficientNetB0 bakes in its own Rescaling + Normalization as the
        # first layers of the model, so raw [0,255] pixels are passed through
        # unchanged here (matching training in src/dataset.py, which likewise
        # treats tf.keras.applications.efficientnet.preprocess_input as a no-op).
        arr = np.array(img, dtype=np.float32)
        return np.expand_dims(arr, axis=0).astype(self._input_dtype)

    def predict(self, image: Image.Image) -> dict:
        x = self._preprocess(image)
        self._interp.set_tensor(self._input_idx, x)
        self._interp.invoke()

        prob, heat = None, None
        for out in self._outputs:
            t = self._interp.get_tensor(out["index"])
            if t.size == 1:
                prob = float(t.reshape(-1)[0])
            elif t.ndim >= 2:
                heat = np.squeeze(t)

        pred_class = CLASS_NAMES[1] if prob >= 0.5 else CLASS_NAMES[0]
        confidence = prob if prob >= 0.5 else 1.0 - prob

        result = {
            "class": pred_class,
            "confidence": round(confidence * 100, 2),
            "probabilities": {
                "dry": round((1 - prob) * 100, 2),
                "wet": round(prob * 100, 2),
            },
            "bbox": _heatmap_to_bbox(heat) if heat is not None else None,
        }
        return result
