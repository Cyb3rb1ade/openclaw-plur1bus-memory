#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home_arg=""
hermes_home=""
hermes_python=""
run_setup=1
install_deps=1
install_retrieval=1
check_dashboard=0
install_desktop=0
desktop_all_profiles=0
desktop_host_source=""
selected_profiles=("default")
profiles_explicit=0
install_model_providers=1
retrieval_args=()
non_interactive="${PLUR1BUS_NONINTERACTIVE:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hermes-home)
      hermes_home_arg="${2:?missing path after --hermes-home}"
      shift 2
      ;;
    --profile)
      if [[ "$profiles_explicit" == "0" ]]; then selected_profiles=(); profiles_explicit=1; fi
      selected_profiles+=("${2:?missing name after --profile}")
      shift 2
      ;;
    --activate)
      run_setup=1
      shift
      ;;
    --no-setup|--no-activate)
      run_setup=0
      shift
      ;;
    --dashboard)
      check_dashboard=1
      shift
      ;;
    --desktop)
      install_desktop=1
      check_dashboard=1
      shift
      ;;
    --desktop-host-source)
      desktop_host_source="${2:?missing path after --desktop-host-source}"
      shift 2
      ;;
    --desktop-all-profiles)
      install_desktop=1
      check_dashboard=1
      desktop_all_profiles=1
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
      printf 'Usage: %s [--hermes-home PATH] [--profile default|all|NAME (repeatable)] [--dashboard|--desktop|--desktop-all-profiles] [--desktop-host-source PATH] [--activate|--no-setup|--no-activate] [--no-deps] [--no-retrieval] [--no-model-providers] [--jina --accept-jina-license] [--non-interactive]\n' "$0" >&2
      exit 2
      ;;
  esac
done

if [[ -n "$desktop_host_source" && "$install_desktop" != "1" ]]; then
  printf '%s\n' '--desktop-host-source requires --desktop or --desktop-all-profiles.' >&2
  exit 2
fi

# Resolve before creating plugin directories or installing dependencies.
source "$repo_dir/scripts/lib/hermes-home.sh"
resolve_hermes_home "$hermes_home_arg" "$non_interactive"
hermes_home="$HERMES_HOME_RESOLVED"
export HERMES_HOME="$hermes_home"
if [[ "${selected_profiles[*]}" == "all" ]]; then
  if [[ -L "$hermes_home/profiles" ]]; then
    printf 'Refusing symbolic-link profiles directory.\n' >&2
    exit 4
  fi
  selected_profiles=("default")
  for profile_home in "$hermes_home"/profiles/*; do
    [[ -d "$profile_home" && -f "$profile_home/config.yaml" ]] || continue
    selected_profiles+=("${profile_home##*/}")
  done
fi
selected_homes=()
default_selected=0
for profile_name in "${selected_profiles[@]}"; do
  if [[ "$profile_name" == "all" || ! "$profile_name" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    printf 'Invalid profile selection: %s (all cannot be combined with names).\n' "$profile_name" >&2
    exit 4
  fi
  profile_home="$hermes_home"
  [[ "$profile_name" != "default" ]] || default_selected=1
  if [[ "$profile_name" != "default" ]]; then
    profile_home="$hermes_home/profiles/$profile_name"
    if [[ -L "$hermes_home/profiles" || -L "$profile_home" || -L "$profile_home/config.yaml" || ! -f "$profile_home/config.yaml" ]]; then
      printf 'Expected an existing, non-symlink Hermes profile: %s\n' "$profile_name" >&2
      exit 4
    fi
  fi
  # Validate all selected destinations before any plugin synchronization.
  for relative in plugins plugins/plur1bus plugins/plur1bus-controls plugins/plur1bus/desktop plugins/plur1bus/desktop/plugin.js; do
    if [[ -L "$profile_home/$relative" ]]; then
      printf 'Refusing symbolic-link plugin destination: %s\n' "$profile_home/$relative" >&2
      exit 4
    fi
  done
  if [[ -L "$profile_home/plugins/plur1bus/dashboard" ]]; then
    printf 'Refusing symbolic-link dashboard destination.\n' >&2
    exit 4
  fi
  if [[ "$install_model_providers" == "1" ]]; then
    for relative in plugins/model-providers plugins/model-providers/omlx plugins/model-providers/vmlx plugins/model-providers/mtplx; do
      if [[ -L "$profile_home/$relative" ]]; then
        printf 'Refusing symbolic-link model-provider destination: %s\n' "$profile_home/$relative" >&2
        exit 4
      fi
    done
  fi
  selected_homes+=("$profile_home")
done
if [[ "$default_selected" == "0" && "$install_retrieval" == "1" ]]; then
  printf 'Skipped optional root retrieval setup for a named-profile-only selection; existing retrieval is preserved.\n'
  install_retrieval=0
fi
if [[ "$run_setup" == "0" && "$install_retrieval" == "1" ]]; then
  printf 'Skipped optional retrieval setup with --no-setup / --no-activate; profile configuration is preserved.\n'
  install_retrieval=0
fi
if [[ "$install_retrieval" == "1" && -f "$hermes_home/active_profile" ]]; then
  active_profile="$(<"$hermes_home/active_profile")"
  if [[ -n "$active_profile" && "$active_profile" != "default" ]]; then
    # The optional sidecar's own CLI calls do not yet pin --profile default.
    printf 'Skipped optional root retrieval setup while a named profile is sticky-active; existing retrieval is preserved.\n'
    install_retrieval=0
  fi
fi
desktop_source="$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js"
dashboard_source="$repo_dir/hermes-dashboard/plur1bus/dashboard"
if [[ ! -f "$desktop_source" || -L "$desktop_source" ]]; then
  printf 'PLUR1BUS desktop plugin source is missing or redirected: %s\n' "$desktop_source" >&2
  exit 4
fi
if [[ ! -f "$dashboard_source/manifest.json" || ! -f "$dashboard_source/plugin_api.py" || -L "$dashboard_source" ]]; then
  printf 'PLUR1BUS dashboard backend source is missing or redirected: %s\n' "$dashboard_source" >&2
  exit 4
fi
if [[ "$install_deps" == "1" || "$install_retrieval" == "1" || "$check_dashboard" == "1" ]]; then
  resolve_hermes_python "$hermes_home" 0
  hermes_python="$HERMES_PYTHON_RESOLVED"
fi
if [[ "$check_dashboard" == "1" && "$install_deps" == "0" ]]; then
  if ! "$hermes_python" -c 'import plur1bus_hermes, fastapi' >/dev/null 2>&1; then
    printf 'Dashboard needs plur1bus-hermes and the Hermes dashboard dependencies in the selected interpreter; omit --no-deps.\n' >&2
    exit 4
  fi
fi

memory_target="$hermes_home/plugins/plur1bus"
desktop_target="$hermes_home/desktop-plugins/plur1bus"
desktop_homes=("${selected_homes[@]}")
# Hermes Desktop owns one app-wide root entry. Refresh an existing copy even
# during a named-profile-only upgrade, or it masks the new unified package.
if [[ "$default_selected" == "0" && ( -d "$hermes_home/desktop-plugins/plur1bus" || -L "$hermes_home/desktop-plugins/plur1bus" ) ]]; then
  desktop_homes+=("$hermes_home")
fi
refresh_shared_unified=0
shared_unified="$hermes_home/plugins/plur1bus/desktop/plugin.js"
if [[ "$default_selected" == "0" && ( -e "$shared_unified" || -L "$shared_unified" ) ]]; then
  # Reconciliation chooses the default home's unified package first. Keep its
  # existing UI current so a marked root entry cannot revert on the next launch.
  for relative in plugins plugins/plur1bus plugins/plur1bus/desktop plugins/plur1bus/desktop/plugin.js; do
    if [[ -L "$hermes_home/$relative" ]]; then
      printf 'Refusing symbolic-link shared desktop source: %s\n' "$hermes_home/$relative" >&2
      exit 4
    fi
  done
  [[ -f "$shared_unified" ]] || { printf 'Shared desktop source is not a regular file.\n' >&2; exit 4; }
  refresh_shared_unified=1
fi
if [[ "$desktop_all_profiles" == "1" ]]; then
  if [[ "$(basename "$(dirname "$hermes_home")")" == "profiles" || -L "$hermes_home/profiles" ]]; then
    printf 'All-profile Desktop installation requires an explicit root home with a non-symlink profiles directory.\n' >&2
    exit 4
  fi
  for profile_home in "$hermes_home"/profiles/*; do
    [[ -d "$profile_home" && -f "$profile_home/config.yaml" ]] || continue
    if [[ -L "$profile_home" || -L "$profile_home/config.yaml" ]]; then
      printf 'Refusing symbolic-link profile destination.\n' >&2
      exit 4
    fi
    already_selected=0
    for selected_home in "${desktop_homes[@]}"; do
      [[ "$selected_home" != "$profile_home" ]] || already_selected=1
    done
    [[ "$already_selected" == "1" ]] || desktop_homes+=("$profile_home")
  done
fi
if [[ "$install_desktop" == "1" ]]; then
  if [[ -L "$hermes_home/bin" || -L "$hermes_home/bin/plur1bus-desktop-host.py" || -L "$hermes_home/bin/plur1bus-host-patches" ]]; then
    printf 'Refusing symbolic-link host-helper destination.\n' >&2
    exit 4
  fi
  for host_patch in "$hermes_home/bin/plur1bus-host-patches/"*.patch; do
    if [[ -L "$host_patch" ]]; then printf 'Refusing symbolic-link host patch.\n' >&2; exit 4; fi
  done
fi
for desktop_home in "${desktop_homes[@]}"; do
  desktop_target="$desktop_home/desktop-plugins/plur1bus"
  [[ "$install_desktop" == "1" || -d "$desktop_target" || -L "$desktop_target" ]] || continue
  if [[ -L "$desktop_home/desktop-plugins" || -L "$desktop_target" || -L "$desktop_target/plugin.js" || -L "$desktop_target/.hermes-package.json" ]]; then
    printf 'Refusing symbolic-link desktop plugin destination.\n' >&2
    exit 4
  fi
  if [[ -e "$desktop_target/plugin.js" && ! -f "$desktop_target/plugin.js" ]]; then
    printf 'Desktop plugin destination is not a regular file.\n' >&2
    exit 4
  fi
  if [[ -e "$desktop_target/.hermes-package.json" && ! -f "$desktop_target/.hermes-package.json" ]]; then
    printf 'Desktop materialization marker is not a regular file.\n' >&2
    exit 4
  fi
done
controls_target="$hermes_home/plugins/plur1bus-controls"
bin_target="$hermes_home/bin"
install -d "$bin_target"
for selected_home in "${selected_homes[@]}"; do
  memory_target="$selected_home/plugins/plur1bus"
  controls_target="$selected_home/plugins/plur1bus-controls"
  install -d "$memory_target/desktop" "$controls_target"
  # npm tarballs normalize timestamps. Equal-size edits must still replace old code.
  rsync -ac --exclude '__pycache__/' --exclude '*.pyc' --exclude '* 2.*' "$repo_dir/plur1bus-hermes/src/plur1bus_hermes/" "$memory_target/"
  rsync -ac --exclude '__pycache__/' --exclude '*.pyc' --exclude '* 2.*' "$repo_dir/plur1bus-controls/src/plur1bus_controls/" "$controls_target/"
  # This unified package half is discovered by modern Hermes Desktop. The
  # --desktop switch additionally installs the legacy materialized entry.
  install -m 0644 "$desktop_source" "$memory_target/desktop/plugin.js"
  # The unified UI needs its backend in the same selected profile package.
  install -d "$memory_target/dashboard"
  rsync -ac --exclude '__pycache__/' --exclude '*.pyc' "$dashboard_source/" "$memory_target/dashboard/"
  if [[ "$install_model_providers" == "1" ]]; then
    for provider in omlx vmlx mtplx; do
      provider_target="$selected_home/plugins/model-providers/$provider"
      install -d "$provider_target"
      rsync -ac --delete --exclude '__pycache__/' --exclude '*.pyc' --exclude '* 2.*' "$repo_dir/hermes-model-providers/$provider/" "$provider_target/"
    done
  fi
done
if [[ "$install_model_providers" == "0" ]]; then
  printf 'Skipped model-provider plugins (--no-model-providers); existing omlx, vmlx, and mtplx code was preserved.\n'
fi
install -m 0755 "$repo_dir/scripts/run-hermes-workspace-migration-job.sh" "$bin_target/"
install -m 0755 "$repo_dir/scripts/mtplx-hermes-up" "$bin_target/"

if [[ "$install_deps" == "1" ]]; then
  "$hermes_python" -m pip install --disable-pip-version-check "$repo_dir/plur1bus-hermes" "$repo_dir/plur1bus-controls"
fi

if [[ "$install_desktop" == "1" ]]; then
  install -m 0755 "$repo_dir/scripts/hermes-desktop-host.py" "$bin_target/plur1bus-desktop-host.py"
  install -d "$bin_target/plur1bus-host-patches"
  install -m 0644 "$repo_dir/hermes-dashboard/patches/"*.patch "$bin_target/plur1bus-host-patches/"
  printf 'Installed native PLUR1BUS Desktop entry; open PLUR1BUS in the bottom status bar or command palette.\n'
  printf 'Desktop UI installed in %s existing home(s); other profiles memory-provider configuration is unchanged.\n' "${#desktop_homes[@]}"
  printf 'Restart Hermes Desktop to load backend updates. The frontend uses a native workspace tab, not the contributed route cache.\n'
  printf 'Read-only startup checks are enabled. Host preparation helper: %s/plur1bus-desktop-host.py --source /absolute/hermes/source\n' "$bin_target"
  if [[ -n "$desktop_host_source" ]]; then
    "$hermes_python" "$bin_target/plur1bus-desktop-host.py" --source "$desktop_host_source" || \
      printf 'Host compatibility is not confirmed. No host changes were attempted; inspect the report before a separate confirmed build.\n' >&2
  fi
fi
if [[ "$refresh_shared_unified" == "1" ]]; then
  install -m 0644 "$desktop_source" "$shared_unified"
  printf 'Refreshed existing shared Desktop source: %s\n' "$shared_unified"
fi
for desktop_home in "${desktop_homes[@]}"; do
  desktop_target="$desktop_home/desktop-plugins/plur1bus"
  [[ "$install_desktop" == "1" || -d "$desktop_target" ]] || continue
  install -d "$desktop_target"
  install -m 0644 "$desktop_source" "$desktop_target/plugin.js"
  if [[ -f "$desktop_target/.hermes-package.json" ]]; then
    # Keep this installer-owned standalone entry stable across host restarts.
    # A stale materialization marker lets Hermes recursively replace this
    # directory, which would discard local preferences and other sibling files.
    marker_backup="$(mktemp "$desktop_target/.hermes-package.json.plur1bus-backup.XXXXXX")"
    mv "$desktop_target/.hermes-package.json" "$marker_backup"
    printf 'Archived Desktop materialization marker (standalone installer ownership): %s\n' "$marker_backup"
  fi
  printf 'Refreshed Desktop entry: %s/plugin.js\n' "$desktop_target"
done

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
  for profile_name in "${selected_profiles[@]}"; do
    # Root HERMES_HOME alone can follow Hermes' sticky active_profile.
    HERMES_HOME="$hermes_home" hermes --profile "$profile_name" config set memory.provider plur1bus
    HERMES_HOME="$hermes_home" hermes --profile "$profile_name" config set memory.memory_enabled true
    HERMES_HOME="$hermes_home" hermes --profile "$profile_name" config set memory.user_profile_enabled true
    HERMES_HOME="$hermes_home" hermes --profile "$profile_name" plugins enable plur1bus
    HERMES_HOME="$hermes_home" hermes --profile "$profile_name" plugins enable plur1bus-controls
  done
else
  for profile_name in "${selected_profiles[@]}"; do
  cat <<EOF
PLUR1BUS resolves retrieval from the active Hermes provider automatically.
To activate it after Hermes is available:
  HERMES_HOME="$hermes_home" hermes --profile "$profile_name" config set memory.provider plur1bus
  HERMES_HOME="$hermes_home" hermes --profile "$profile_name" config set memory.memory_enabled true
  HERMES_HOME="$hermes_home" hermes --profile "$profile_name" plugins enable plur1bus
  HERMES_HOME="$hermes_home" hermes --profile "$profile_name" plugins enable plur1bus-controls
EOF
  done
fi

if [[ "$install_deps" == "0" && "$check_dashboard" == "0" ]]; then
  printf 'Dependency installation was skipped; the selected Hermes runtime must already provide plur1bus-hermes and its dashboard dependencies.\n'
fi

printf 'Installed PLUR1BUS Hermes plugins in selected profile(s): %s\n' "${selected_profiles[*]}"
for selected_home in "${selected_homes[@]}"; do
  printf '  %s/plugins/plur1bus (including desktop/plugin.js and dashboard backend)\n  %s/plugins/plur1bus-controls\n' "$selected_home" "$selected_home"
done

if [[ "$install_model_providers" == "1" ]]; then
  for selected_home in "${selected_homes[@]}"; do
    printf '  %s/plugins/model-providers/{omlx,vmlx,mtplx}\n' "$selected_home"
  done
else
  printf '  model providers: skipped (--no-model-providers; existing code preserved)\n'
fi

cat <<EOF

Configure Hermes with:
  memory.provider: plur1bus
  memory.memory_enabled: true
  memory.user_profile_enabled: true
  plugins.enabled: [plur1bus, plur1bus-controls]

Only selected profiles were installed/activated (default: default). Use
--profile all for every existing profile, or repeat --profile NAME for a selection.
--no-setup / --no-activate installs files while preserving profile configuration.
Restart Hermes Desktop so it discovers the unified PLUR1BUS desktop plugin.

To configure Hermes's primary LLM through oMLX:
  $repo_dir/scripts/configure-hermes-omlx.sh --model MODEL_ID

After a completed OpenClaw workspace migration, preview profile activation with:
  plur1bus-hermes-cutover TARGET

Apply the gated profile cutover and restart Hermes with:
  plur1bus-hermes-cutover TARGET --apply --restart

EOF
