#!/usr/bin/env bash
# Install the optional Jina retrieval sidecar into $HERMES_HOME.
#
# Jina v5 models are CC-BY-NC-4.0. They are recommended for new stores but
# never downloaded or activated without an explicit acceptance.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home_arg=""
hermes_home=""
python_bin_arg=""
python_bin=""
install_agent=1
want_jina="${PLUR1BUS_INSTALL_JINA:-0}"
accept_license="${PLUR1BUS_ACCEPT_JINA_LICENSE:-0}"
non_interactive="${PLUR1BUS_NONINTERACTIVE:-0}"
skip_smoke=0
smoke_ok=0

usage() {
  printf 'Usage: %s [--hermes-home PATH] [--python PATH] [--jina] [--accept-jina-license] [--non-interactive] [--no-agent] [--no-smoke]\n' "$0" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hermes-home) hermes_home_arg="${2:?missing path after --hermes-home}"; shift 2 ;;
    --python) python_bin_arg="${2:?missing path after --python}"; shift 2 ;;
    --jina) want_jina=1; shift ;;
    --accept-jina-license) accept_license=1; shift ;;
    --non-interactive) non_interactive=1; shift ;;
    --no-agent) install_agent=0; skip_smoke=1; shift ;;
    --no-smoke) skip_smoke=1; shift ;;
    *) usage; exit 2 ;;
  esac
done

# Direct sidecar installation follows the same multi-instance selection as the
# full plugin installer and resolves before its first target write.
source "$repo_dir/scripts/lib/hermes-home.sh"
resolve_hermes_home "$hermes_home_arg" "$non_interactive"
hermes_home="$HERMES_HOME_RESOLVED"
export HERMES_HOME="$hermes_home"
if [[ -n "$python_bin_arg" ]]; then
  if [[ ! -x "$python_bin_arg" ]]; then
    printf 'Python from --python is not executable: %s\n' "$python_bin_arg" >&2
    exit 5
  fi
  python_bin="$python_bin_arg"
  printf 'Using Python from --python: %s\n' "$python_bin"
else
  resolve_hermes_python "$hermes_home" 1
  python_bin="$HERMES_PYTHON_RESOLVED"
fi

platform="$(uname -s)"
architecture="$(uname -m)"
printf 'mtplx-embed platform: os=%s arch=%s python=%s\n' "$platform" "$architecture" "$python_bin"
if ! "$python_bin" -c 'import sys, venv; assert sys.version_info >= (3, 10)' >/dev/null 2>&1; then
  printf 'Python 3.10+ with venv is unavailable in %s; leaving PLUR1BUS on local E5/BGE.\n' "$python_bin" >&2
  exit 0
fi

target="$hermes_home/mtplx-embed"
model_dir="$target/models"
install -d "$target" "$hermes_home/bin"
rsync -a --delete --exclude '__pycache__/' --exclude '*.pyc' \
  "$repo_dir/mtplx-embed/src/mtplx_embed/" "$target/mtplx_embed/"
install -m 0755 "$repo_dir/scripts/mtplx-embed" "$hermes_home/bin/mtplx-embed"
printf 'installed sidecar code to %s\n' "$target"

# Existing vectors are a separate embedding space. Never activate Jina over a
# populated store; migration/re-embedding must be an explicit workflow.
store_present="$($python_bin - "$hermes_home" <<'PY'
import json
import sys
from pathlib import Path

home = Path(sys.argv[1]).expanduser()
candidates = [home / "plur1bus"]
def add_config_candidate(path: Path) -> None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    value = raw.get("dataDir")
    if value:
        candidate = Path(str(value)).expanduser()
        candidates.append(candidate if candidate.is_absolute() else home / candidate)

add_config_candidate(home / "plugins" / "plur1bus" / "config.json")
try:
    for profile_dir in (home / "profiles").iterdir():
        if profile_dir.is_dir():
            add_config_candidate(profile_dir / "plugins" / "plur1bus" / "config.json")
except OSError:
    pass
for root in candidates:
    try:
        for directory in root.iterdir():
            if directory.is_dir() and directory.name.startswith("lancedb") and any(directory.iterdir()):
                print("1")
                raise SystemExit
    except OSError:
        continue
print("0")
PY
)"

if [[ "$platform" == MINGW* || "$platform" == MSYS* || "$platform" == CYGWIN* ]]; then
  printf 'Native Windows is not supported by this Bash installer; no Jina sidecar was started. PLUR1BUS remains on E5/BGE.\n' >&2
  exit 0
fi
if [[ "$store_present" == "1" ]]; then
  printf 'Existing LanceDB store detected; refusing automatic Jina/vector-space activation. PLUR1BUS remains on E5/BGE until an explicit migration.\n' >&2
  exit 0
fi

if [[ "$want_jina" != "1" && "$non_interactive" != "1" && -t 0 ]]; then
  cat >&2 <<'NOTICE'
Jina retrieval is recommended for a new empty PLUR1BUS store.
Models: jina-embeddings-v5-text-small and jina-reranker-v3.5
License: CC-BY-NC-4.0 (non-commercial use only).
Security: these models execute third-party repository code only at the pinned
revisions documented in mtplx-embed/README.md and mtplx_embed/models.py.
NOTICE
  read -r -p 'Download and enable Jina now? [y/N] ' answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] && want_jina=1
fi
if [[ "$want_jina" != "1" ]]; then
  printf 'Jina not selected; no model download and PLUR1BUS stays on local E5/BGE.\n'
  exit 0
fi
if [[ "$accept_license" != "1" && "$non_interactive" != "1" && -t 0 ]]; then
  cat >&2 <<'LICENSE'
Jina models are licensed under CC-BY-NC-4.0.
They may only be used under that licence, including its non-commercial restriction.
They include third-party model code executed only at the documented pinned revisions.
LICENSE
  read -r -p 'I have reviewed and accept CC-BY-NC-4.0 for these Jina models [y/N] ' license_answer
  [[ "$license_answer" == "y" || "$license_answer" == "Y" ]] && accept_license=1
fi
if [[ "$accept_license" != "1" ]]; then
  printf 'Jina was not installed: explicit CC-BY-NC-4.0 acceptance is required. Set --accept-jina-license (or PLUR1BUS_ACCEPT_JINA_LICENSE=1) after reviewing the license. Falling back to E5/BGE.\n' >&2
  exit 0
fi

venv_dir="$target/venv"
sidecar_python="$venv_dir/bin/python"
if [[ ! -x "$sidecar_python" ]]; then
  if ! "$python_bin" -m venv "$venv_dir"; then
    printf 'Could not create isolated sidecar venv at %s; leaving PLUR1BUS on local E5/BGE.\n' "$venv_dir" >&2
    exit 0
  fi
fi

backend="transformers"
if [[ "$platform" == "Darwin" && "$architecture" == "arm64" ]] && "$python_bin" -c 'import mlx, mlx_lm' >/dev/null 2>&1; then
  backend="mlx"
fi
printf 'Installing isolated %s Jina sidecar dependencies in %s...\n' "$backend" "$venv_dir"
if [[ "$backend" == "mlx" ]]; then
  sidecar_requirements=(fastapi uvicorn 'huggingface_hub>=0.24' safetensors mlx mlx-lm)
else
  sidecar_requirements=(fastapi uvicorn 'transformers>=4.57' 'torch>=2.8' 'peft>=0.15.2' 'safetensors>=0.4' 'huggingface_hub>=0.24')
fi
if ! "$sidecar_python" -m pip install "${sidecar_requirements[@]}"; then
  printf 'Could not install isolated Jina sidecar dependencies; leaving PLUR1BUS on local E5/BGE.\n' >&2
  exit 0
fi
printf 'Jina backend: %s (models load lazily and unload after idle)\n' "$backend"

if ! download_json="$(PYTHONPATH="$target${PYTHONPATH:+:$PYTHONPATH}" "$sidecar_python" -m mtplx_embed.installer download --model-dir "$model_dir" --backend "$backend")"; then
  printf 'Jina model download failed; central retrieval was not enabled. PLUR1BUS remains on E5/BGE.\n' >&2
  exit 0
fi
embedding_model="$(printf '%s' "$download_json" | "$sidecar_python" -c 'import json,sys; print(json.load(sys.stdin)["embedding"])')"
reranker_model="$(printf '%s' "$download_json" | "$sidecar_python" -c 'import json,sys; print(json.load(sys.stdin)["reranker"])')"

cat > "$target/service.env" <<EOF
MTPLX_EMBED_BACKEND=$backend
MTPLX_EMBEDDING_MODEL=$embedding_model
MTPLX_RERANKER_MODEL=$reranker_model
MTPLX_EMBED_MODEL_DIR=$model_dir
MTPLX_EMBED_IDLE_SECONDS=300
MTPLX_EMBED_PYTHON=$sidecar_python
EOF

port="${MTPLX_EMBED_PORT:-18086}"
env_file="$hermes_home/.env"
api_key="${MTPLX_EMBED_API_KEY:-}"
if [[ -z "$api_key" && -f "$env_file" ]]; then
  while IFS= read -r env_line || [[ -n "$env_line" ]]; do
    case "$env_line" in
      MTPLX_EMBED_API_KEY=*) api_key="${env_line#*=}"; break ;;
    esac
  done < "$env_file"
fi
api_key="${api_key:-mtplx-local}"

if [[ "$install_agent" != "1" ]]; then
  printf 'Jina code and models are installed, but no service was started; central retrieval was not enabled. PLUR1BUS remains on E5/BGE.\n'
  exit 0
fi
if [[ "$platform" == "Linux" ]] && (! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1); then
  printf 'Linux user-systemd is unavailable; sidecar was not started and PLUR1BUS remains on E5/BGE.\n' >&2
  exit 0
fi

# Keep the service and the central Hermes route on one key without printing it.
install -d "$hermes_home"
env_tmp="$(mktemp "$hermes_home/.env.mtplx-embed.XXXXXX")"
if [[ -f "$env_file" ]]; then
  awk '!/^MTPLX_EMBED_API_KEY=/' "$env_file" > "$env_tmp"
fi
printf 'MTPLX_EMBED_API_KEY=%s\n' "$api_key" >> "$env_tmp"
chmod 600 "$env_tmp"
mv "$env_tmp" "$env_file"

if ! HERMES_HOME="$hermes_home" MTPLX_EMBED_LAUNCHER="$hermes_home/bin/mtplx-embed" MTPLX_EMBED_PORT="$port" MTPLX_EMBED_API_KEY="$api_key" \
  "$repo_dir/scripts/install-mtplx-embed-agent.sh"; then
  printf 'Jina sidecar service could not be started; central retrieval was not enabled. PLUR1BUS remains on E5/BGE.\n' >&2
  exit 0
fi

if [[ "$skip_smoke" == "1" ]]; then
  printf 'Jina sidecar smoke was skipped; central retrieval was not enabled. PLUR1BUS remains on E5/BGE.\n'
  exit 0
fi
for _ in $(seq 1 30); do
  if PYTHONPATH="$target${PYTHONPATH:+:$PYTHONPATH}" "$sidecar_python" -m mtplx_embed.installer smoke --base-url "http://127.0.0.1:$port/v1" --embedding-model "$embedding_model" --reranker-model "$reranker_model" --api-key "$api_key"; then
    smoke_ok=1
    break
  fi
  sleep 2
done
if [[ "$smoke_ok" != "1" ]]; then
  printf 'Jina sidecar smoke failed; central retrieval was not enabled. PLUR1BUS remains on E5/BGE. See %s/logs/mtplx-embed.log\n' "$hermes_home" >&2
  exit 0
fi

if command -v hermes >/dev/null 2>&1; then
  if ! {
    HERMES_HOME="$hermes_home" hermes config set retrieval.embeddings.provider omlx &&
    HERMES_HOME="$hermes_home" hermes config set retrieval.embeddings.base_url "http://127.0.0.1:$port/v1" &&
    HERMES_HOME="$hermes_home" hermes config set retrieval.embeddings.model "$embedding_model" &&
    HERMES_HOME="$hermes_home" hermes config set retrieval.embeddings.dimensions 1024 &&
    HERMES_HOME="$hermes_home" hermes config set retrieval.embeddings.api_key_env MTPLX_EMBED_API_KEY &&
    HERMES_HOME="$hermes_home" hermes config set retrieval.rerank.provider omlx &&
    HERMES_HOME="$hermes_home" hermes config set retrieval.rerank.base_url "http://127.0.0.1:$port/v1" &&
    HERMES_HOME="$hermes_home" hermes config set retrieval.rerank.model "$reranker_model" &&
    HERMES_HOME="$hermes_home" hermes config set retrieval.rerank.api_key_env MTPLX_EMBED_API_KEY
  }; then
    printf 'Hermes retrieval configuration could not be written; central retrieval was not activated. PLUR1BUS remains on E5/BGE.\n' >&2
    exit 1
  fi
  # The gateway inherited its environment at process start. Restart it only
  # after the sidecar smoke and central declaration both succeed so the new
  # MTPLX_EMBED_API_KEY is available to the live PLUR1BUS provider.
  if ! HERMES_HOME="$hermes_home" hermes gateway restart; then
    printf 'Hermes retrieval configuration was written, but the Hermes gateway reload failed; central retrieval was not activated. Restart it with: HERMES_HOME="%s" hermes gateway restart\n' "$hermes_home" >&2
    exit 1
  fi
  printf 'central Hermes retrieval declaration enabled after smoke success and gateway reload.\n'
else
  printf 'Hermes CLI not found; Jina sidecar is installed but not activated. PLUR1BUS remains on E5/BGE.\n' >&2
fi
