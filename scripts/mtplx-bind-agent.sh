#!/usr/bin/env bash
# Bind one Hermes home (root or a profile under ~/.hermes/profiles/<name>) to
# MTPLX: chat, the internal memory LLM, embeddings and reranking all come from
# the one daemon, with oMLX left only as an embedding fallback.
#
# Idempotent — safe to re-run after a model change. Every file it rewrites is
# backed up next to the original first.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
chat_port="${MTPLX_PORT:-18085}"
# MTPLX serves /v1/embeddings and /v1/rerank itself, so retrieval points at
# the chat port by default. Override only for a separate retrieval daemon.
embed_port="${MTPLX_EMBED_PORT:-$chat_port}"
api_key="${MTPLX_API_KEY:-mtplx-local}"
embed_api_key="${MTPLX_EMBED_API_KEY:-mtplx-local}"
# Explicit rather than inferred from the previous value: deriving the fallback
# from whatever baseUrl happened to be there before silently pinned it to a
# decommissioned service twice. oMLX is the only other local server that speaks
# /v1/embeddings; set empty to drop the fallback entirely.
fallback_url="${MTPLX_EMBED_FALLBACK_URL-http://127.0.0.1:8000/v1}"
model=""
# PLUR1BUS' internal LLM does mechanical JSON transforms under a hard 30s
# timeout. MTPLX serves one large reasoning model, which spends that budget
# thinking and returns nothing usable — and because capture runs on a single
# worker, each 30s stall backs up the whole queue. An unset model makes
# `available()` false, so the tiered analysis drops to tier 2 instantly.
# Pass --internal-llm <served-id> only for a model that is fast and non-thinking.
internal_llm="${MTPLX_INTERNAL_LLM:-off}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hermes-home) hermes_home="${2:?missing path after --hermes-home}"; shift 2 ;;
    --model) model="${2:?missing model after --model}"; shift 2 ;;
    --internal-llm) internal_llm="${2:?missing model after --internal-llm}"; shift 2 ;;
    --fallback-url) fallback_url="${2-}"; shift 2 ;;
    *)
      printf 'Usage: %s [--hermes-home PATH] [--model SERVED_ID] [--internal-llm off|SERVED_ID]\n' "$0" >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$hermes_home" ]]; then
  printf 'no Hermes home at %s\n' "$hermes_home" >&2
  exit 1
fi

# Ask the daemon which model id it actually serves rather than guessing: the
# served id is derived from the artifact and does not match the HF repo name.
if [[ -z "$model" ]]; then
  model="$(curl -fsS -m 5 -H "Authorization: Bearer $api_key" \
    "http://127.0.0.1:$chat_port/v1/models" \
    | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin)["data"][0]["id"])')"
fi

stamp="$(date +%Y%m%d-%H%M%S)"

# 1. Provider plugin, so `mtplx` resolves inside this home.
provider_target="$hermes_home/plugins/model-providers/mtplx"
install -d "$provider_target"
rsync -a --delete --exclude '__pycache__/' --exclude '*.pyc' \
  "$repo_dir/hermes-model-providers/mtplx/" "$provider_target/"

# 2. Credentials for this home's .env.
env_file="$hermes_home/.env"
if [[ -f "$env_file" ]]; then
  cp "$env_file" "$env_file.bak-mtplx-$stamp"
else
  touch "$env_file"
fi
grep -q '^MTPLX_API_KEY=' "$env_file" || printf 'MTPLX_API_KEY=%s\n' "$api_key" >> "$env_file"
grep -q '^MTPLX_EMBED_API_KEY=' "$env_file" || printf 'MTPLX_EMBED_API_KEY=%s\n' "$embed_api_key" >> "$env_file"

# 3. Chat model configuration.
HERMES_HOME="$hermes_home" hermes config set model.provider mtplx >/dev/null
HERMES_HOME="$hermes_home" hermes config set model.base_url "http://127.0.0.1:$chat_port/v1" >/dev/null
HERMES_HOME="$hermes_home" hermes config set model.default "$model" >/dev/null
HERMES_HOME="$hermes_home" hermes config set model.api_mode chat_completions >/dev/null

# 4. PLUR1BUS memory backends, when this home has its own plugin config.
memory_config="$hermes_home/plugins/plur1bus/config.json"
if [[ -f "$memory_config" ]]; then
  cp "$memory_config" "$memory_config.bak-mtplx-$stamp"
  MTPLX_EMBED_URL="http://127.0.0.1:$embed_port/v1" \
  MTPLX_CHAT_URL="http://127.0.0.1:$chat_port/v1" \
  MTPLX_MODEL="$model" \
  MTPLX_CHAT_KEY="$api_key" \
  MTPLX_INTERNAL_LLM="$internal_llm" \
  MTPLX_EMBED_FALLBACK="$fallback_url" \
  /usr/bin/python3 - "$memory_config" <<'PY'
import json
import os
import sys

path = sys.argv[1]
embed_url = os.environ["MTPLX_EMBED_URL"]
chat_url = os.environ["MTPLX_CHAT_URL"]
model = os.environ["MTPLX_MODEL"]
chat_key = os.environ["MTPLX_CHAT_KEY"]

with open(path, encoding="utf-8") as handle:
    config = json.load(handle)

# "omlx" is the plugin's transport name for a local OpenAI-compatible server —
# baseUrl decides which one answers, and MTPLX speaks the same shapes. It is
# also the only transport PLUR1BUS batches embeddings over, so keep it.
fallback_url = os.environ.get("MTPLX_EMBED_FALLBACK", "").strip()

embedding = dict(config.get("embedding") or {})
dimensions = int(embedding.get("dimensions") or 4096)
embedding.update(
    {
        "provider": "omlx",
        "baseUrl": embed_url,
        "apiKeyEnv": "MTPLX_EMBED_API_KEY",
        "dimensions": dimensions,
    }
)
# A fallback pointing at the primary is worse than none: it cannot help when
# the primary is what went down, and it hides the outage.
if fallback_url and fallback_url.rstrip("/") != embed_url.rstrip("/"):
    embedding["fallback"] = {
        "provider": "omlx",
        "baseUrl": fallback_url,
        "apiKeyEnv": "OMLX_API_KEY",
        "model": embedding.get("model", "Qwen3-Embedding-8B-4bit-DWQ"),
        "dimensions": dimensions,
    }
else:
    embedding.pop("fallback", None)
config["embedding"] = embedding

reranker = dict(config.get("reranker") or {})
reranker.update(
    {
        "provider": "omlx",
        "baseUrl": embed_url,
        "apiKeyEnv": "MTPLX_EMBED_API_KEY",
    }
)
config["reranker"] = reranker

# The internal LLM backend reads a literal apiKey, not apiKeyEnv, and clamps
# its timeout at 30s.
internal_llm = os.environ["MTPLX_INTERNAL_LLM"]
llm = dict(config.get("llm") or {})
llm.update(
    {
        "provider": "omlx",
        "baseUrl": chat_url,
        "apiKey": chat_key,
        "timeoutSeconds": 30,
        # An empty model makes InternalLlmBackend.available() false, so the
        # tiered analysis skips the network call entirely instead of stalling
        # for the full timeout on every capture.
        "model": "" if internal_llm == "off" else internal_llm,
    }
)
if internal_llm != "off":
    # The backend's built-in 300-token budget predates reasoning models: the
    # chain-of-thought alone exhausts it, so the response is cut off before any
    # JSON appears and every call fails as invalid. Raising the ceiling costs
    # nothing when the model stops on its own.
    llm["requestExtra"] = {"max_tokens": 2000}
else:
    llm.pop("requestExtra", None)
config["llm"] = llm

with open(path, "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
  printf '  memory backends repointed (%s)\n' "$(basename "$(dirname "$memory_config")")"
fi

printf 'bound %s -> MTPLX model=%s\n' "$hermes_home" "$model"
