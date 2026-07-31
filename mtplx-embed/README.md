# mtplx-embed

Qwen3 embedding and reranking sidecar for the MTPLX inference stack.

## Why this exists

MTPLX is a multi-token-prediction decoder for causal chat models. Its
OpenAI-compatible server exposes `/v1/chat/completions`, `/v1/completions`,
`/v1/messages` and `/v1/models` — there is no `/v1/embeddings` and no
`/v1/rerank`, and MTP draft heads have no meaning for an embedding model. So a
Hermes agent whose chat provider is MTPLX has no retrieval backend of its own,
and PLUR1BUS memory would keep depending on a second general-purpose inference
server staying alive.

This sidecar closes that gap with the same two Qwen3 models the PLUR1BUS memory
already uses, so the MTPLX stack is self-sufficient.

| Endpoint | Model | Notes |
| --- | --- | --- |
| `POST /v1/embeddings` | `mlx-community/Qwen3-Embedding-8B-4bit-DWQ` | 4096-dim, L2-normalised |
| `POST /v1/rerank` | `vserifsaglam/Qwen3-Reranker-4B-4bit-MLX` | Cohere/Jina response shape |
| `GET /v1/models` | — | both models, short ids |
| `GET /health` | — | liveness plus which models are resident |

## Vector parity

The existing LanceDB tables hold vectors produced by oMLX, so the sidecar has to
land in the same vector space or recall degrades silently. Measured with
`tests/parity_check.py` against a live oMLX server:

- worst-case cosine similarity across the sample texts: **0.9998**
- reranker ordering: **identical**

That is drop-in — no re-embedding of existing memory is required. Rerun the
check after any model or pooling change:

```bash
"$HOME/Library/Application Support/MTPLX/runtime-venv/bin/python" \
  mtplx-embed/tests/parity_check.py
```

## How the models are run

Both Qwen3 retrieval models are causal LMs, so the backends run the transformer
stack directly instead of using a generation loop:

- **Embedding** — append `<|endoftext|>`, take the final hidden state at that
  position, cast to float32, L2-normalise. This is what the reference
  implementation does; pooling in bf16 costs about 4e-3 of vector norm accuracy.
- **Reranking** — build the official yes/no judging prompt and take a softmax
  over the `yes` and `no` logits at the last real position.

Batches are padded on the **right**. With causal attention a real token never
attends to a later pad token, so right padding leaves every real position
bit-identical to the unpadded run — left padding would corrupt it.

## Install

```bash
scripts/install-mtplx-embed.sh          # copy into $HERMES_HOME + LaunchAgent
scripts/install-mtplx-embed.sh --no-agent
scripts/install-mtplx-embed-agent.sh --uninstall
```

The installed copy lives at `$HERMES_HOME/mtplx-embed` with its launcher at
`$HERMES_HOME/bin/mtplx-embed`, deliberately **outside `~/Documents`**: a
LaunchAgent runs without Full Disk Access and macOS TCC denies it execute
access there (the job fails with exit code 126).

No dependency install is needed — the launcher uses the MTPLX runtime venv,
which already provides `mlx-lm`, FastAPI and uvicorn. Override with
`MTPLX_PYTHON` or `MTPLX_EMBED_PYTHON`.

## Run manually

```bash
scripts/mtplx-embed --port 18086 --preload
```

Models load lazily by default, so an idle sidecar costs an interpreter process
rather than model memory. `--preload` trades that for a warm first request.

## Authentication

When `MTPLX_EMBED_API_KEY` is set in the sidecar's environment, `/v1/*` requires
that bearer token; unset means loopback-only trust, matching how the local oMLX
and MTPLX servers treat 127.0.0.1 clients. The LaunchAgent sets it.

## PLUR1BUS memory wiring

`$HERMES_HOME/plugins/plur1bus/config.json`:

```json
{
  "embedding": {
    "provider": "omlx",
    "baseUrl": "http://127.0.0.1:18086/v1",
    "apiKeyEnv": "MTPLX_EMBED_API_KEY",
    "model": "Qwen3-Embedding-8B-4bit-DWQ",
    "dimensions": 4096,
    "fallback": {
      "provider": "omlx",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKeyEnv": "OMLX_API_KEY",
      "model": "Qwen3-Embedding-8B-4bit-DWQ",
      "dimensions": 4096
    }
  },
  "reranker": {
    "provider": "omlx",
    "baseUrl": "http://127.0.0.1:18086/v1",
    "apiKeyEnv": "MTPLX_EMBED_API_KEY",
    "model": "Qwen3-Reranker-4B-4bit-MLX",
    "fallbackProvider": "local-transformers",
    "fallbackModel": "BAAI/bge-reranker-v2-m3"
  }
}
```

`provider: "omlx"` selects the plugin's *local OpenAI-compatible* transport, not
the oMLX server specifically — `baseUrl` decides which server answers. That
transport is also the only one PLUR1BUS batches embeddings over;
`openai-compatible` would issue one request per text.

The `fallback` block keeps recall working when the sidecar is down. It is
dimension-checked, so a mismatched fallback fails loudly instead of writing
vectors from the wrong space.
