#!/usr/bin/env bash
# Shared, read-only Hermes installation discovery for PLUR1BUS installers.

HERMES_HOME_RESOLVED=""
HERMES_HOME_CANDIDATES=()
HERMES_HOME_DISCOVERY_ROOT=""
HERMES_PYTHON_RESOLVED=""

_hermes_home_expand() {
  local value="$1"
  case "$value" in
    "~") value="$HOME" ;;
    "~/"*) value="$HOME/${value#~/}" ;;
    '\$HOME/'*) value="$HOME/${value#\$HOME/}" ;;
    '\${HOME}/'*) value="$HOME/${value#\$\{HOME\}/}" ;;
  esac
  printf '%s\n' "$value"
}

_hermes_home_canonical() {
  local candidate
  candidate="$(_hermes_home_expand "$1")"
  [[ -n "$candidate" && "$candidate" != *$'\n'* && -d "$candidate" ]] || return 1
  (cd -P "$candidate" 2>/dev/null && pwd)
}

_hermes_home_is_profile_dir() {
  local candidate="$1"
  local root=""
  if [[ "$candidate" == */profiles/* ]]; then
    root="${candidate%%/profiles/*}"
    [[ -f "$root/config.yaml" ]] && return 0
  fi
  return 1
}

_hermes_home_is_valid() {
  local candidate="$1"
  [[ -f "$candidate/config.yaml" ]] || return 1
  _hermes_home_is_profile_dir "$candidate" && return 1
  [[ -d "$candidate/profiles" || -d "$candidate/plugins" || -d "$candidate/logs" || \
     -d "$candidate/sessions" || -d "$candidate/hermes-agent" || \
     -f "$candidate/active-profile.json" || -f "$candidate/.env" ]]
}

resolve_hermes_python() {
  local hermes_home="$1"
  local allow_mtplx_override="${2:-0}"
  local source_label=""
  local candidate=""

  HERMES_PYTHON_RESOLVED=""
  if [[ "$allow_mtplx_override" == "1" && -n "${MTPLX_EMBED_PYTHON:-}" ]]; then
    candidate="$MTPLX_EMBED_PYTHON"
    source_label='MTPLX_EMBED_PYTHON'
  elif [[ -n "${HERMES_PYTHON:-}" ]]; then
    candidate="$HERMES_PYTHON"
    source_label='HERMES_PYTHON'
  elif [[ -x "$hermes_home/hermes-agent/venv/bin/python" ]]; then
    candidate="$hermes_home/hermes-agent/venv/bin/python"
    source_label='selected Hermes instance'
  elif [[ -x "$hermes_home/hermes-agent/venv/Scripts/python.exe" ]]; then
    candidate="$hermes_home/hermes-agent/venv/Scripts/python.exe"
    source_label='selected Hermes instance'
  elif [[ -x "$hermes_home/hermes-agent/venv/Scripts/python" ]]; then
    candidate="$hermes_home/hermes-agent/venv/Scripts/python"
    source_label='selected Hermes instance'
  else
    printf 'No Python runtime was found for Hermes home %s. Nothing was installed.\nSet HERMES_PYTHON%s or repair %s/hermes-agent/venv.\n' \
      "$hermes_home" "$( [[ "$allow_mtplx_override" == "1" ]] && printf ' or MTPLX_EMBED_PYTHON' )" "$hermes_home" >&2
    return 5
  fi

  candidate="$(_hermes_home_expand "$candidate")"
  if [[ ! -x "$candidate" ]]; then
    printf 'Python from %s is not executable: %s\n' "$source_label" "$candidate" >&2
    return 5
  fi
  HERMES_PYTHON_RESOLVED="$candidate"
  printf 'Using Python from %s: %s\n' "$source_label" "$HERMES_PYTHON_RESOLVED"
}

_hermes_home_add_candidate() {
  local raw="$1"
  local candidate=""
  local existing=""
  [[ -n "$raw" ]] || return 0
  raw="$(_hermes_home_expand "$raw")"
  if [[ -f "$raw" && "${raw##*/}" == "config.yaml" ]]; then
    if [[ "$raw" == */profiles/*/config.yaml ]]; then
      raw="${raw%%/profiles/*}"
    else
      raw="${raw%/config.yaml}"
    fi
  fi
  candidate="$(_hermes_home_canonical "$raw" 2>/dev/null || true)"
  [[ -n "$candidate" ]] || return 0
  _hermes_home_is_valid "$candidate" || return 0
  for existing in "${HERMES_HOME_CANDIDATES[@]:-}"; do
    [[ "$existing" == "$candidate" ]] && return 0
  done
  HERMES_HOME_CANDIDATES+=("$candidate")
}

_hermes_home_select_explicit() {
  local raw="$1"
  local source_label="$2"
  local candidate=""
  raw="$(_hermes_home_expand "$raw")"
  candidate="$(_hermes_home_canonical "$raw" 2>/dev/null || true)"
  if [[ -z "$candidate" ]] || ! _hermes_home_is_valid "$candidate"; then
    printf 'Invalid Hermes home from %s: %s\nExpected an existing installation with config.yaml and Hermes runtime directories/files.\n' \
      "$source_label" "$raw" >&2
    return 2
  fi
  HERMES_HOME_RESOLVED="$candidate"
  printf 'Using Hermes home from %s: %s\n' "$source_label" "$HERMES_HOME_RESOLVED"
}

_hermes_home_discover_cli() {
  local output=""
  local line=""
  local value=""
  command -v hermes >/dev/null 2>&1 || return 0
  output="$(env -u HERMES_HOME hermes config path 2>/dev/null || true)"
  while IFS= read -r line; do
    value="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$value" in
      *": "/*) value="${value#*: }" ;;
    esac
    _hermes_home_add_candidate "$value"
  done <<< "$output"
}

_hermes_home_discover_launchagents() {
  local plist=""
  local value=""
  local count=0
  for plist in "$HERMES_HOME_DISCOVERY_ROOT"/Library/LaunchAgents/*.plist; do
    [[ -f "$plist" ]] || continue
    count=$((count + 1))
    [[ "$count" -le 128 ]] || break
    if command -v plutil >/dev/null 2>&1; then
      # macOS plutil reads XML and binary plists without passing arbitrary bytes
      # through the current locale. Missing keys and unrelated malformed plists
      # are expected during a bounded scan and remain silent.
      value="$(plutil -extract EnvironmentVariables.HERMES_HOME raw -o - "$plist" 2>/dev/null || true)"
      _hermes_home_add_candidate "$value"
    else
      # Portable XML-only fallback. C locale makes malformed/non-UTF bytes safe
      # for sed; stderr stays quiet because unrelated LaunchAgents are normal.
      while IFS= read -r value; do
        _hermes_home_add_candidate "$value"
      done < <(LC_ALL=C sed -n '/<key>[[:space:]]*HERMES_HOME[[:space:]]*<\/key>/{n;s/^[[:space:]]*<string>//;s#</string>[[:space:]]*$##;p;}' "$plist" 2>/dev/null)
    fi
  done
}

_hermes_home_discover_systemd() {
  local unit=""
  local line=""
  local value=""
  local count=0
  for unit in "${XDG_CONFIG_HOME:-$HERMES_HOME_DISCOVERY_ROOT/.config}"/systemd/user/*.service; do
    [[ -f "$unit" ]] || continue
    count=$((count + 1))
    [[ "$count" -le 128 ]] || break
    while IFS= read -r line; do
      line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      case "$line" in
        Environment=HERMES_HOME=*) value="${line#Environment=HERMES_HOME=}" ;;
        Environment='"HERMES_HOME='*'"') value="${line#Environment=\"HERMES_HOME=}"; value="${value%\"}" ;;
        *) continue ;;
      esac
      _hermes_home_add_candidate "$value"
    done < "$unit"
  done
}

resolve_hermes_home() {
  local explicit_home="${1:-}"
  local non_interactive="${2:-0}"
  local sibling=""
  local candidate=""
  local index=0
  local selection=""

  HERMES_HOME_RESOLVED=""
  HERMES_HOME_CANDIDATES=()
  HERMES_HOME_DISCOVERY_ROOT="${PLUR1BUS_HERMES_DISCOVERY_ROOT:-$HOME}"
  if [[ -n "$explicit_home" ]]; then
    _hermes_home_select_explicit "$explicit_home" '--hermes-home'
    return
  fi
  if [[ -n "${HERMES_HOME:-}" ]]; then
    _hermes_home_select_explicit "$HERMES_HOME" 'HERMES_HOME'
    return
  fi

  _hermes_home_add_candidate "$HERMES_HOME_DISCOVERY_ROOT/.hermes"
  for sibling in "$HERMES_HOME_DISCOVERY_ROOT"/.hermes-*; do
    [[ -d "$sibling" ]] || continue
    _hermes_home_add_candidate "$sibling"
  done
  _hermes_home_discover_cli
  _hermes_home_discover_launchagents
  _hermes_home_discover_systemd

  if [[ "${#HERMES_HOME_CANDIDATES[@]}" -eq 0 ]]; then
    printf 'No valid Hermes installation was found. Nothing was written.\nUse --hermes-home PATH or export HERMES_HOME after creating/configuring Hermes.\n' >&2
    return 3
  fi
  if [[ "${#HERMES_HOME_CANDIDATES[@]}" -eq 1 ]]; then
    HERMES_HOME_RESOLVED="${HERMES_HOME_CANDIDATES[0]}"
    printf 'Discovered one Hermes home: %s\n' "$HERMES_HOME_RESOLVED"
    return 0
  fi

  printf 'Multiple Hermes installations were found:\n' >&2
  for candidate in "${HERMES_HOME_CANDIDATES[@]}"; do
    index=$((index + 1))
    printf '  %d) %s\n' "$index" "$candidate" >&2
  done
  if [[ "$non_interactive" == "1" || ! -t 0 ]]; then
    printf 'Selection is ambiguous and no files were changed. Re-run with --hermes-home PATH or export HERMES_HOME.\n' >&2
    return 4
  fi

  while true; do
    read -r -p "Select Hermes home [1-${#HERMES_HOME_CANDIDATES[@]}]: " selection
    if [[ "$selection" =~ ^[0-9]+$ ]] && (( selection >= 1 && selection <= ${#HERMES_HOME_CANDIDATES[@]} )); then
      HERMES_HOME_RESOLVED="${HERMES_HOME_CANDIDATES[selection - 1]}"
      printf 'Selected Hermes home: %s\n' "$HERMES_HOME_RESOLVED"
      return 0
    fi
    printf 'Please enter a number from 1 to %d.\n' "${#HERMES_HOME_CANDIDATES[@]}" >&2
  done
}
