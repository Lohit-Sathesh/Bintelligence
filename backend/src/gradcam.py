import logging

import numpy as np
import tensorflow as tf
import keras

logger = logging.getLogger(__name__)

CONV_LAYER = "top_activation"


def heatmap_to_bbox(heatmap: np.ndarray, thresh: float = 0.35) -> dict | None:
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


def build_localizer(model: keras.Model) -> keras.Model | None:
    """Wrap model to also output a class-aware Grad-CAM heatmap, computed
    in-graph (GAP is linear, so Grad-CAM is a closed form of the head weights).
    Returns a model mapping image -> [prob, heatmap(7x7)]."""
    try:
        base = model.layers[1]
        dense = model.get_layer("head_dense")
        out = model.get_layer("output")
        W1, b1 = dense.kernel, dense.bias
        W2 = out.kernel
        feat = keras.Model(base.input, base.get_layer(CONV_LAYER).output)
        inp = keras.Input(shape=model.input_shape[1:], name="input_image")
        conv = feat(inp)
        prob = model(inp)

        def cam(t):
            c, p = t
            g = tf.reduce_mean(c, axis=(1, 2))
            mask = tf.cast(tf.matmul(g, W1) + b1 > 0, tf.float32)
            grad_g = tf.matmul(mask * tf.squeeze(W2, -1), W1, transpose_b=True)
            m = tf.einsum("bc,bhwc->bhw", grad_g, c)
            return tf.nn.relu(m * tf.sign(p[:, 0] - 0.5)[:, None, None])

        heat = keras.layers.Lambda(cam, name="heatmap")([conv, prob])
        return keras.Model(inp, [prob, heat], name="WetDryClassifierLoc")
    except Exception as e:
        logger.warning("Localizer not built (%s).", e)
        return None


def gradcam_bbox(model: keras.Model, x: np.ndarray, thresh: float = 0.35) -> dict | None:
    loc = getattr(model, "_localizer", None)
    if loc is None:
        loc = build_localizer(model)
        try:
            model._localizer = loc
        except Exception:
            pass
    if loc is None:
        return None
    try:
        _, heat = loc(x, training=False)
        return heatmap_to_bbox(heat[0].numpy(), thresh)
    except Exception as e:
        logger.debug("Localize failed: %s", e)
        return None
