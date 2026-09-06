"""Pinned, local-only ONNX BGE reranking without torch or remote code.

Recall only verifies and opens a pre-prepared directory.  The optional network
operation is deliberately exposed as :func:`prepare_model`; it downloads one
immutable Hugging Face revision into private staging, hashes every byte, then
atomically publishes the directory.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import shutil
import ssl
import tempfile
import threading
from typing import Any, Callable, Mapping, Sequence
from urllib.request import Request, urlopen

MODEL = MODEL_ID = "BAAI/bge-reranker-v2-m3"
ONNX_REPOSITORY = "onnx-community/bge-reranker-v2-m3-ONNX"
REVISION = "6f5ff65298512715a1e669753bc754d2bc8f367b"
LICENSE = "Apache-2.0"
MAX_TOKENS = 512
MAX_BATCH_SIZE = 8


@dataclass(frozen=True)
class Artifact:
    """One byte-pinned upstream file required for CPU inference."""
    path: str
    size: int
    sha256: str


ARTIFACTS = (
    Artifact("config.json", 848, "122e922dcfed6503c8721e6fe1daf090340c3d95ca7f3aa3a72730b321a51cfd"),
    Artifact("onnx/model_quantized.onnx", 570_727_094, "912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d"),
    Artifact("tokenizer.json", 17_082_900, "8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3"),
    Artifact("tokenizer_config.json", 1_203, "b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80"),
    Artifact("special_tokens_map.json", 964, "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835"),
)


class BgeOnnxError(RuntimeError):
    """Raised when the pinned BGE runtime would be unsafe or invalid."""


def default_config(model_dir: str | Path) -> dict[str, Any]:
    """Return an explicit, offline-only BGE reranker configuration."""
    return {"provider": "local-onnx", "model": MODEL, "revision": REVISION,
            "modelDir": str(Path(model_dir).expanduser()), "localFilesOnly": True,
            "maxTokens": MAX_TOKENS, "batchSize": MAX_BATCH_SIZE}


def validate_config(config: Mapping[str, Any]) -> dict[str, Any]:
    """Statically validate routing without loading dependencies or touching disk."""
    if not isinstance(config, Mapping):
        raise BgeOnnxError("BGE ONNX config must be an object")
    if config.get("provider") != "local-onnx" or config.get("model") != MODEL or config.get("revision") != REVISION:
        raise BgeOnnxError("BGE ONNX requires the exact pinned local-onnx model and revision")
    raw_dir = config.get("modelDir")
    if not isinstance(raw_dir, (str, Path)) or not str(raw_dir).strip():
        raise BgeOnnxError("BGE ONNX modelDir is required")
    if config.get("localFilesOnly") is not True:
        raise BgeOnnxError("BGE ONNX requires localFilesOnly: true")
    for name, expected in (("maxTokens", MAX_TOKENS), ("batchSize", MAX_BATCH_SIZE)):
        if name in config and (type(config[name]) is not int or config[name] != expected):
            raise BgeOnnxError(f"BGE ONNX {name} is fixed at {expected}")
    return {"modelDir": str(Path(raw_dir).expanduser()), "maxTokens": MAX_TOKENS,
            "batchSize": MAX_BATCH_SIZE}


def _path(root: Path, artifact: Artifact) -> Path:
    result = root.joinpath(*artifact.path.split("/"))
    try:
        result.relative_to(root)
    except ValueError as error:
        raise BgeOnnxError("BGE artifact path escapes model directory") from error
    return result


def _redirected(path: Path) -> bool:
    """Detect links plus Windows junction/reparse redirects on old Python."""
    try:
        return path.is_symlink() or bool(getattr(path.lstat(), "st_file_attributes", 0) & 0x400)
    except FileNotFoundError:
        return path.is_symlink()


def _reject_redirected_components(root: Path, path: Path) -> None:
    """Reject every lexical descendant rather than resolving through a redirect."""
    current = root
    for part in path.relative_to(root).parts:
        current /= part
        if _redirected(current):
            raise BgeOnnxError("BGE artifact path contains a symbolic link or junction")


def _reject_redirected_ancestors(path: Path) -> None:
    """Reject Windows paths beneath junctions while retaining POSIX system aliases."""
    # macOS intentionally exposes /var as a symlink to /private/var.  Junction
    # ancestry is a Windows-only gap in Path.is_symlink(), so do not turn that
    # conventional POSIX alias into an unrelated preparation failure.
    if os.name != "nt":
        return
    current = Path(path.anchor) if path.anchor else Path(Path.cwd().anchor)
    parts = path.parts[1:] if path.anchor else path.parts
    for part in parts:
        current /= part
        if _redirected(current):
            raise BgeOnnxError("BGE model path contains a symbolic link or junction")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_model_dir(model_dir: str | Path) -> dict[str, Any]:
    """Verify all pre-existing artifacts; this function never performs I/O to network."""
    root = Path(model_dir).expanduser().absolute()
    _reject_redirected_ancestors(root)
    if _redirected(root) or not root.is_dir():
        raise BgeOnnxError("BGE model directory must be an existing non-symlink/non-junction directory")
    root = root.resolve()
    verified: list[str] = []
    for artifact in ARTIFACTS:
        path = _path(root, artifact)
        _reject_redirected_components(root, path)
        if not path.is_file() or path.stat().st_size != artifact.size:
            raise BgeOnnxError(f"BGE artifact is missing or has the wrong size: {artifact.path}")
        if _sha256(path) != artifact.sha256:
            raise BgeOnnxError(f"BGE artifact hash does not match pinned revision: {artifact.path}")
        verified.append(artifact.path)
    try:
        config = json.loads((root / "config.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BgeOnnxError("BGE pinned config is unreadable") from error
    if not isinstance(config, dict) or config.get("model_type") != "xlm-roberta" or config.get("architectures") != ["XLMRobertaForSequenceClassification"] or config.get("num_labels", 1) != 1:
        raise BgeOnnxError("BGE config is not the pinned sequence-classification model")
    return {"prepared": True, "model": MODEL, "repository": ONNX_REPOSITORY,
            "revision": REVISION, "artifacts": verified, "modelDir": str(root)}


def _url(artifact: Artifact) -> str:
    return f"https://huggingface.co/{ONNX_REPOSITORY}/resolve/{REVISION}/{artifact.path}"


def _verified_opener(opener: Callable[..., Any]) -> Callable[..., Any]:
    """Add certifi roots to the system trust store only for the default request."""
    if opener is not urlopen:
        return opener
    try:
        certifi = importlib.import_module("certifi")
        context = ssl.create_default_context()
        context.load_verify_locations(cafile=certifi.where())
    except (ImportError, AttributeError, OSError) as error:
        raise BgeOnnxError("BGE preparation requires certifi for verified TLS") from error
    return lambda request, *, timeout: opener(request, timeout=timeout, context=context)


def _download(artifact: Artifact, target: Path, *, timeout: float, opener: Callable[..., Any]) -> None:
    request = Request(_url(artifact), headers={"User-Agent": "plur1bus-hermes"})
    with opener(request, timeout=timeout) as response, target.open("xb") as handle:
        digest, written = hashlib.sha256(), 0
        while True:
            chunk = response.read(min(1024 * 1024, artifact.size - written + 1))
            if not chunk:
                break
            written += len(chunk)
            if written > artifact.size:
                raise BgeOnnxError(f"BGE download exceeds pinned size: {artifact.path}")
            handle.write(chunk); digest.update(chunk)
        handle.flush(); os.fsync(handle.fileno())
    if written != artifact.size or digest.hexdigest() != artifact.sha256:
        raise BgeOnnxError(f"BGE download did not match pinned artifact: {artifact.path}")


def prepare_model(model_dir: str | Path, *, timeout: float = 30.0, opener: Callable[..., Any] = urlopen) -> dict[str, Any]:
    """Explicitly fetch the fixed revision or verify existing bytes; never overwrite it."""
    target = Path(model_dir).expanduser().absolute()
    if target.exists() or _redirected(target):
        return verify_model_dir(target)
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not math.isfinite(timeout) or not 0 < timeout <= 300:
        raise BgeOnnxError("BGE download timeout is invalid")
    parent = target.parent
    _reject_redirected_ancestors(parent)
    if _redirected(parent) or not parent.is_dir():
        raise BgeOnnxError("BGE model parent must be an existing non-symlink/non-junction directory")
    temporary: Path | None = Path(tempfile.mkdtemp(prefix=f".{target.name}.bge-onnx-", dir=parent))
    try:
        request_opener = _verified_opener(opener)
        for artifact in ARTIFACTS:
            path = _path(temporary, artifact)
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            _download(artifact, path, timeout=float(timeout), opener=request_opener)
        verify_model_dir(temporary)
        if target.exists() or target.is_symlink():
            return verify_model_dir(target)
        os.rename(temporary, target)
        temporary = None
        return verify_model_dir(target)
    finally:
        if temporary is not None:
            shutil.rmtree(temporary)


class BgeOnnxReranker:
    """Lazy CPU-only ONNX cross encoder with fixed 512 token/8 pair bounds."""
    def __init__(self, config: Mapping[str, Any], *, session_factory: Callable[..., Any] | None = None,
                 tokenizer_factory: Callable[[str], Any] | None = None) -> None:
        checked = validate_config(config)
        self.model_dir = Path(checked["modelDir"])
        self._session_factory, self._tokenizer_factory = session_factory, tokenizer_factory
        self._session: Any = None
        self._tokenizer: Any = None
        self._lock = threading.RLock()

    def prepare(self) -> dict[str, Any]:
        return verify_model_dir(self.model_dir)

    def load(self) -> None:
        with self._lock:
            if self._session is not None:
                return
            self.prepare()
            if self._tokenizer_factory is None:
                try:
                    self._tokenizer_factory = importlib.import_module("tokenizers").Tokenizer.from_file
                except (ImportError, AttributeError) as error:
                    raise BgeOnnxError("BGE ONNX inference requires tokenizers") from error
            if self._session_factory is None:
                try:
                    ort = importlib.import_module("onnxruntime")
                    self._session_factory = ort.InferenceSession
                except (ImportError, AttributeError) as error:
                    raise BgeOnnxError("BGE ONNX inference requires onnxruntime") from error
            self._tokenizer = self._tokenizer_factory(str(self.model_dir / "tokenizer.json"))
            self._session = self._session_factory(str(self.model_dir / "onnx" / "model_quantized.onnx"), providers=["CPUExecutionProvider"])
            names = {item.name for item in self._session.get_inputs()}
            if not {"input_ids", "attention_mask"}.issubset(names):
                self.close(); raise BgeOnnxError("BGE ONNX graph must expose input_ids and attention_mask")

    def close(self) -> None:
        with self._lock:
            close = getattr(self._session, "close", None)
            if callable(close): close()
            self._session = self._tokenizer = None

    def _batch(self, pairs: Sequence[tuple[str, str]]) -> tuple[Any, Any]:
        try:
            numpy = importlib.import_module("numpy")
        except ImportError as error:
            raise BgeOnnxError("BGE ONNX inference requires numpy") from error
        self._tokenizer.enable_truncation(max_length=MAX_TOKENS)
        self._tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
        encoded = self._tokenizer.encode_batch(list(pairs))
        if len(encoded) != len(pairs) or not encoded:
            raise BgeOnnxError("BGE tokenizer returned an unexpected batch size")
        ids, masks = [list(item.ids) for item in encoded], [list(item.attention_mask) for item in encoded]
        if any(not row or len(row) > MAX_TOKENS for row in ids) or any(len(a) != len(b) for a, b in zip(ids, masks, strict=True)):
            raise BgeOnnxError("BGE tokenizer ignored bounded pair tokenization")
        return numpy.asarray(ids, dtype="int64"), numpy.asarray(masks, dtype="int64")

    def score_many(self, pairs: Sequence[tuple[str, str]]) -> list[float]:
        """Score nonempty query/document pairs, retaining input order."""
        values = list(pairs)
        if not values or len(values) > MAX_BATCH_SIZE or any(not isinstance(q, str) or not q.strip() or not isinstance(d, str) or not d.strip() for q, d in values):
            raise BgeOnnxError("BGE ONNX requires 1..8 non-empty query/document pairs")
        # Tokenizers mutate truncation/padding settings and onnxruntime sessions
        # cannot safely be closed mid-run.  Serialize all three lifecycle steps.
        with self._lock:
            self.load()
            ids, mask = self._batch(values)
            outputs = self._session.run(None, {"input_ids": ids, "attention_mask": mask})
        if len(outputs) != 1 or tuple(getattr(outputs[0], "shape", ())) not in {(len(values),), (len(values), 1)}:
            raise BgeOnnxError("BGE ONNX logits have invalid shape")
        scores = [float(value) for value in outputs[0].reshape(-1)]
        if len(scores) != len(values) or any(not math.isfinite(score) for score in scores):
            raise BgeOnnxError("BGE ONNX returned non-finite scores")
        return scores
