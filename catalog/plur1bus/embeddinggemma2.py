"""Pinned text-only CPU inference for the EmbeddingGemma 2 ONNX export."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import ssl
import stat
import tempfile
import threading
from typing import Any, Iterable, Mapping
from urllib.request import Request, urlopen

from .file_lock import open_existing

MODEL_ID = "google/embeddinggemma-2"
REPOSITORY = "onnx-community/embeddinggemma-2-ONNX"
BASE_MODEL_REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"
REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0"
LICENSE = "Apache-2.0"
OUTPUT_DIMENSIONS = 768
MATRYOSHKA_DIMENSIONS = (128, 256, 512, 768)
MAX_TOKENS = 8192
QUERY_PREFIX = "task: search result | query: "
PASSAGE_PREFIX = "title: none | text: "
_MAX_BATCH_SIZE = 16
_FEATURE_WIDTH = 512
_MEDIA_INPUTS = ("image_features", "video_features", "audio_features")


@dataclass(frozen=True)
class Artifact:
    """An immutable model file required for the pinned text graph."""

    path: str
    size: int
    sha256: str


_CONFIG = Artifact("config.json", 5_031, "8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d")
_TOKENIZER = Artifact("tokenizer.json", 32_170_510, "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4")
_TOKENIZER_CONFIG = Artifact("tokenizer_config.json", 1_599, "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874")
_GRAPHS = {
    "q8": (
        Artifact("onnx/model_quantized.onnx", 495_165, "d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953"),
        Artifact("onnx/model_quantized.onnx_data", 313_724_928, "278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b"),
    ),
    "q4": (
        Artifact("onnx/model_q4.onnx", 490_742, "f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9"),
        Artifact("onnx/model_q4.onnx_data", 174_028_800, "c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49"),
    ),
    "fp32": (
        Artifact("onnx/model.onnx", 421_421, "bc47de15f81208a5c99e5ab10f746d5e33b51ea228b7dc0bef9c133a94f1c1c3"),
        Artifact("onnx/model.onnx_data", 1_084_170_240, "9fd452bfc6916e5a92f080f8dada35598ca4512b21c65897d4c5974d5f9630a2"),
    ),
}


class EmbeddingGemma2Error(RuntimeError):
    """The explicit model, byte pins or runtime contract failed validation."""


def model_artifacts(dtype: str) -> tuple[Artifact, ...]:
    """Return the exact upstream files for one supported quantization."""
    if not isinstance(dtype, str) or dtype not in _GRAPHS:
        raise EmbeddingGemma2Error("EmbeddingGemma 2 dtype must be q8, q4 or fp32")
    return (_CONFIG, *_GRAPHS[dtype], _TOKENIZER, _TOKENIZER_CONFIG)


def default_config(model_dir: str | Path, dimensions: int = OUTPUT_DIMENSIONS, dtype: str = "q8") -> dict[str, Any]:
    """Build an explicit model selection without loading or downloading it."""
    config = {
        "provider": "local-onnx",
        "model": MODEL_ID,
        "revision": REVISION,
        "modelDir": str(Path(model_dir).expanduser()),
        "dtype": dtype,
        "dimensions": dimensions,
        "license": LICENSE,
        "localFilesOnly": True,
        "queryPrefix": QUERY_PREFIX,
        "passagePrefix": PASSAGE_PREFIX,
    }
    validate_config(config)
    return config


def validate_config(config: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the model identity and dimensions without I/O or imports."""
    if config.get("provider") != "local-onnx" or config.get("model") != MODEL_ID or config.get("revision") != REVISION:
        raise EmbeddingGemma2Error("EmbeddingGemma 2 requires the exact pinned local-onnx model and revision")
    raw_dir = config.get("modelDir")
    if not isinstance(raw_dir, (str, Path)) or not str(raw_dir).strip():
        raise EmbeddingGemma2Error("EmbeddingGemma 2 modelDir is required")
    dimensions = config.get("dimensions", OUTPUT_DIMENSIONS)
    if type(dimensions) is not int or dimensions not in MATRYOSHKA_DIMENSIONS:
        raise EmbeddingGemma2Error("EmbeddingGemma 2 dimensions must be one of 128, 256, 512, 768")
    dtype = config.get("dtype", "q8")
    model_artifacts(dtype)
    for key, expected in (("queryPrefix", QUERY_PREFIX), ("passagePrefix", PASSAGE_PREFIX), ("license", LICENSE)):
        if config.get(key, expected) != expected:
            raise EmbeddingGemma2Error(f"EmbeddingGemma 2 {key} is fixed by the pinned model")
    if type(config.get("maxTokens", MAX_TOKENS)) is not int or config.get("maxTokens", MAX_TOKENS) != MAX_TOKENS:
        raise EmbeddingGemma2Error("EmbeddingGemma 2 maximum token count is fixed at 8192")
    if config.get("localFilesOnly", True) is not True or config.get("fallback") or config.get("fallbackProvider"):
        raise EmbeddingGemma2Error("EmbeddingGemma 2 inference requires local files and no fallback vector space")
    return {"modelDir": str(Path(raw_dir).expanduser()), "dimensions": dimensions, "dtype": dtype}


def _redirected(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def safe_model_path(model_dir: str | Path) -> Path:
    """Validate a proposed model path and retain its leaf without following links."""
    target = Path(model_dir).expanduser().absolute()
    # Preserve standard POSIX path aliases such as macOS /var. Windows
    # junctions above the model root must also be refused.
    paths = (target, *target.parents) if os.name == "nt" else (target,)
    if any(_redirected(path) for path in paths):
        raise EmbeddingGemma2Error("EmbeddingGemma 2 model path contains a symbolic link or junction")
    return target.parent.resolve() / target.name


def _verify_file(root: Path, artifact: Artifact) -> None:
    path = root / artifact.path
    relative = path.relative_to(root)
    if len(relative.parts) > 1 and _redirected(path.parent):
        raise EmbeddingGemma2Error(f"EmbeddingGemma 2 artifact path contains a symbolic link or junction: {artifact.path}")
    try:
        with os.fdopen(open_existing(path), "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size != artifact.size:
                raise EmbeddingGemma2Error(f"EmbeddingGemma 2 artifact has the wrong size: {artifact.path}")
            if hashlib.file_digest(handle, "sha256").hexdigest() != artifact.sha256:
                raise EmbeddingGemma2Error(f"EmbeddingGemma 2 artifact hash does not match the pinned revision: {artifact.path}")
    except (OSError, ValueError) as error:
        raise EmbeddingGemma2Error(f"EmbeddingGemma 2 artifact is unavailable: {artifact.path}") from error


def verify_model_dir(model_dir: str | Path, *, dtype: str = "q8") -> dict[str, Any]:
    """Verify local artifacts by size and SHA-256 before ONNX sees any file."""
    root = safe_model_path(model_dir)
    if not root.is_dir():
        raise EmbeddingGemma2Error("EmbeddingGemma 2 model directory does not exist. Prepare the model first")
    artifacts = model_artifacts(dtype)
    for artifact in artifacts:
        _verify_file(root, artifact)
    try:
        config = json.loads((root / _CONFIG.path).read_text(encoding="utf-8"))
        if (config["model_type"], config["architectures"], config["text_config"]["embedding_dim"],
                config["text_config"]["hidden_size"]) != ("embedding_gemma2", ["EmbeddingGemma2Model"], 768, 512):
            raise EmbeddingGemma2Error("EmbeddingGemma 2 config has an unexpected architecture")
    except (OSError, KeyError, TypeError, ValueError) as error:
        raise EmbeddingGemma2Error("EmbeddingGemma 2 config is invalid") from error
    return {"prepared": True, "model": MODEL_ID, "revision": REVISION, "repository": REPOSITORY,
            "dtype": dtype, "modelDir": str(root), "artifacts": [artifact.path for artifact in artifacts]}


def prepare_model(model_dir: str | Path, *, dtype: str = "q8", timeout: float = 30, opener=None) -> dict[str, Any]:
    """Explicitly download verified model files, then atomically expose the directory."""
    artifacts = model_artifacts(dtype)
    target = safe_model_path(model_dir)
    if target.exists():
        return verify_model_dir(target, dtype=dtype)
    if type(timeout) not in {int, float} or not math.isfinite(timeout) or not 0 < timeout <= 300:
        raise EmbeddingGemma2Error("EmbeddingGemma 2 download timeout is invalid")
    if not target.parent.is_dir():
        raise EmbeddingGemma2Error("EmbeddingGemma 2 requires an existing model parent directory")
    temporary = Path(tempfile.mkdtemp(prefix=f".{target.name}.gemma2-", dir=target.parent))
    try:
        if opener is None:
            try:
                import certifi
                context = ssl.create_default_context()
                context.load_verify_locations(cafile=certifi.where())
            except (ImportError, OSError) as error:
                raise EmbeddingGemma2Error("EmbeddingGemma 2 preparation requires certifi for verified TLS") from error
            opener = lambda request, *, timeout: urlopen(request, timeout=timeout, context=context)
        for artifact in artifacts:
            path = temporary / artifact.path
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            request = Request(f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{artifact.path}",
                              headers={"User-Agent": "plur1bus-hermes"})
            with opener(request, timeout=timeout) as response, path.open("xb") as output:
                remaining = artifact.size
                while chunk := response.read(min(1_048_576, remaining + 1)):
                    remaining -= len(chunk)
                    if remaining < 0:
                        raise EmbeddingGemma2Error(f"EmbeddingGemma 2 download exceeds pinned size: {artifact.path}")
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
        verify_model_dir(temporary, dtype=dtype)
        if not target.exists():
            try:
                temporary.rename(target)
            except OSError:
                if not target.exists():
                    raise
        return verify_model_dir(target, dtype=dtype)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


class EmbeddingGemma2Encoder:
    """Lazy local CPU encoder with invariant prompts and bounded token batches."""

    def __init__(self, config: Mapping[str, Any], *, session_factory=None, tokenizer_factory=None):
        checked = validate_config(config)
        self.model_dir = Path(checked["modelDir"])
        self.dimensions, self.dtype = checked["dimensions"], checked["dtype"]
        self._session_factory, self._tokenizer_factory = session_factory, tokenizer_factory
        self._session = self._tokenizer = None
        self._lock = threading.RLock()

    def _load(self) -> None:
        if self._session is not None:
            return
        root = Path(verify_model_dir(self.model_dir, dtype=self.dtype)["modelDir"])
        factory_args = {"providers": ["CPUExecutionProvider"]}
        tokenizer_factory, session_factory = self._tokenizer_factory, self._session_factory
        try:
            if tokenizer_factory is None:
                from tokenizers import Tokenizer
                tokenizer_factory = Tokenizer.from_file
            if session_factory is None:
                import onnxruntime as ort
                options = ort.SessionOptions()
                options.intra_op_num_threads = min(4, os.cpu_count() or 1)
                factory_args["sess_options"] = options
                session_factory = ort.InferenceSession
        except ImportError as error:
            raise EmbeddingGemma2Error("EmbeddingGemma 2 requires the local-onnx dependencies") from error
        tokenizer = tokenizer_factory(str(root / _TOKENIZER.path))
        tokenizer.enable_truncation(max_length=MAX_TOKENS)
        tokenizer.no_padding()
        if tokenizer.token_to_id("<pad>") != 0:
            raise EmbeddingGemma2Error("EmbeddingGemma 2 tokenizer has no pinned padding token")
        session = session_factory(str(root / _GRAPHS[self.dtype][0].path), **factory_args)
        inputs = {entry.name: entry.type for entry in session.get_inputs()}
        expected = {"input_ids": "tensor(int64)", "attention_mask": "tensor(int64)",
                    **{name: "tensor(float)" for name in _MEDIA_INPUTS}}
        if inputs != expected or "sentence_embedding" not in {entry.name for entry in session.get_outputs()}:
            closer = getattr(session, "close", None)
            if callable(closer):
                closer()
            raise EmbeddingGemma2Error("EmbeddingGemma 2 graph has an unexpected text or media interface")
        self._tokenizer, self._session = tokenizer, session

    def close(self) -> None:
        """Release the ONNX graph and tokenizer when the provider closes."""
        with self._lock:
            session, self._session, self._tokenizer = self._session, None, None
            close = getattr(session, "close", None)
            if callable(close):
                close()

    def _infer(self, batch: list[list[int]]) -> list[list[float]]:
        import numpy as np
        width = max(map(len, batch))
        input_ids = np.zeros((len(batch), width), dtype="int64")
        mask = np.zeros_like(input_ids)
        for i, tokens in enumerate(batch):
            input_ids[i, :len(tokens)] = tokens
            mask[i, :len(tokens)] = 1
        # The text graph still exposes projected feature inputs, even though
        # no media towers are loaded. Send empty tensors, never fake tokens.
        no_media = np.empty((0, _FEATURE_WIDTH), dtype="float32")
        (vectors,) = self._session.run(["sentence_embedding"], {"input_ids": input_ids, "attention_mask": mask,
                                                                **dict.fromkeys(_MEDIA_INPUTS, no_media)})
        if vectors.shape != (len(batch), OUTPUT_DIMENSIONS):
            raise EmbeddingGemma2Error("EmbeddingGemma 2 sentence_embedding has an invalid shape")
        result = []
        for row in vectors:
            values = row[:self.dimensions].astype("float64")
            norm = float(np.linalg.norm(values))
            if not math.isfinite(norm) or norm <= 0:
                raise EmbeddingGemma2Error("EmbeddingGemma 2 returned a zero or non-finite vector")
            result.append((values / norm).tolist())
        return result

    def embed_many(self, texts: Iterable[str], *, purpose: str = "passage") -> list[list[float]]:
        """Encode queries or passages with fixed prompts and Matryoshka normalization."""
        values = list(texts)
        if purpose not in {"query", "passage"} or not values or any(
            not isinstance(text, str) or not text.strip() for text in values
        ):
            raise EmbeddingGemma2Error("EmbeddingGemma 2 needs non-empty text and a query or passage purpose")
        prefix = QUERY_PREFIX if purpose == "query" else PASSAGE_PREFIX
        result = []
        with self._lock:
            self._load()
            for offset in range(0, len(values), _MAX_BATCH_SIZE):
                inputs = values[offset:offset + _MAX_BATCH_SIZE]
                token_rows = [encoding.ids for encoding in self._tokenizer.encode_batch([prefix + text for text in inputs])]
                if len(token_rows) != len(inputs) or any(not 0 < len(tokens) <= MAX_TOKENS for tokens in token_rows):
                    raise EmbeddingGemma2Error("EmbeddingGemma 2 tokenizer violated its sequence limit")
                batch = []
                width = 0
                for tokens in token_rows:
                    if batch and max(width, len(tokens)) * (len(batch) + 1) > MAX_TOKENS:
                        result.extend(self._infer(batch))
                        batch, width = [], 0
                    batch.append(tokens)
                    width = max(width, len(tokens))
                result.extend(self._infer(batch))
        return result

    def embed(self, text: str, *, purpose: str = "passage") -> list[float]:
        """Encode a single query or passage using the same batch contract."""
        return self.embed_many([text], purpose=purpose)[0]
