# mtplx-embed

Optional, provider-independent retrieval sidecar for Hermes/PLUR1BUS.

## Why this exists

MTPLX is a multi-token-prediction decoder for causal chat models. Its
OpenAI-compatible server exposes `/v1/chat/completions`, `/v1/completions`,
`/v1/messages` and `/v1/models` — there is no `/v1/embeddings` and no
`/v1/rerank`, and MTP draft heads have no meaning for an embedding model. So a
Hermes agent whose chat provider is MTPLX has no retrieval backend of its own,
and PLUR1BUS memory would keep depending on a second general-purpose inference
server staying alive.

This sidecar closes that gap without treating a chat endpoint as retrieval. On
Apple Silicon with a working MLX runtime it uses Jina's MLX checkpoints; on
other compatible platforms it uses the official Transformers/Safetensors Jina
checkpoints through `transformers`.

| Endpoint | Model | Notes |
| --- | --- | --- |
| `POST /v1/embeddings` | Jina v5 text small | 1024-dim, L2-normalised |
| `POST /v1/rerank` | Jina reranker v3.5 | Cohere/Jina response shape |
| `GET /v1/models` | — | both models, short ids |
| `GET /health` | — | liveness plus which models are resident |

## Store safety

Jina vectors are 1024-dimensional and are not a drop-in replacement for an
existing vector space. The installer detects populated LanceDB directories and
does not download, declare, or activate Jina for them. Use an explicit
re-embedding migration before changing an existing store.

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

## Full installation

```bash
scripts/install-hermes-plugins.sh
# Review the CC-BY-NC-4.0 notice, then opt in explicitly:
scripts/install-hermes-plugins.sh --jina --accept-jina-license
# CI:
PLUR1BUS_INSTALL_JINA=1 PLUR1BUS_ACCEPT_JINA_LICENSE=1 PLUR1BUS_NONINTERACTIVE=1 \
  scripts/install-hermes-plugins.sh --hermes-home /path/to/hermes-home
```

Before any files are copied, the full and direct sidecar installers use the
same Hermes-home resolver. `--hermes-home` has highest precedence, then an
exported `HERMES_HOME`; otherwise known local Hermes installations are
discovered. A single installation is selected automatically. Multiple homes
require a numbered interactive choice, while noninteractive zero/ambiguous
selection exits nonzero and requires an explicit path. Hermes profiles within
one home are not treated as separate installations.
The selected home's `hermes-agent/venv` is also the default bootstrap runtime;
`MTPLX_EMBED_PYTHON` and then `HERMES_PYTHON` are explicit overrides. Sidecar
dependencies themselves remain isolated in `$HERMES_HOME/mtplx-embed/venv`.

Jina is recommended for a new, empty PLUR1BUS store but is never installed by
default. Both models are **CC-BY-NC-4.0** and require explicit acceptance.
Without it, on native Windows, after a failed smoke test, or with an existing
LanceDB store, no Jina route is activated and PLUR1BUS stays on local E5/BGE.
The installed code and stable model cache live under `$HERMES_HOME/mtplx-embed`.
macOS installs a LaunchAgent; Linux uses user-systemd when available, otherwise
prints a controlled manual-start fallback.

## Run manually

```bash
scripts/mtplx-embed --port 18086 --preload
```

Models load lazily and unload after 300 seconds idle. The installer activates
the central Hermes `retrieval` declaration only after `/v1/models`, a normalized
1024-dimension embedding, and a plausible rerank ordering all pass.

## Authentication

When `MTPLX_EMBED_API_KEY` is set in the sidecar's environment, `/v1/*` requires
that bearer token; unset means loopback-only trust, matching how the local oMLX
and MTPLX servers treat 127.0.0.1 clients. The LaunchAgent sets it.

## Hermes retrieval declaration

The installer writes the central `retrieval` section in Hermes `config.yaml`
after a successful smoke test; it never creates a PLUR1BUS-specific port copy.

```json
{
  "retrieval": {
    "embeddings": {
      "provider": "omlx",
      "base_url": "http://127.0.0.1:18086/v1",
      "api_key_env": "MTPLX_EMBED_API_KEY",
      "model": "jina-embeddings-v5-text-small",
      "dimensions": 1024
    },
    "rerank": {
      "provider": "omlx",
      "base_url": "http://127.0.0.1:18086/v1",
      "api_key_env": "MTPLX_EMBED_API_KEY",
      "model": "jina-reranker-v3.5"
    }
  }
}
```

`provider: "omlx"` selects the plugin's *local OpenAI-compatible* transport, not
the oMLX server specifically — `baseUrl` decides which server answers. That
transport is also the only one PLUR1BUS batches embeddings over;
`openai-compatible` would issue one request per text.

The adapter retains local E5/BGE as the safe fallback when this declaration is
absent or its service is unavailable.
