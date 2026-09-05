"""Pinned, local-only Jina v5 Text Nano Q8 ONNX embedding support.

Inference never downloads models or enables remote code. An operator explicitly
prepares a verified local artifact directory first; only then can a lazy encoder
load ``tokenizers`` and ``onnxruntime``.
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
import tempfile
from typing import Any, Callable, Iterable, Mapping
from urllib.request import Request, urlopen


MODEL = "jinaai/jina-embeddings-v5-text-nano-retrieval"
REVISION = "ac5d898c8d382b17167c33e5c8af644a3519b47d"
LICENSE = "CC-BY-NC-4.0"
MAX_TOKENS = 512
OUTPUT_DIMENSIONS = 768
MATRYOSHKA_DIMENSIONS = frozenset({32, 64, 128, 256, 512, 768})
QUERY_PREFIX = "Query: "
DOCUMENT_PREFIX = "Document: "


@dataclass(frozen=True)
class Artifact:
    """One immutable local model artifact from upstream v7.12.0."""

    path: str
    size: int
    sha256: str


ARTIFACTS = (
    Artifact("config.json", 1_361, "367857e3a726df6f1997bcb8443a4351e68b29c65f996e5874a4b3e7c5661a16"),
    Artifact("onnx/model_quantized.onnx", 131_365, "ac93a7417c216e5076e37da2b3599f7ef16513934098a477680440c09f735a08"),
    Artifact("onnx/model_quantized.onnx_data", 247_006_208, "ee7870eb143a7353be08b33f79992a51de3e32b41f684ccd82953a710c2f2f9c"),
    Artifact("tokenizer.json", 17_210_235, "98d4a1d32152d6cedf85b5e88f3b205106dca1fe72aaab34e0ac13c238421069"),
    Artifact("tokenizer_config.json", 487, "6c4640d432db970b2436a4386d3ee992b99e756b62c37446c3f581c8d09cbb05"),
)


class JinaV5NanoError(RuntimeError):
    """Raised when local Jina v5 preparation or inference is unsafe."""


def native_jina_v5_nano_config(*, model_dir: str | Path, dimensions: int = OUTPUT_DIMENSIONS) -> dict[str, Any]:
    """Return the proposed explicit native config; it does not prepare/load."""
    _validate_dimensions(dimensions)
    return {
        "provider": "local-onnx",
        "model": MODEL,
        "revision": REVISION,
        "modelDir": str(Path(model_dir).expanduser()),
        "dimensions": dimensions,
        "license": LICENSE,
        "licenseAccepted": False,
        "queryPrefix": QUERY_PREFIX,
        "passagePrefix": DOCUMENT_PREFIX,
    }


# Stable name for runtime/config integration; recall never calls the downloader.
MODEL_ID = MODEL


def default_config(model_dir: str | Path, dimensions: int = OUTPUT_DIMENSIONS, accepted: bool = False) -> dict[str, Any]:
    """Return explicit local-ONNX configuration without loading/downloading."""
    result = native_jina_v5_nano_config(model_dir=model_dir, dimensions=dimensions)
    result["licenseAccepted"] = accepted is True
    return result


def validate_config(config: Mapping[str, Any]) -> dict[str, Any]:
    """Statically validate native config without reading models or importing ML deps."""
    if not isinstance(config, Mapping):
        raise JinaV5NanoError("Jina v5 config must be an object")
    _require_license(config.get("licenseAccepted") is True)
    if config.get("provider") not in {"local-onnx", "jina-v5-nano-onnx", "jina-v5-nano"}:
        raise JinaV5NanoError("Jina v5 encoder requires the explicit native provider")
    if config.get("model") != MODEL or config.get("revision") != REVISION:
        raise JinaV5NanoError("Jina v5 encoder requires the exact pinned model and revision")
    raw_dir = config.get("modelDir")
    if not isinstance(raw_dir, (str, Path)) or not str(raw_dir).strip():
        raise JinaV5NanoError("Jina v5 modelDir is required")
    dimensions = _validate_dimensions(config.get("dimensions", OUTPUT_DIMENSIONS))
    if config.get("queryPrefix", QUERY_PREFIX) != QUERY_PREFIX or config.get("passagePrefix", DOCUMENT_PREFIX) != DOCUMENT_PREFIX:
        raise JinaV5NanoError("Jina v5 Query:/Document: prefixes are invariant")
    if "maxTokens" in config and (isinstance(config["maxTokens"], bool) or type(config["maxTokens"]) is not int or config["maxTokens"] != MAX_TOKENS):
        raise JinaV5NanoError("Jina v5 maximum token count is fixed at 512")
    return {"modelDir": str(Path(raw_dir).expanduser()), "dimensions": dimensions, "licenseAccepted": config.get("licenseAccepted") is True}


def _validate_dimensions(dimensions: Any) -> int:
    if isinstance(dimensions, bool):
        raise JinaV5NanoError("Jina v5 dimensions must be a Matryoshka dimension")
    if type(dimensions) is not int:
        raise JinaV5NanoError("Jina v5 dimensions must be an integer Matryoshka dimension")
    try:
        parsed = int(dimensions)
    except (TypeError, ValueError) as error:
        raise JinaV5NanoError("Jina v5 dimensions must be a Matryoshka dimension") from error
    if parsed not in MATRYOSHKA_DIMENSIONS:
        raise JinaV5NanoError("Jina v5 dimensions must be one of 32, 64, 128, 256, 512, 768")
    return parsed


def _artifact_path(root: Path, artifact: Artifact) -> Path:
    candidate = root.joinpath(*artifact.path.split("/"))
    try:
        candidate.relative_to(root)
    except ValueError as error:  # defensive even though the manifest is constant
        raise JinaV5NanoError("Jina v5 artifact path escapes model directory") from error
    return candidate


def _reject_artifact_symlinks(root: Path, path: Path) -> None:
    """Reject every lexical component, including dangling links, below root."""
    current = root
    try:
        parts = path.relative_to(root).parts
    except ValueError as error:
        raise JinaV5NanoError("Jina v5 artifact path escapes model directory") from error
    for part in parts:
        current /= part
        if current.is_symlink():
            raise JinaV5NanoError("Jina v5 artifact path contains a symbolic link")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _require_license(accepted: bool) -> None:
    if accepted is not True:
        raise JinaV5NanoError(f"{MODEL} requires explicit acknowledgement of {LICENSE} before preparation or use")


def prepare_local_jina_v5_nano(model_dir: str | Path, *, license_accepted: bool) -> dict[str, Any]:
    """Verify local immutable artifacts; this intentionally never downloads."""
    _require_license(license_accepted)
    root = Path(model_dir).expanduser().absolute()
    if root.is_symlink() or not root.is_dir():
        raise JinaV5NanoError("Jina v5 model directory must be an existing non-symlink directory")
    root = root.resolve()
    verified: list[str] = []
    for artifact in ARTIFACTS:
        path = _artifact_path(root, artifact)
        _reject_artifact_symlinks(root, path)
        if path.is_symlink() or not path.is_file() or path.stat().st_size != artifact.size:
            raise JinaV5NanoError(f"Jina v5 artifact is missing or has the wrong size: {artifact.path}")
        if _sha256_file(path) != artifact.sha256:
            raise JinaV5NanoError(f"Jina v5 artifact hash does not match pinned revision: {artifact.path}")
        verified.append(artifact.path)
    try:
        config = json.loads((root / "config.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise JinaV5NanoError("Jina v5 pinned config is unreadable") from error
    if (not isinstance(config, dict) or config.get("model_type") != "eurobert"
        or config.get("hidden_size") != OUTPUT_DIMENSIONS or config.get("architectures") != ["EuroBertModel"]):
        raise JinaV5NanoError("Jina v5 config is not the pinned EuroBert 768 model")
    return {"prepared": True, "model": MODEL, "revision": REVISION, "artifacts": verified, "modelDir": str(root)}


def verify_model_dir(model_dir: str | Path, *, accepted: bool = False) -> dict[str, Any]:
    """Verify a pre-existing local model directory; no network access occurs."""
    return prepare_local_jina_v5_nano(model_dir, license_accepted=accepted)


def _artifact_url(artifact: Artifact) -> str:
    return f"https://huggingface.co/{MODEL}/resolve/{REVISION}/" + "/".join(artifact.path.split("/"))


def _download_artifact(artifact: Artifact, target: Path, *, timeout: float, opener: Callable[..., Any]) -> None:
    request = Request(_artifact_url(artifact), headers={"User-Agent": "plur1bus-hermes"})
    with opener(request, timeout=timeout) as response, target.open("xb") as handle:
        declared = response.headers.get("Content-Length") if getattr(response, "headers", None) else None
        if isinstance(declared, str) and declared.isdigit() and int(declared) > artifact.size:
            raise JinaV5NanoError(f"Jina v5 download exceeds pinned size: {artifact.path}")
        digest, written = hashlib.sha256(), 0
        while True:
            chunk = response.read(min(1024 * 1024, artifact.size - written + 1))
            if not chunk:
                break
            written += len(chunk)
            if written > artifact.size:
                raise JinaV5NanoError(f"Jina v5 download exceeds pinned size: {artifact.path}")
            handle.write(chunk); digest.update(chunk)
        handle.flush(); os.fsync(handle.fileno())
    if written != artifact.size or digest.hexdigest() != artifact.sha256:
        raise JinaV5NanoError(f"Jina v5 download did not match pinned artifact: {artifact.path}")


def prepare_model(model_dir: str | Path, *, accepted: bool = False, timeout: float = 30.0,
                  opener: Callable[..., Any] = urlopen) -> dict[str, Any]:
    """Explicitly download the fixed revision once, or verify an existing directory."""
    _require_license(accepted)
    target = Path(model_dir).expanduser().absolute()
    if target.exists() or target.is_symlink():
        return verify_model_dir(target, accepted=True)
    if not math.isfinite(timeout) or timeout <= 0 or timeout > 300:
        raise JinaV5NanoError("Jina v5 download timeout is invalid")
    parent = target.parent
    if parent.is_symlink() or not parent.is_dir():
        raise JinaV5NanoError("Jina v5 model parent must be an existing non-symlink directory")
    temporary: Path | None = Path(tempfile.mkdtemp(prefix=f".{target.name}.jina-v5-", dir=parent))
    try:
        for artifact in ARTIFACTS:
            path = _artifact_path(temporary, artifact)
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            _download_artifact(artifact, path, timeout=timeout, opener=opener)
        prepare_local_jina_v5_nano(temporary, license_accepted=True)
        if target.exists() or target.is_symlink():
            return verify_model_dir(target, accepted=True)
        os.rename(temporary, target)
        temporary = None
        return verify_model_dir(target, accepted=True)
    finally:
        if temporary is not None:
            shutil.rmtree(temporary)


def _last_token_pool(hidden: Any, mask: Any) -> list[list[float]]:
    """Pool the final attended token without assuming left/right padding."""
    shape = tuple(getattr(hidden, "shape", ()))
    mask_shape = tuple(getattr(mask, "shape", ()))
    if len(shape) != 3 or shape[2] != OUTPUT_DIMENSIONS or mask_shape != shape[:2]:
        raise JinaV5NanoError("Jina v5 hidden states/mask have invalid shapes")
    rows: list[list[float]] = []
    for row in range(shape[0]):
        last = -1
        for position in range(shape[1]):
            if int(mask[row][position]) != 0:
                last = position
        if last < 0:
            raise JinaV5NanoError("Jina v5 input has no attended token")
        values = [float(value) for value in hidden[row][last]]
        if len(values) != OUTPUT_DIMENSIONS:
            raise JinaV5NanoError("Jina v5 hidden state width is invalid")
        rows.append(values)
    return rows


def _project_normalize(row: Iterable[Any], dimensions: int) -> list[float]:
    values = [float(value) for value in list(row)[:dimensions]]
    if len(values) != dimensions or any(not math.isfinite(value) for value in values):
        raise JinaV5NanoError("Jina v5 returned a non-finite Matryoshka vector")
    norm = math.sqrt(sum(value * value for value in values))
    if not math.isfinite(norm) or norm <= 0:
        raise JinaV5NanoError("Jina v5 returned a zero or non-finite Matryoshka vector")
    return [value / norm for value in values]


class JinaV5NanoEncoder:
    """Lazy local ONNX encoder; call :meth:`prepare` separately before load."""

    def __init__(self, config: Mapping[str, Any], *, session_factory: Callable[..., Any] | None = None,
                 tokenizer_factory: Callable[[str], Any] | None = None) -> None:
        checked = validate_config(config)
        # This is intentionally before any optional dependency can be imported.
        _require_license(checked["licenseAccepted"])
        self.model_dir = Path(checked["modelDir"])
        self.dimensions = checked["dimensions"]
        self.max_tokens = MAX_TOKENS
        self.license_accepted = checked["licenseAccepted"]
        self._session_factory = session_factory
        self._tokenizer_factory = tokenizer_factory
        self._session: Any = None
        self._tokenizer: Any = None

    def prepare(self) -> dict[str, Any]:
        """Explicit local artifact verification; no inference dependencies load."""
        return prepare_local_jina_v5_nano(self.model_dir, license_accepted=self.license_accepted)

    def load(self) -> None:
        """Lazily load verified local tokenization and ONNX inference only."""
        if self._session is not None:
            return
        self.prepare()
        if self._tokenizer_factory is None:
            try:
                tokenizers = importlib.import_module("tokenizers")
                self._tokenizer_factory = tokenizers.Tokenizer.from_file
            except (ImportError, AttributeError) as error:
                raise JinaV5NanoError("Jina v5 inference requires the optional tokenizers package") from error
        options = None
        session_factory = self._session_factory
        if session_factory is None:
            try:
                onnxruntime = importlib.import_module("onnxruntime")
                session_factory = onnxruntime.InferenceSession
                options = onnxruntime.SessionOptions()
                options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_DISABLE_ALL
            except (ImportError, AttributeError) as error:
                raise JinaV5NanoError("Jina v5 inference requires the optional onnxruntime package") from error
        self._tokenizer = self._tokenizer_factory(str(self.model_dir / "tokenizer.json"))
        if options is None:
            self._session = session_factory(str(self.model_dir / "onnx" / "model_quantized.onnx"), providers=["CPUExecutionProvider"])
        else:
            self._session = session_factory(str(self.model_dir / "onnx" / "model_quantized.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
        inputs = {entry.name for entry in self._session.get_inputs()}
        if not {"input_ids", "attention_mask"}.issubset(inputs):
            self.close()
            raise JinaV5NanoError("Jina v5 ONNX graph must expose input_ids and attention_mask")

    def close(self) -> None:
        """Release the session where the installed runtime exposes a close method."""
        close = getattr(self._session, "close", None)
        if callable(close):
            close()
        self._session = None
        self._tokenizer = None

    def _padding_token(self) -> str:
        try:
            config = json.loads((self.model_dir / "tokenizer_config.json").read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise JinaV5NanoError("Jina v5 tokenizer_config is unreadable") from error
        token = config.get("pad_token") if isinstance(config, dict) else None
        if not isinstance(token, str) or not token:
            raise JinaV5NanoError("Jina v5 tokenizer_config has no pad_token")
        return token

    def _batch(self, texts: list[str]) -> tuple[Any, Any]:
        try:
            numpy = importlib.import_module("numpy")
        except ImportError as error:
            raise JinaV5NanoError("Jina v5 inference requires numpy") from error
        self._tokenizer.enable_truncation(max_length=MAX_TOKENS)
        # Each call is a single input. Disable padding saved in tokenizer.json
        # so a configured pad token cannot become the last attended token.
        self._tokenizer.no_padding()
        encoded = self._tokenizer.encode_batch(texts)
        if len(encoded) != len(texts):
            raise JinaV5NanoError("Jina v5 tokenizer returned an unexpected batch size")
        pad_id = self._tokenizer.token_to_id(self._padding_token())
        if not isinstance(pad_id, int) or pad_id < 0:
            raise JinaV5NanoError("Jina v5 tokenizer has no safe [PAD] token")
        ids = [list(item.ids) for item in encoded]
        if any(len(row) > MAX_TOKENS for row in ids):
            raise JinaV5NanoError("Jina v5 tokenizer ignored the 512-token cap")
        if any(not row for row in ids):
            raise JinaV5NanoError("Jina v5 tokenizer produced an empty input")
        width = max(len(row) for row in ids)
        attention = [[1] * len(row) + [0] * (width - len(row)) for row in ids]
        padded = [row + [pad_id] * (width - len(row)) for row in ids]
        return numpy.asarray(padded, dtype="int64"), numpy.asarray(attention, dtype="int64")

    def embed_many(self, texts: Iterable[str], *, purpose: str = "passage") -> list[list[float]]:
        """Embed documents or queries with invariant prefixes and last-token pooling."""
        if purpose not in {"query", "passage"}:
            raise JinaV5NanoError("Jina v5 purpose must be query or passage")
        values = list(texts)
        if not values or any(not isinstance(text, str) or not text.strip() for text in values):
            raise JinaV5NanoError("Jina v5 requires non-empty text inputs")
        self.load()
        prefix = QUERY_PREFIX if purpose == "query" else DOCUMENT_PREFIX
        result: list[list[float]] = []
        # Keep bounded per-request work: a caller cannot turn the 512-token
        # input cap into an unbounded giant inference batch.
        for text in values:
            input_ids, attention_mask = self._batch([prefix + text])
            outputs = self._session.run(None, {"input_ids": input_ids, "attention_mask": attention_mask})
            names = [entry.name for entry in self._session.get_outputs()]
            mapped = dict(zip(names, outputs))
            sentence = mapped.get("sentence_embedding")
            if sentence is not None:
                if tuple(getattr(sentence, "shape", ())) != (1, OUTPUT_DIMENSIONS):
                    raise JinaV5NanoError("Jina v5 sentence_embedding must have shape [batch, 768]")
                rows = [list(sentence[0])]
            else:
                hidden = mapped.get("last_hidden_state")
                if hidden is None:
                    hidden = mapped.get("token_embeddings")
                if hidden is None:
                    raise JinaV5NanoError("Jina v5 ONNX graph did not return hidden states for last-token pooling")
                rows = _last_token_pool(hidden, attention_mask)
            if len(rows) != 1:
                raise JinaV5NanoError("Jina v5 returned an unexpected output batch size")
            result.extend(_project_normalize(row, self.dimensions) for row in rows)
        return result

    def embed(self, text: str, *, purpose: str = "passage") -> list[float]:
        """Embed one input while preserving the same query/document invariant."""
        return self.embed_many([text], purpose=purpose)[0]
