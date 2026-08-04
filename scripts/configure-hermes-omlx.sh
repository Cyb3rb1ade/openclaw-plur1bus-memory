#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
base_url="http://127.0.0.1:8000/v1"
model=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hermes-home) hermes_home="${2:?missing path after --hermes-home}"; shift 2 ;;
    --base-url) base_url="${2:?missing URL after --base-url}"; shift 2 ;;
    --model) model="${2:?missing model after --model}"; shift 2 ;;
    *) printf 'Usage: %s --model MODEL [--hermes-home PATH] [--base-url URL]\n' "$0" >&2; exit 2 ;;
  esac
done

if [[ -z "$model" ]]; then
  printf '%s\n' '--model is required; choose an ID returned by oMLX /v1/models.' >&2
  exit 2
fi

env_file="$hermes_home/.env"
install -d -m 700 "$hermes_home"
omlx_provider_target="$hermes_home/plugins/model-providers/omlx"
install -d "$omlx_provider_target"
/bin/cp -X -f \
  "$repo_dir/hermes-model-providers/omlx/__init__.py" \
  "$omlx_provider_target/__init__.py"
/bin/cp -X -f \
  "$repo_dir/hermes-model-providers/omlx/plugin.yaml" \
  "$omlx_provider_target/plugin.yaml"
touch "$env_file"
chmod 600 "$env_file"
if ! rg -q '^OMLX_API_KEY=' "$env_file"; then
  printf 'OMLX_API_KEY=local\n' >> "$env_file"
fi

HERMES_HOME="$hermes_home" hermes config set model.provider omlx
HERMES_HOME="$hermes_home" hermes config set model.default "$model"
HERMES_HOME="$hermes_home" hermes config set model.base_url "$base_url"
HERMES_HOME="$hermes_home" hermes config set model.api_mode chat_completions

cat <<EOF
Hermes now uses oMLX for its primary LLM:
  provider: omlx
  base URL: $base_url
  model:    $model

OMLX_API_KEY is stored in $env_file with mode 0600. Replace its local default
if your oMLX server requires a different credential. PLUR1BUS uses the same
variable for its oMLX embedding and reranking backends.
EOF
