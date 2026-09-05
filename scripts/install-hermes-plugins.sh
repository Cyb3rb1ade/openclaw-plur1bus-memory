#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home_arg=""
hermes_home=""
hermes_python=""
run_setup=1
install_deps=1
install_retrieval=1
install_dashboard=0
install_desktop=0
install_model_providers=1
retrieval_args=()
non_interactive="${PLUR1BUS_NONINTERACTIVE:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hermes-home)
      hermes_home_arg="${2:?missing path after --hermes-home}"
      shift 2
      ;;
    --no-setup)
      run_setup=0
      shift
      ;;
    --dashboard)
      install_dashboard=1
      shift
      ;;
    --desktop)
      install_desktop=1
      install_dashboard=1
      shift
      ;;
    --no-deps)
      install_deps=0
      shift
      ;;
    --no-retrieval)
      install_retrieval=0
      shift
      ;;
    --no-model-providers)
      install_model_providers=0
      shift
      ;;
    --non-interactive)
      non_interactive=1
      retrieval_args+=("$1")
      shift
      ;;
    --jina|--accept-jina-license|--no-agent|--no-smoke)
      retrieval_args+=("$1")
      shift
      ;;
    *)
      printf 'Usage: %s [--hermes-home PATH] [--dashboard|--desktop] [--no-setup] [--no-deps] [--no-retrieval] [--no-model-providers] [--jina --accept-jina-license] [--non-interactive]\n' "$0" >&2
      exit 2
      ;;
  esac
done

# Resolve before creating plugin directories or installing dependencies.
source "$repo_dir/scripts/lib/hermes-home.sh"
resolve_hermes_home "$hermes_home_arg" "$non_interactive"
hermes_home="$HERMES_HOME_RESOLVED"
export HERMES_HOME="$hermes_home"
if [[ "$install_deps" == "1" || "$install_retrieval" == "1" || "$install_dashboard" == "1" ]]; then
  resolve_hermes_python "$hermes_home" 0
  hermes_python="$HERMES_PYTHON_RESOLVED"
fi
if [[ "$install_dashboard" == "1" && "$install_deps" == "0" ]]; then
  if ! "$hermes_python" -c 'import plur1bus_hermes, fastapi' >/dev/null 2>&1; then
    printf 'Dashboard needs plur1bus-hermes and the Hermes dashboard dependencies in the selected interpreter; omit --no-deps.\n' >&2
    exit 4
  fi
fi

memory_target="$hermes_home/plugins/plur1bus"
desktop_target="$hermes_home/desktop-plugins/plur1bus"
if [[ "$install_desktop" == "1" ]]; then
  if [[ -L "$hermes_home/desktop-plugins" || -L "$desktop_target" || -L "$desktop_target/plugin.js" ]]; then
    printf 'Refusing symbolic-link desktop plugin destination.\n' >&2
    exit 4
  fi
fi
controls_target="$hermes_home/plugins/plur1bus-controls"
omlx_target="$hermes_home/plugins/model-providers/omlx"
vmlx_target="$hermes_home/plugins/model-providers/vmlx"
mtplx_target="$hermes_home/plugins/model-providers/mtplx"
bin_target="$hermes_home/bin"
install -d "$memory_target" "$controls_target" "$bin_target"
# npm tarballs normalize timestamps. Equal-size edits must still replace old code.
rsync -ac --exclude '__pycache__/' --exclude '*.pyc' --exclude '* 2.*' "$repo_dir/plur1bus-hermes/src/plur1bus_hermes/" "$memory_target/"
rsync -ac --exclude '__pycache__/' --exclude '*.pyc' --exclude '* 2.*' "$repo_dir/plur1bus-controls/src/plur1bus_controls/" "$controls_target/"
if [[ "$install_model_providers" == "1" ]]; then
  install -d "$omlx_target" "$vmlx_target" "$mtplx_target"
  rsync -ac --delete --exclude '__pycache__/' --exclude '*.pyc' --exclude '* 2.*' "$repo_dir/hermes-model-providers/omlx/" "$omlx_target/"
  rsync -ac --delete --exclude '__pycache__/' --exclude '*.pyc' --exclude '* 2.*' "$repo_dir/hermes-model-providers/vmlx/" "$vmlx_target/"
  rsync -ac --delete --exclude '__pycache__/' --exclude '*.pyc' --exclude '* 2.*' "$repo_dir/hermes-model-providers/mtplx/" "$mtplx_target/"
else
  printf 'Skipped model-provider plugins (--no-model-providers); existing omlx, vmlx, and mtplx code was preserved.\n'
fi
install -m 0755 "$repo_dir/scripts/run-hermes-workspace-migration-job.sh" "$bin_target/"
install -m 0755 "$repo_dir/scripts/mtplx-hermes-up" "$bin_target/"

# Dashboard installation is opt-in and never touches memory data or config.
if [[ "$install_dashboard" == "1" ]]; then
  dashboard_target="$memory_target/dashboard"
  if [[ -L "$hermes_home/plugins" || -L "$memory_target" || -L "$dashboard_target" ]]; then
    printf 'Refusing symbolic-link dashboard destination.\n' >&2
    exit 4
  fi
  install -d "$dashboard_target"
  rsync -ac --exclude '__pycache__/' --exclude '*.pyc' "$repo_dir/hermes-dashboard/plur1bus/dashboard/" "$dashboard_target/"
fi

if [[ "$install_deps" == "1" ]]; then
  "$hermes_python" -m pip install --disable-pip-version-check "$repo_dir/plur1bus-hermes" "$repo_dir/plur1bus-controls"
fi

if [[ "$install_desktop" == "1" ]]; then
  install -d "$desktop_target"
  install -m 0644 "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$desktop_target/plugin.js"
  printf 'Installed native PLUR1BUS Desktop entry; open PLUR1BUS in the bottom status bar or command palette.\n'
  printf 'Restart Hermes Desktop to load backend updates. The frontend uses a native workspace tab, not the contributed route cache.\n'
fi

if [[ "$install_retrieval" == "1" ]]; then
  # The retrieval sidecar is optional: its failure must never skip the main
  # plugin activation below. Degrade to a warning; local E5/BGE stays active.
  if [[ "${#retrieval_args[@]}" -gt 0 ]]; then
    HERMES_HOME="$hermes_home" HERMES_PYTHON="$hermes_python" \
      "$repo_dir/scripts/install-mtplx-embed.sh" --hermes-home "$hermes_home" "${retrieval_args[@]}" || \
      printf 'Warning: optional retrieval sidecar failed; continuing without it (local E5/BGE remains active).\n' >&2
  else
    HERMES_HOME="$hermes_home" HERMES_PYTHON="$hermes_python" \
      "$repo_dir/scripts/install-mtplx-embed.sh" --hermes-home "$hermes_home" || \
      printf 'Warning: optional retrieval sidecar failed; continuing without it (local E5/BGE remains active).\n' >&2
  fi
fi

if [[ "$run_setup" == "1" && -x "$(command -v hermes || true)" ]]; then
  HERMES_HOME="$hermes_home" hermes config set memory.provider plur1bus
  HERMES_HOME="$hermes_home" hermes config set memory.memory_enabled false
  HERMES_HOME="$hermes_home" hermes config set memory.user_profile_enabled true
  HERMES_HOME="$hermes_home" hermes plugins enable plur1bus-controls || \
    printf 'Warning: enable controls manually with: HERMES_HOME="%s" hermes plugins enable plur1bus-controls\n' "$hermes_home" >&2
  if [[ "$install_dashboard" == "1" ]]; then
    HERMES_HOME="$hermes_home" hermes plugins enable plur1bus || \
      printf 'Warning: enable dashboard backend manually: HERMES_HOME="%s" hermes plugins enable plur1bus\n' "$hermes_home" >&2
  fi
else
  cat <<EOF
PLUR1BUS resolves retrieval from the active Hermes provider automatically.
To activate it after Hermes is available:
  HERMES_HOME="$hermes_home" hermes config set memory.provider plur1bus
  HERMES_HOME="$hermes_home" hermes config set memory.memory_enabled false
  HERMES_HOME="$hermes_home" hermes plugins enable plur1bus-controls
EOF
fi

if [[ "$install_dashboard" == "1" ]]; then
  printf 'Dashboard backend requires: HERMES_HOME="%s" hermes plugins enable plur1bus; restart the dashboard server after installation.\n' "$hermes_home"
fi

cat <<EOF
Installed PLUR1BUS Hermes plugins:
  $memory_target
  $controls_target
EOF

if [[ "$install_model_providers" == "1" ]]; then
  cat <<EOF
  $omlx_target
  $vmlx_target
  $mtplx_target
EOF
else
  printf '  model providers: skipped (--no-model-providers; existing code preserved)\n'
fi

cat <<EOF

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
