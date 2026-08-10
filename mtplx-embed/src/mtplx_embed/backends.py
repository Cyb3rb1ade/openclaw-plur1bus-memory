"""MLX backends for Qwen3 embedding and Qwen3 reranking on Apple Silicon.

Both Qwen3 retrieval models are causal LMs, so the backends here run the
transformer stack directly instead of going through a generation loop:

* the embedder reads the final hidden state of the last real token
  (Qwen3-Embedding appends ``<|endoftext|>`` and pools that position) and
  L2-normalises it, which is what the reference implementation does;
* the reranker builds the official yes/no judging prompt and takes a softmax
  over the ``yes``/``no`` logits at the last real position.

Batches are padded on the right. With causal attention a real token never
attends to a later pad token, so right padding leaves every real position
bit-identical to the unpadded run — which left padding would not.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

try:  # Keep the sidecar importable on non-Apple platforms.
    import mlx.core as mx
    from mlx_lm import load
except ImportError:  # pragma: no cover - exercised by the portable backend
    mx = None  # type: ignore[assignment]
    load = None  # type: ignore[assignment]

DEFAULT_EMBEDDING_MODEL = "mlx-community/Qwen3-Embedding-8B-4bit-DWQ"
DEFAULT_RERANKER_MODEL = "vserifsaglam/Qwen3-Reranker-4B-4bit-MLX"
# jina ships MLX inference code inside the checkpoint. Both are CC-BY-NC-4.0,
# so they are offered, never defaulted to.
DEFAULT_JINA_EMBEDDING_MODEL = "jinaai/jina-embeddings-v5-text-small-mlx"
DEFAULT_JINA_RERANKER_MODEL = "jinaai/jina-reranker-v3.5-mlx"

DEFAULT_EMBEDDING_MAX_TOKENS = 8192
DEFAULT_RERANKER_MAX_TOKENS = 8192

EMBEDDING_EOD_TOKEN = "<|endoftext|>"
EMBEDDING_QUERY_TEMPLATE = "Instruct: {instruction}\nQuery: {text}"

RERANKER_SYSTEM_PROMPT = (
    "Judge whether the Document meets the requirements based on the Query "
    'and the Instruct provided. Note that the answer can only be "yes" or "no".'
)
RERANKER_PREFIX = (
    f"<|im_start|>system\n{RERANKER_SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\n"
)
RERANKER_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
RERANKER_DEFAULT_INSTRUCTION = (
    "Given a web search query, retrieve relevant passages that answer the query"
)


def _resolve_model_path(reference: str, search_dirs: tuple[Path, ...]) -> str:
    """Return a local model directory when one exists, else the raw reference.

    ``mlx_lm.load`` accepts either a filesystem path or a Hugging Face repo id;
    resolving locally first keeps the sidecar usable offline.
    """
    candidate = Path(reference).expanduser()
    if candidate.is_dir():
        return str(candidate)
    for directory in search_dirs:
        local = directory.expanduser() / reference
        if local.is_dir():
            return str(local)
    return reference


def model_alias(reference: str) -> str:
    """Return the short model id clients may use instead of the full reference."""
    return reference.rstrip("/").rsplit("/", 1)[-1]


def matches_model(requested: str, reference: str) -> bool:
    """Report whether a client-supplied model id addresses this backend."""
    if not requested:
        return True
    return requested in {reference, model_alias(reference)} or model_alias(
        requested
    ) == model_alias(reference)


class _MlxModel:
    """Lazily loaded MLX model guarded by a single-flight lock.

    MLX evaluates lazily on a shared default stream; serialising forward passes
    keeps peak memory bounded and avoids interleaved graph evaluation when
    several HTTP requests arrive at once.
    """

    def __init__(self, reference: str, search_dirs: tuple[Path, ...]) -> None:
        self.reference = reference
        self.path = _resolve_model_path(reference, search_dirs)
        self.lock = threading.RLock()
        self._model: Any = None
        self._tokenizer: Any = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def ensure_loaded(self) -> tuple[Any, Any]:
        with self.lock:
            if self._model is None:
                if load is None:
                    raise RuntimeError("MLX is unavailable; choose the transformers Jina backend")
                self._model, self._tokenizer = load(self.path)
            return self._model, self._tokenizer

    def unload(self) -> None:
        """Release the checkpoint after the sidecar has been idle."""
        with self.lock:
            self._model = None
            self._tokenizer = None
            if mx is not None:
                mx.clear_cache()


def _padded_batch(sequences: list[list[int]], pad_id: int) -> tuple[mx.array, list[int]]:
    """Right-pad token sequences into one array plus their true lengths."""
    lengths = [len(sequence) for sequence in sequences]
    width = max(lengths)
    padded = [sequence + [pad_id] * (width - len(sequence)) for sequence in sequences]
    return mx.array(padded), lengths


class Qwen3Embedder:
    """Qwen3-Embedding backend returning L2-normalised 4096-dim vectors."""

    def __init__(
        self,
        reference: str = DEFAULT_EMBEDDING_MODEL,
        *,
        search_dirs: tuple[Path, ...] = (),
        max_tokens: int = DEFAULT_EMBEDDING_MAX_TOKENS,
        batch_size: int = 8,
    ) -> None:
        self._backend = _MlxModel(reference, search_dirs)
        self.max_tokens = max(16, int(max_tokens))
        self.batch_size = max(1, int(batch_size))
        self._dimensions: int | None = None

    @property
    def reference(self) -> str:
        return self._backend.reference

    @property
    def loaded(self) -> bool:
        return self._backend.loaded

    @property
    def dimensions(self) -> int | None:
        """Return the vector width once it is known without forcing a load."""
        return self._dimensions

    def warmup(self) -> int:
        """Load the model and return its embedding dimensionality."""
        vector = self.embed(["warmup"])[0]
        return len(vector)

    def unload(self) -> None:
        self._backend.unload()

    def _encode(self, tokenizer: Any, text: str) -> list[int]:
        eod_id = tokenizer.convert_tokens_to_ids(EMBEDDING_EOD_TOKEN)
        ids = tokenizer.encode(text, add_special_tokens=False)
        ids = ids[: self.max_tokens - 1]
        ids.append(eod_id)
        return ids

    def embed(self, texts: list[str], *, instruction: str | None = None) -> list[list[float]]:
        """Embed texts in input order, optionally with a query instruction."""
        if not texts:
            return []
        model, tokenizer = self._backend.ensure_loaded()
        prepared = [
            EMBEDDING_QUERY_TEMPLATE.format(instruction=instruction, text=text)
            if instruction
            else text
            for text in texts
        ]
        pad_id = tokenizer.convert_tokens_to_ids(EMBEDDING_EOD_TOKEN)
        vectors: list[list[float]] = []
        with self._backend.lock:
            for start in range(0, len(prepared), self.batch_size):
                chunk = prepared[start : start + self.batch_size]
                sequences = [self._encode(tokenizer, text) for text in chunk]
                inputs, lengths = _padded_batch(sequences, pad_id)
                hidden = model.model(inputs)
                pooled = mx.stack(
                    [hidden[row, length - 1, :] for row, length in enumerate(lengths)]
                ).astype(mx.float32)
                normalised = pooled / mx.linalg.norm(pooled, axis=-1, keepdims=True)
                mx.eval(normalised)
                vectors.extend(normalised.tolist())
                del hidden, pooled, normalised
                mx.clear_cache()
        if vectors:
            self._dimensions = len(vectors[0])
        return vectors


def _load_sibling_module(directory: Path, filename: str, name: str) -> Any:
    """Import a module that ships beside a checkpoint, without touching sys.path.

    jina distributes its MLX inference code inside the model repository. Loading
    it by file location keeps it out of the global module namespace, so two
    checkpoints that both ship a ``model.py`` cannot shadow each other.
    """
    import importlib.util

    path = Path(directory) / filename
    if not path.is_file():
        raise FileNotFoundError(f"{filename} not found in {directory}")
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class JinaV5Embedder:
    """jina-embeddings-v5 backend using the model's own asymmetric task types.

    Qwen3-Embedding expresses the query/passage asymmetry through an instruction
    prefix; jina expresses it by swapping a LoRA adapter. The interface here is
    the same either way — an instruction means "this is a question" — so callers
    and the HTTP layer do not need to know which model is serving.

    The model repository ships its own ``model.py``/``utils.py``; ``load_model``
    already resolves ``model.py`` by file location, so only ``utils`` has to be
    imported here.
    """

    def __init__(
        self,
        reference: str = DEFAULT_JINA_EMBEDDING_MODEL,
        *,
        search_dirs: tuple[Path, ...] = (),
        batch_size: int = 32,
    ) -> None:
        self.reference = reference
        self.path = _resolve_model_path(reference, search_dirs)
        self.batch_size = max(1, int(batch_size))
        self.lock = threading.RLock()
        self._model: Any = None
        self._dimensions: int | None = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def dimensions(self) -> int | None:
        return self._dimensions

    def ensure_loaded(self) -> Any:
        with self.lock:
            if self._model is None:
                utils = _load_sibling_module(Path(self.path), "utils.py", "jina_v5_utils")
                model = utils.load_model(str(self.path))
                model.switch_task("retrieval")
                self._model = model
            return self._model

    def warmup(self) -> int:
        return len(self.embed(["warmup"])[0])

    def unload(self) -> None:
        with self.lock:
            self._model = None
            if mx is not None:
                mx.clear_cache()

    def embed(self, texts: list[str], *, instruction: str | None = None) -> list[list[float]]:
        """Embed texts in input order, as questions when an instruction is given.

        The instruction text itself is unused: jina encodes the distinction in
        the adapter rather than in the prompt. Passing one still selects the
        query adapter, which keeps the contract identical to the Qwen3 backend.
        """
        if not texts:
            return []
        model = self.ensure_loaded()
        task_type = "retrieval.query" if instruction else "retrieval.passage"
        vectors: list[list[float]] = []
        with self.lock:
            for start in range(0, len(texts), self.batch_size):
                chunk = texts[start : start + self.batch_size]
                encoded = model.encode(chunk, task_type=task_type)
                # encode() returns bfloat16 arrays, which numpy and json both
                # refuse; cast before anything tries to read them.
                stacked = encoded if isinstance(encoded, mx.array) else mx.stack(list(encoded))
                pooled = stacked.astype(mx.float32)
                normalised = pooled / mx.linalg.norm(pooled, axis=-1, keepdims=True)
                mx.eval(normalised)
                vectors.extend(normalised.tolist())
                del encoded, stacked, pooled, normalised
                mx.clear_cache()
        if vectors:
            self._dimensions = len(vectors[0])
        return vectors


class Qwen3Reranker:
    """Qwen3-Reranker backend scoring query/document pairs with yes-vs-no logits."""

    def __init__(
        self,
        reference: str = DEFAULT_RERANKER_MODEL,
        *,
        search_dirs: tuple[Path, ...] = (),
        max_tokens: int = DEFAULT_RERANKER_MAX_TOKENS,
        batch_size: int = 4,
    ) -> None:
        self._backend = _MlxModel(reference, search_dirs)
        self.max_tokens = max(64, int(max_tokens))
        self.batch_size = max(1, int(batch_size))

    @property
    def reference(self) -> str:
        return self._backend.reference

    @property
    def loaded(self) -> bool:
        return self._backend.loaded

    def warmup(self) -> None:
        """Load the model by scoring one throwaway pair."""
        self.score("warmup", ["warmup"])

    def unload(self) -> None:
        self._backend.unload()

    def _encode(self, tokenizer: Any, query: str, document: str, instruction: str) -> list[int]:
        prefix = tokenizer.encode(RERANKER_PREFIX, add_special_tokens=False)
        suffix = tokenizer.encode(RERANKER_SUFFIX, add_special_tokens=False)
        body = tokenizer.encode(
            f"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {document}",
            add_special_tokens=False,
        )
        budget = self.max_tokens - len(prefix) - len(suffix)
        return prefix + body[:budget] + suffix

    def score(
        self,
        query: str,
        documents: list[str],
        *,
        instruction: str = RERANKER_DEFAULT_INSTRUCTION,
    ) -> list[float]:
        """Return a relevance probability in [0, 1] per document, in input order."""
        if not documents:
            return []
        model, tokenizer = self._backend.ensure_loaded()
        yes_id = tokenizer.convert_tokens_to_ids("yes")
        no_id = tokenizer.convert_tokens_to_ids("no")
        pad_id = tokenizer.convert_tokens_to_ids(EMBEDDING_EOD_TOKEN)
        scores: list[float] = []
        with self._backend.lock:
            for start in range(0, len(documents), self.batch_size):
                chunk = documents[start : start + self.batch_size]
                sequences = [
                    self._encode(tokenizer, query, document, instruction)
                    for document in chunk
                ]
                inputs, lengths = _padded_batch(sequences, pad_id)
                logits = model(inputs)
                pairs = mx.stack(
                    [
                        mx.stack(
                            [
                                logits[row, length - 1, no_id],
                                logits[row, length - 1, yes_id],
                            ]
                        )
                        for row, length in enumerate(lengths)
                    ]
                )
                probabilities = mx.softmax(pairs.astype(mx.float32), axis=-1)[:, 1]
                mx.eval(probabilities)
                scores.extend(float(value) for value in probabilities.tolist())
                del logits, pairs, probabilities
                mx.clear_cache()
        return scores


class JinaReranker:
    """jina-reranker-v3.5 backend, scoring a whole candidate list in one pass.

    Qwen3-Reranker judges one query/document pair per row, so a batch of N
    candidates costs N sequences. jina is listwise: the query and up to
    ``block_size`` documents share a single forward pass, which is why a wide
    candidate window becomes affordable — measured on real recalls, 50
    candidates took ~1.0 s here against ~18.7 s for the Qwen3 4B.

    ``score`` returns probabilities in input order so it is a drop-in for
    :class:`Qwen3Reranker`; the model's own API returns them sorted.
    """

    def __init__(
        self,
        reference: str = DEFAULT_JINA_RERANKER_MODEL,
        *,
        search_dirs: tuple[Path, ...] = (),
    ) -> None:
        self.reference = reference
        self.path = _resolve_model_path(reference, search_dirs)
        self.lock = threading.RLock()
        self._model: Any = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def ensure_loaded(self) -> Any:
        with self.lock:
            if self._model is None:
                import sys

                directory = Path(self.path)
                # rerank.py does `import modeling`, a bare name that only
                # resolves if the checkpoint directory is importable. Registering
                # the module under that name first satisfies it without putting
                # the directory on sys.path, where it would shadow anything else
                # called `modeling`.
                modeling = _load_sibling_module(directory, "modeling.py", "modeling")
                previous = sys.modules.get("modeling")
                sys.modules["modeling"] = modeling
                try:
                    rerank_module = _load_sibling_module(
                        directory, "rerank.py", "jina_v35_rerank"
                    )
                finally:
                    if previous is None:
                        sys.modules.pop("modeling", None)
                    else:
                        sys.modules["modeling"] = previous
                self._model = rerank_module.MLXReranker(str(directory))
            return self._model

    def warmup(self) -> None:
        """Load the model by scoring one throwaway pair."""
        self.score("warmup", ["warmup"])

    def unload(self) -> None:
        with self.lock:
            self._model = None
            if mx is not None:
                mx.clear_cache()

    def score(
        self,
        query: str,
        documents: list[str],
        *,
        instruction: str = RERANKER_DEFAULT_INSTRUCTION,
    ) -> list[float]:
        """Return a relevance probability per document, in input order.

        ``instruction`` is accepted for interface parity and ignored: jina
        encodes the ranking task in its projector head rather than in a prompt.
        """
        if not documents:
            return []
        model = self.ensure_loaded()
        scores = [0.0] * len(documents)
        with self.lock:
            results = model.rerank(query, documents)
        for entry in results:
            scores[int(entry["index"])] = float(entry["relevance_score"])
        return scores


def _normalise_rows(value: Any) -> list[list[float]]:
    """Convert a torch/numpy/list embedding response to unit Python vectors."""
    if hasattr(value, "detach"):
        value = value.detach().float().cpu().tolist()
    elif hasattr(value, "tolist"):
        value = value.tolist()
    rows = value if isinstance(value, list) and value and isinstance(value[0], list) else [value]
    normalised: list[list[float]] = []
    for row in rows:
        numbers = [float(item) for item in row]
        magnitude = sum(item * item for item in numbers) ** 0.5
        if not numbers or magnitude == 0:
            raise RuntimeError("Jina embedding backend returned an empty or zero vector")
        normalised.append([item / magnitude for item in numbers])
    return normalised


class JinaTransformersEmbedder:
    """Portable official Jina Transformers/Safetensors embedding backend."""

    def __init__(self, reference: str, *, search_dirs: tuple[Path, ...] = (), batch_size: int = 32) -> None:
        self.reference = reference
        self.path = _resolve_model_path(reference, search_dirs)
        self.batch_size = max(1, int(batch_size))
        self.lock = threading.RLock()
        self._model: Any = None
        self._dimensions: int | None = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def dimensions(self) -> int | None:
        return self._dimensions

    def ensure_loaded(self) -> Any:
        with self.lock:
            if self._model is None:
                try:
                    from transformers import AutoModel
                except ImportError as error:
                    raise RuntimeError("portable Jina requires transformers, torch, and safetensors") from error
                model = AutoModel.from_pretrained(self.path, trust_remote_code=True)
                if hasattr(model, "eval"):
                    model.eval()
                self._model = model
            return self._model

    def warmup(self) -> int:
        return len(self.embed(["warmup"])[0])

    def unload(self) -> None:
        with self.lock:
            self._model = None
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass

    def embed(self, texts: list[str], *, instruction: str | None = None) -> list[list[float]]:
        if not texts:
            return []
        model = self.ensure_loaded()
        prompt_name = "query" if instruction else "document"
        with self.lock:
            encoded = model.encode(texts=texts, task="retrieval", prompt_name=prompt_name)
        vectors = _normalise_rows(encoded)
        self._dimensions = len(vectors[0])
        return vectors


class JinaTransformersReranker:
    """Portable official Jina Transformers/Safetensors reranking backend."""

    def __init__(self, reference: str, *, search_dirs: tuple[Path, ...] = ()) -> None:
        self.reference = reference
        self.path = _resolve_model_path(reference, search_dirs)
        self.lock = threading.RLock()
        self._model: Any = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def ensure_loaded(self) -> Any:
        with self.lock:
            if self._model is None:
                try:
                    from transformers import AutoModel
                except ImportError as error:
                    raise RuntimeError("portable Jina requires transformers, torch, and safetensors") from error
                model = AutoModel.from_pretrained(self.path, trust_remote_code=True)
                if hasattr(model, "eval"):
                    model.eval()
                self._model = model
            return self._model

    def warmup(self) -> None:
        self.score("warmup", ["warmup"])

    def unload(self) -> None:
        with self.lock:
            self._model = None
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass

    def score(self, query: str, documents: list[str], *, instruction: str = RERANKER_DEFAULT_INSTRUCTION) -> list[float]:
        del instruction
        if not documents:
            return []
        model = self.ensure_loaded()
        with self.lock:
            results = model.rerank(query, documents)
        if isinstance(results, dict):
            results = results.get("results", results.get("data", []))
        scores = [0.0] * len(documents)
        for entry in results:
            if not isinstance(entry, dict):
                continue
            index = entry.get("index")
            if isinstance(index, int) and 0 <= index < len(scores):
                scores[index] = float(entry.get("relevance_score", entry.get("score", 0.0)))
        if not any(scores):
            raise RuntimeError("Jina reranker returned no usable scores")
        return scores


def build_embedder(
    reference: str,
    *,
    search_dirs: tuple[Path, ...] = (),
    max_tokens: int = DEFAULT_EMBEDDING_MAX_TOKENS,
    batch_size: int = 8,
    backend: str = "auto",
) -> Any:
    """Pick the embedding backend a checkpoint needs.

    Detection reads the checkpoint rather than its name: a repository that
    ships its own ``model.py``/``utils.py`` carries a loader ``mlx_lm.load``
    cannot use, so a renamed or vendored copy is still recognised.
    """
    if backend == "transformers":
        return JinaTransformersEmbedder(reference, search_dirs=search_dirs, batch_size=batch_size)
    if backend not in {"auto", "mlx"}:
        raise ValueError(f"unsupported embedding backend: {backend}")
    directory = Path(_resolve_model_path(reference, search_dirs))
    if (directory / "utils.py").is_file() and (directory / "model.py").is_file():
        return JinaV5Embedder(reference, search_dirs=search_dirs, batch_size=batch_size)
    return Qwen3Embedder(
        reference,
        search_dirs=search_dirs,
        max_tokens=max_tokens,
        batch_size=batch_size,
    )


def build_reranker(
    reference: str,
    *,
    search_dirs: tuple[Path, ...] = (),
    max_tokens: int = DEFAULT_RERANKER_MAX_TOKENS,
    batch_size: int = 4,
    backend: str = "auto",
) -> Any:
    """Pick the reranking backend a checkpoint needs.

    A projector head beside ``rerank.py`` means the scores come from a ranking
    head rather than from ``yes``/``no`` logits, which is what separates the
    listwise jina reranker from the Qwen3 pairwise one.
    """
    if backend == "transformers":
        return JinaTransformersReranker(reference, search_dirs=search_dirs)
    if backend not in {"auto", "mlx"}:
        raise ValueError(f"unsupported reranking backend: {backend}")
    directory = Path(_resolve_model_path(reference, search_dirs))
    if (directory / "rerank.py").is_file() and (directory / "projector.safetensors").is_file():
        return JinaReranker(reference, search_dirs=search_dirs)
    return Qwen3Reranker(
        reference,
        search_dirs=search_dirs,
        max_tokens=max_tokens,
        batch_size=batch_size,
    )
