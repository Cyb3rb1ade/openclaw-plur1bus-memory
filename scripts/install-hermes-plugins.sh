#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
run_setup=1
install_deps=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hermes-home)
      hermes_home="${2:?missing path after --hermes-home}"
      shift 2
      ;;
    --no-setup)
      run_setup=0
      shift
      ;;
    --no-deps)
      install_deps=0
      shift
      ;;
    *)
      printf 'Usage: %s [--hermes-home PATH] [--no-setup] [--no-deps]\n' "$0" >&2
      exit 2
      ;;
  esac
done

memory_target="$hermes_home/plugins/plur1bus"
controls_target="$hermes_home/plugins/plur1bus-controls"
omlx_target="$hermes_home/plugins/model-providers/omlx"
vmlx_target="$hermes_home/plugins/model-providers/vmlx"
mtplx_target="$hermes_home/plugins/model-providers/mtplx"
bin_target="$hermes_home/bin"
install -d "$memory_target" "$controls_target" "$omlx_target" "$vmlx_target" "$mtplx_target" "$bin_target"
rsync -a --exclude '__pycache__/' --exclude '*.pyc' "$repo_dir/plur1bus-hermes/src/plur1bus_hermes/" "$memory_target/"
rsync -a --exclude '__pycache__/' --exclude '*.pyc' "$repo_dir/plur1bus-controls/src/plur1bus_controls/" "$controls_target/"
rsync -a --delete --exclude '__pycache__/' --exclude '*.pyc' "$repo_dir/hermes-model-providers/omlx/" "$omlx_target/"
rsync -a --delete --exclude '__pycache__/' --exclude '*.pyc' "$repo_dir/hermes-model-providers/vmlx/" "$vmlx_target/"
rsync -a --delete --exclude '__pycache__/' --exclude '*.pyc' "$repo_dir/hermes-model-providers/mtplx/" "$mtplx_target/"
install -m 0755 "$repo_dir/scripts/run-hermes-workspace-migration-job.sh" "$bin_target/"
install -m 0755 "$repo_dir/scripts/mtplx-hermes-up" "$bin_target/"

if [[ "$install_deps" == "1" ]]; then
  "${HERMES_PYTHON:-python3}" -m pip install --disable-pip-version-check "$repo_dir/plur1bus-hermes"
fi

if [[ "$run_setup" == "1" && -x "$(command -v hermes || true)" ]]; then
  HERMES_HOME="$hermes_home" hermes memory setup
  HERMES_HOME="$hermes_home" hermes config set memory.provider plur1bus
  HERMES_HOME="$hermes_home" hermes config set memory.memory_enabled false
  HERMES_HOME="$hermes_home" hermes config set memory.user_profile_enabled true
  HERMES_HOME="$hermes_home" hermes plugins enable plur1bus-controls || \
    printf 'Warning: enable controls manually with: HERMES_HOME="%s" hermes plugins enable plur1bus-controls\n' "$hermes_home" >&2
else
  cat <<EOF
Run the native setup wizard to choose local or remote embeddings, reranking,
and to store optional API keys safely in $hermes_home/.env:
  HERMES_HOME="$hermes_home" hermes memory setup
EOF
fi

cat <<EOF
Installed PLUR1BUS Hermes plugins:
  $memory_target
  $controls_target
  $omlx_target
  $vmlx_target
  $mtplx_target

Configure Hermes with:
  memory.provider: plur1bus
  memory.memory_enabled: false
  memory.user_profile_enabled: true
  plugins.enabled: [plur1bus-controls]

To configure Hermes's primary LLM through oMLX:
  $repo_dir/scripts/configure-hermes-omlx.sh --model MODEL_ID

After a completed OpenClaw workspace migration, preview profile activation with:
  plur1bus-hermes-cutover TARGET

Apply the gated profile cutover and restart Hermes with:
  plur1bus-hermes-cutover TARGET --apply --restart

EOF
