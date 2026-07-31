"""Compare mtplx-embed against a running oMLX server.

The PLUR1BUS LanceDB tables hold vectors produced by oMLX. Switching the
embedding backend is only safe when the new vectors land in the same space, so
this check reports the cosine similarity per text and the rank agreement of the
reranker rather than asserting a fixed golden output.

Usage::

    python mtplx-embed/tests/parity_check.py \
        --omlx http://127.0.0.1:8000/v1 --sidecar http://127.0.0.1:18086/v1
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.request

SAMPLE_TEXTS = [
    "hallo welt",
    "The user prefers concise answers in German.",
    "LanceDB stores per-agent memory tables under the plur1bus data directory.",
    "Bernd hat am Dienstag den Termin beim Zahnarzt abgesagt.",
    "def embed(text): return model(tokenizer(text))",
]

SAMPLE_QUERY = "Wo liegen die Memory-Tabellen?"
SAMPLE_DOCUMENTS = [
    "LanceDB stores per-agent memory tables under the plur1bus data directory.",
    "The weather in Hamburg is rainy today.",
    "MTPLX performs multi-token prediction on Apple Silicon.",
    "Die Memory-Tabellen liegen im Datenverzeichnis des Agenten.",
]


def _post(url: str, payload: dict, timeout: float = 300.0) -> dict:
    """POST JSON to a local OpenAI-compatible endpoint and return the response."""
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer local", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _embed(base_url: str, model: str, texts: list[str]) -> list[list[float]]:
    payload = _post(
        f"{base_url.rstrip('/')}/embeddings",
        {"model": model, "input": texts, "encoding_format": "float"},
    )
    ordered = sorted(payload["data"], key=lambda item: int(item.get("index", 0)))
    return [[float(value) for value in item["embedding"]] for item in ordered]


def _rerank(base_url: str, model: str, query: str, documents: list[str]) -> list[int]:
    payload = _post(
        f"{base_url.rstrip('/')}/rerank",
        {
            "model": model,
            "query": query,
            "documents": documents,
            "top_n": len(documents),
            "return_documents": False,
        },
    )
    return [int(entry["index"]) for entry in payload["results"]]


def _cosine(left: list[float], right: list[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    return dot / (left_norm * right_norm)


def main(argv: list[str] | None = None) -> int:
    """Run the parity comparison and return a non-zero code when it degrades."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--omlx", default="http://127.0.0.1:8000/v1")
    parser.add_argument("--sidecar", default="http://127.0.0.1:18086/v1")
    parser.add_argument("--embedding-model", default="Qwen3-Embedding-8B-4bit-DWQ")
    parser.add_argument("--reranker-model", default="Qwen3-Reranker-4B-4bit-MLX")
    parser.add_argument("--threshold", type=float, default=0.99)
    args = parser.parse_args(argv)

    reference = _embed(args.omlx, args.embedding_model, SAMPLE_TEXTS)
    candidate = _embed(args.sidecar, args.embedding_model, SAMPLE_TEXTS)
    print(f"reference dimensions: {len(reference[0])}")
    print(f"candidate dimensions: {len(candidate[0])}")

    worst = 1.0
    for text, left, right in zip(SAMPLE_TEXTS, reference, candidate, strict=True):
        similarity = _cosine(left, right)
        worst = min(worst, similarity)
        print(f"cos={similarity:.6f}  {text[:60]!r}")

    reference_order = _rerank(args.omlx, args.reranker_model, SAMPLE_QUERY, SAMPLE_DOCUMENTS)
    candidate_order = _rerank(args.sidecar, args.reranker_model, SAMPLE_QUERY, SAMPLE_DOCUMENTS)
    print(f"rerank oMLX   : {reference_order}")
    print(f"rerank sidecar: {candidate_order}")

    print(f"\nworst cosine: {worst:.6f} (threshold {args.threshold})")
    print(f"rerank order identical: {reference_order == candidate_order}")
    return 0 if worst >= args.threshold else 1


if __name__ == "__main__":
    raise SystemExit(main())
