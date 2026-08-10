#!/usr/bin/env bash
# Bind one Hermes home (root or a profile under ~/.hermes/profiles/<name>) to
# MTPLX chat. PLUR1BUS resolves retrieval from declared Hermes capabilities;
# this script must not leave a separate, stale PLUR1BUS endpoint copy behind.
#
# Idempotent — safe to re-run after a model change. Every file it rewrites is
# backed up next to the original first.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
chat_port="${MTPLX_PORT:-18085}"
api_key="${MTPLX_API_KEY:-mtplx-local}"
model=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hermes-home) hermes_home="${2:?missing path after --hermes-home}"; shift 2 ;;
    --model) model="${2:?missing model after --model}"; shift 2 ;;
    *)
      printf 'Usage: %s [--hermes-home PATH] [--model SERVED_ID]\n' "$0" >&2
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

# 3. Chat model configuration.
HERMES_HOME="$hermes_home" hermes config set model.provider mtplx >/dev/null
HERMES_HOME="$hermes_home" hermes config set model.base_url "http://127.0.0.1:$chat_port/v1" >/dev/null
HERMES_HOME="$hermes_home" hermes config set model.default "$model" >/dev/null
HERMES_HOME="$hermes_home" hermes config set model.api_mode chat_completions >/dev/null

printf 'bound %s -> MTPLX model=%s\n' "$hermes_home" "$model"
