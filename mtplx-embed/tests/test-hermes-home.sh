#!/usr/bin/env bash
# Offline regressions for shared Hermes-home discovery and installer gating.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_dir/scripts/lib/hermes-home.sh"
main_installer="$repo_dir/scripts/install-hermes-plugins.sh"
sidecar_installer="$repo_dir/scripts/install-mtplx-embed.sh"
fixtures="$repo_dir/mtplx-embed/tests/fixtures"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/hermes-home-discovery.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

fail() {
  printf 'Hermes-home regression failure: %s\n' "$*" >&2
  exit 1
}

valid_home() {
  mkdir -p "$1/hermes-agent/venv/bin"
  printf 'model: {}\n' > "$1/config.yaml"
  install -m 0755 "$fixtures/fake-python.sh" "$1/hermes-agent/venv/bin/python"
}

canonical() {
  (cd -P "$1" && pwd)
}

run_resolver() {
  local discovery_root="$1"
  local explicit_home="${2:-}"
  local non_interactive="${3:-1}"
  env -u HERMES_HOME PLUR1BUS_HERMES_DISCOVERY_ROOT="$discovery_root" \
    XDG_CONFIG_HOME="$discovery_root/xdg" PATH="$fixtures:$PATH" \
    MTPLX_TEST_RECORD="$scratch/record" bash -c \
    'source "$1"; resolve_hermes_home "$2" "$3" || exit $?; printf "resolved=%s\ncandidates=%s\n" "$HERMES_HOME_RESOLVED" "${#HERMES_HOME_CANDIDATES[@]}"' \
    _ "$helper" "$explicit_home" "$non_interactive"
}

discover_candidates() {
  local discovery_root="$1"
  env -u HERMES_HOME PLUR1BUS_HERMES_DISCOVERY_ROOT="$discovery_root" \
    XDG_CONFIG_HOME="$discovery_root/xdg" PATH="$fixtures:$PATH" \
    MTPLX_TEST_RECORD="$scratch/record" bash -c '
      source "$1"
      HERMES_HOME_CANDIDATES=()
      HERMES_HOME_DISCOVERY_ROOT="$2"
      _hermes_home_add_candidate "$HERMES_HOME_DISCOVERY_ROOT/.hermes"
      for sibling in "$HERMES_HOME_DISCOVERY_ROOT"/.hermes-*; do
        [[ -d "$sibling" ]] || continue
        _hermes_home_add_candidate "$sibling"
      done
      _hermes_home_discover_cli
      _hermes_home_discover_launchagents
      _hermes_home_discover_systemd
      printf "candidates=%s\n" "${#HERMES_HOME_CANDIDATES[@]}"
      printf "candidate=%s\n" "${HERMES_HOME_CANDIDATES[@]:-}"
    ' _ "$helper" "$discovery_root"
}

: > "$scratch/record"

# Without an explicit home, every noninteractive or no-TTY call fails before
# discovery and before any implicit ~/.hermes creation.
zero_root="$scratch/zero"
mkdir -p "$zero_root"
set +e
output="$(run_resolver "$zero_root" 2>&1)"
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'zero candidates succeeded'
[[ "$output" == *'Noninteractive Hermes home selection requires --hermes-home PATH or HERMES_HOME'* ]] || fail 'noninteractive explicit-home remediation missing'
[[ ! -e "$zero_root/.hermes" ]] || fail 'zero-candidate discovery created ~/.hermes'

# A singleton is still discovered and deduplicated, but it cannot be selected
# without an explicit path when stdin has no TTY.
one_root="$scratch/one"
one_home="$one_root/.hermes-bernd"
valid_home "$one_home"
output="$(MTPLX_TEST_HERMES_CONFIG_PATH="$one_home/config.yaml" discover_candidates "$one_root")"
[[ "$output" == *'candidates=1'* ]] || fail 'canonical duplicate was not removed'
set +e
output="$(MTPLX_TEST_HERMES_CONFIG_PATH="$one_home/config.yaml" run_resolver "$one_root" 2>&1)"
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'noninteractive singleton discovery succeeded without an explicit home'
[[ "$output" == *'Noninteractive Hermes home selection requires --hermes-home PATH or HERMES_HOME'* ]] || fail 'singleton explicit-home remediation missing'

set +e
output="$(env -u HERMES_HOME PLUR1BUS_HERMES_DISCOVERY_ROOT="$one_root" \
  XDG_CONFIG_HOME="$one_root/xdg" PATH="$fixtures:$PATH" MTPLX_TEST_RECORD="$scratch/record" \
  "$main_installer" --non-interactive --no-deps --no-setup --no-retrieval 2>&1)"
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'full installer accepted a discovered singleton without an explicit home'
[[ ! -e "$one_home/plugins" ]] || fail 'full installer wrote before rejecting a noninteractive singleton'

# LaunchAgent and user-systemd sources are both bounded to the synthetic root.
launch_root="$scratch/launch"
launch_home="$scratch/launch-home"
valid_home "$launch_home"
mkdir -p "$launch_root/Library/LaunchAgents"
printf '\377\376\000\200not-a-plist\n' > "$launch_root/Library/LaunchAgents/00-binary-invalid.plist"
printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>EnvironmentVariables</key><dict><key>HERMES_HOME</key><string>%s</string></dict>\n</dict></plist>\n' "$launch_home" > "$launch_root/Library/LaunchAgents/hermes.plist"
output="$(discover_candidates "$launch_root" 2>"$scratch/launch-stderr")"
[[ "$output" == *"candidate=$(canonical "$launch_home")"* ]] || fail 'LaunchAgent HERMES_HOME was not discovered'
[[ ! -s "$scratch/launch-stderr" ]] || fail 'irrelevant malformed LaunchAgent emitted stderr'

systemd_root="$scratch/systemd"
systemd_home="$scratch/systemd-home"
valid_home "$systemd_home"
mkdir -p "$systemd_root/xdg/systemd/user"
printf '[Service]\nEnvironment="HERMES_HOME=%s"\n' "$systemd_home" > "$systemd_root/xdg/systemd/user/hermes.service"
output="$(discover_candidates "$systemd_root")"
[[ "$output" == *"candidate=$(canonical "$systemd_home")"* ]] || fail 'user-systemd HERMES_HOME was not discovered'

# Multiple candidates are fatal without a TTY. The full installer must stop
# before discovery can choose or create any plugin targets.
multiple_root="$scratch/multiple"
first_home="$multiple_root/.hermes-first"
second_home="$multiple_root/.hermes-second"
valid_home "$first_home"
valid_home "$second_home"
set +e
output="$(run_resolver "$multiple_root" 2>&1)"
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'ambiguous noninteractive discovery succeeded'
[[ "$output" == *'Noninteractive Hermes home selection requires --hermes-home PATH or HERMES_HOME'* ]] || fail 'ambiguity remediation missing'

set +e
output="$(env -u HERMES_HOME PLUR1BUS_HERMES_DISCOVERY_ROOT="$multiple_root" \
  XDG_CONFIG_HOME="$multiple_root/xdg" PATH="$fixtures:$PATH" MTPLX_TEST_RECORD="$scratch/record" \
  "$main_installer" --non-interactive --no-deps --no-setup --no-retrieval 2>&1)"
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'full installer accepted ambiguous homes'
[[ ! -e "$first_home/plugins/plur1bus" && ! -e "$second_home/plugins/plur1bus" ]] || fail 'full installer wrote before selection'

# Explicit CLI selection beats an exported environment value; an exported value
# beats all discovery candidates when no CLI value is supplied.
explicit_home="$scratch/explicit"
environment_home="$scratch/environment"
valid_home "$explicit_home"
valid_home "$environment_home"
output="$(HERMES_HOME="$environment_home" PLUR1BUS_HERMES_DISCOVERY_ROOT="$multiple_root" \
  bash -c 'source "$1"; resolve_hermes_home "$2" 1; printf "resolved=%s\n" "$HERMES_HOME_RESOLVED"' \
  _ "$helper" "$explicit_home")"
[[ "$output" == *"resolved=$(canonical "$explicit_home")"* ]] || fail '--hermes-home did not beat HERMES_HOME'

output="$(HERMES_HOME="$environment_home" PLUR1BUS_HERMES_DISCOVERY_ROOT="$multiple_root" \
  bash -c 'source "$1"; resolve_hermes_home "" 1; printf "resolved=%s\n" "$HERMES_HOME_RESOLVED"' \
  _ "$helper")"
[[ "$output" == *"resolved=$(canonical "$environment_home")"* ]] || fail 'HERMES_HOME did not beat discovery'

# The full installer always installs dependencies with the selected instance's
# interpreter. Selecting a different home changes the pip target, while an
# explicit HERMES_PYTHON remains authoritative.
: > "$scratch/python-record"
for selected_home in "$explicit_home" "$environment_home"; do
  resolved_selected="$(canonical "$selected_home")"
  output="$(env -u HERMES_HOME PLUR1BUS_HERMES_DISCOVERY_ROOT="$multiple_root" \
    PATH="$fixtures:$PATH" MTPLX_TEST_RECORD="$scratch/python-record" \
    "$main_installer" --hermes-home "$selected_home" --no-setup --no-retrieval 2>&1)"
  grep -Fq "pip:$resolved_selected/hermes-agent/venv/bin/python" "$scratch/python-record" || fail "selected instance did not use its own Python: $selected_home"
done

override_python="$scratch/override-python"
install -m 0755 "$fixtures/fake-python.sh" "$override_python"
: > "$scratch/override-record"
output="$(HERMES_PYTHON="$override_python" MTPLX_TEST_RECORD="$scratch/override-record" \
  "$main_installer" --hermes-home "$explicit_home" --no-setup --no-retrieval 2>&1)"
grep -Fq "pip:$override_python" "$scratch/override-record" || fail 'explicit HERMES_PYTHON did not win'

# Exercise the actual numbered prompt under a pseudo-TTY. BSD/macOS and
# util-linux expose different script(1) syntaxes; report an explicit skip if
# neither portable form is available.
interactive_output=""
interactive_single_output=""
if command -v script >/dev/null 2>&1; then
  interactive_root="$scratch/interactive"
  interactive_first="$interactive_root/.hermes-first"
  interactive_second="$interactive_root/.hermes-second"
  valid_home "$interactive_first"
  valid_home "$interactive_second"
  if script -q /dev/null true >/dev/null 2>&1; then
    interactive_single_output="$(env -u HERMES_HOME \
      PLUR1BUS_HERMES_DISCOVERY_ROOT="$one_root" XDG_CONFIG_HOME="$one_root/xdg" \
      PATH="$fixtures:$PATH" HERMES_TEST_HELPER="$helper" MTPLX_TEST_RECORD="$scratch/record" \
      script -q /dev/null "$fixtures/interactive-resolver" 2>&1)"
    interactive_output="$({ sleep 0.2; printf '2\n'; } | \
      env -u HERMES_HOME PLUR1BUS_HERMES_DISCOVERY_ROOT="$interactive_root" XDG_CONFIG_HOME="$interactive_root/xdg" \
      PATH="$fixtures:$PATH" HERMES_TEST_HELPER="$helper" MTPLX_TEST_RECORD="$scratch/record" \
      script -q /dev/null "$fixtures/interactive-resolver" 2>&1)"
  elif script -q -c true /dev/null >/dev/null 2>&1; then
    interactive_single_output="$(env -u HERMES_HOME \
      PLUR1BUS_HERMES_DISCOVERY_ROOT="$one_root" XDG_CONFIG_HOME="$one_root/xdg" \
      PATH="$fixtures:$PATH" HERMES_TEST_HELPER="$helper" MTPLX_TEST_RECORD="$scratch/record" \
      script -q -c "$fixtures/interactive-resolver" /dev/null 2>&1)"
    interactive_output="$({ sleep 0.2; printf '2\n'; } | \
      env -u HERMES_HOME PLUR1BUS_HERMES_DISCOVERY_ROOT="$interactive_root" XDG_CONFIG_HOME="$interactive_root/xdg" \
      PATH="$fixtures:$PATH" HERMES_TEST_HELPER="$helper" MTPLX_TEST_RECORD="$scratch/record" \
      script -q -c "$fixtures/interactive-resolver" /dev/null 2>&1)"
  else
    printf 'SKIP: script(1) pseudo-TTY syntax is unsupported\n'
  fi
  if [[ -n "$interactive_single_output" ]]; then
    [[ "$interactive_single_output" == *"interactive-resolved=$(canonical "$one_home")"* ]] || fail 'interactive singleton was not auto-selected'
  fi
  if [[ -n "$interactive_output" ]]; then
    [[ "$interactive_output" == *"interactive-resolved=$(canonical "$interactive_second")"* ]] || fail 'interactive choice did not select candidate 2'
  fi
else
  printf 'SKIP: script(1) is unavailable; interactive pseudo-TTY test not run\n'
fi

# Direct sidecar invocation must also reject a discovered singleton before its
# first target write. Explicit selection preserves the supported install path.
direct_root="$scratch/direct"
direct_home="$direct_root/.hermes-direct"
valid_home "$direct_home"
: > "$scratch/direct-record"
set +e
output="$(env -u HERMES_HOME PLUR1BUS_HERMES_DISCOVERY_ROOT="$direct_root" \
  XDG_CONFIG_HOME="$direct_root/xdg" PATH="$fixtures:$PATH" MTPLX_TEST_RECORD="$scratch/direct-record" \
  MTPLX_TEST_REAL_PYTHON="${MTPLX_TEST_REAL_PYTHON:-/usr/bin/python3}" \
  "$sidecar_installer" --non-interactive --no-agent 2>&1)"
status=$?
set -e
[[ "$status" -ne 0 ]] || fail 'direct sidecar accepted a discovered singleton without an explicit home'
[[ ! -e "$direct_home/mtplx-embed" ]] || fail 'direct sidecar wrote before rejecting a noninteractive singleton'

output="$(env -u HERMES_HOME PLUR1BUS_HERMES_DISCOVERY_ROOT="$direct_root" \
  XDG_CONFIG_HOME="$direct_root/xdg" PATH="$fixtures:$PATH" MTPLX_TEST_RECORD="$scratch/direct-record" \
  MTPLX_TEST_REAL_PYTHON="${MTPLX_TEST_REAL_PYTHON:-/usr/bin/python3}" \
  "$sidecar_installer" --hermes-home "$direct_home" --non-interactive --no-agent 2>&1)"
[[ "$output" == *"Using Python from selected Hermes instance: $(canonical "$direct_home")/hermes-agent/venv/bin/python"* ]] || fail 'direct sidecar did not use the selected instance Python'
[[ -d "$direct_home/mtplx-embed/mtplx_embed" ]] || fail 'direct sidecar did not use the explicit home'

printf 'Hermes-home discovery regressions passed\n'
