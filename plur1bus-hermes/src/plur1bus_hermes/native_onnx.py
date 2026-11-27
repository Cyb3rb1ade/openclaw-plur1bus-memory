"""Closed selection of approved native ONNX embedding routes."""
from __future__ import annotations

from typing import Any, Mapping

from . import embeddinggemma2, jina_v5_nano


class NativeOnnxConfigError(RuntimeError):
    """The requested model is not a supported pinned native configuration."""


def is_pinned_model(model: Any) -> bool:
    """Identify models that require a particular native ONNX vector space."""
    if not isinstance(model, str):
        return False
    lowered = model.lower()
    return lowered == embeddinggemma2.MODEL_ID or "jina-embeddings-v5-text-nano" in lowered


def _module(config: Mapping[str, Any]):
    if config.get("model") == embeddinggemma2.MODEL_ID:
        return embeddinggemma2
    if config.get("model") == jina_v5_nano.MODEL_ID:
        return jina_v5_nano
    raise NativeOnnxConfigError("local-onnx embedding model must be pinned Jina v5 Nano or EmbeddingGemma 2")


def validate_config(config: Mapping[str, Any]) -> dict[str, Any]:
    """Validate either approved native model without reading or loading files."""
    try:
        return _module(config).validate_config(config)
    except (embeddinggemma2.EmbeddingGemma2Error, jina_v5_nano.JinaV5NanoError) as error:
        raise NativeOnnxConfigError(str(error)) from error


def encoder(config: Mapping[str, Any]):
    """Construct the lazy encoder for the checked native model."""
    model = _module(config)
    if model is embeddinggemma2:
        return model.EmbeddingGemma2Encoder(config)
    return model.JinaV5NanoEncoder(config)


def prepare_model(config: Mapping[str, Any]) -> dict[str, Any]:
    """Run the operator-approved download/verification for the selected route."""
    checked = validate_config(config)
    model = _module(config)
    if model is embeddinggemma2:
        return model.prepare_model(checked["modelDir"], dtype=checked["dtype"])
    return model.prepare_model(checked["modelDir"], accepted=checked["licenseAccepted"])
