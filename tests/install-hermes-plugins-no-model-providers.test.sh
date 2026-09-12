#!/usr/bin/env bash
# Regression: --no-model-providers must never create, copy, or delete provider code.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

home="$temporary/hermes-home"
mkdir -p "$home/plugins/model-providers/omlx" "$home/plugins/model-providers/vmlx"
printf 'memory: {}\n' > "$home/config.yaml"
printf 'keep-omlx\n' > "$home/plugins/model-providers/omlx/sentinel.py"
printf 'keep-vmlx\n' > "$home/plugins/model-providers/vmlx/sentinel.py"

output="$($repo_dir/scripts/install-hermes-plugins.sh \
  --hermes-home "$home" --no-setup --no-deps --no-retrieval --no-model-providers 2>&1)"

[[ "$(<"$home/plugins/model-providers/omlx/sentinel.py")" == "keep-omlx" ]]
[[ "$(<"$home/plugins/model-providers/vmlx/sentinel.py")" == "keep-vmlx" ]]
[[ ! -e "$home/plugins/model-providers/mtplx" ]]
[[ -f "$home/plugins/plur1bus/__init__.py" ]]
[[ -f "$home/plugins/plur1bus-controls/__init__.py" ]]
cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$home/plugins/plur1bus/desktop/plugin.js"
cmp "$repo_dir/hermes-dashboard/plur1bus/dashboard/plugin_api.py" "$home/plugins/plur1bus/dashboard/plugin_api.py"
[[ -f "$home/plugins/plur1bus/dashboard/dist/index.js" ]]
[[ ! -e "$home/desktop-plugins" ]]
grep -Fq 'Skipped model-provider plugins (--no-model-providers); existing omlx, vmlx, and mtplx code was preserved.' <<<"$output"
grep -Fq 'model providers: skipped (--no-model-providers; existing code preserved)' <<<"$output"

# Packaged upgrades must not trust equal mtime/size: npm normalizes both releases.
for plugin in plur1bus plur1bus-controls; do
  if [[ "$plugin" == "plur1bus" ]]; then
    source="$repo_dir/plur1bus-hermes/src/plur1bus_hermes/__init__.py"
  else
    source="$repo_dir/plur1bus-controls/src/plur1bus_controls/__init__.py"
  fi
  sed 's/__version__/__versioN__/' "$source" > "$home/plugins/$plugin/__init__.py"
  touch -r "$source" "$home/plugins/$plugin/__init__.py"
  ! cmp -s "$source" "$home/plugins/$plugin/__init__.py"
done
"$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$home" --no-setup --no-deps --no-retrieval --no-model-providers >/dev/null
cmp "$repo_dir/plur1bus-hermes/src/plur1bus_hermes/__init__.py" "$home/plugins/plur1bus/__init__.py"
cmp "$repo_dir/plur1bus-controls/src/plur1bus_controls/__init__.py" "$home/plugins/plur1bus-controls/__init__.py"

# Omission preserves the historic synchronizing/default installation behavior.
default_home="$temporary/default-hermes-home"
mkdir -p "$default_home/plugins/model-providers/omlx"
printf 'memory: {}\n' > "$default_home/config.yaml"
printf 'replace-me\n' > "$default_home/plugins/model-providers/omlx/sentinel.py"
"$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$default_home" --no-setup --no-deps --no-retrieval >/dev/null
[[ ! -e "$default_home/plugins/model-providers/omlx/sentinel.py" ]]
[[ -f "$default_home/plugins/model-providers/omlx/__init__.py" ]]
[[ -f "$default_home/plugins/model-providers/vmlx/__init__.py" ]]
[[ -f "$default_home/plugins/model-providers/mtplx/__init__.py" ]]

# Desktop is explicit, uses the native disk door, and refuses symlink targets.
desktop_home="$temporary/desktop-home"
mkdir -p "$desktop_home/plugins" "$temporary/bin"
printf 'memory: {}\n' > "$desktop_home/config.yaml"
printf '#!/bin/sh\nexit 0\n' > "$temporary/bin/python"
printf '#!/bin/sh\nexit 0\n' > "$temporary/bin/hermes"
chmod +x "$temporary/bin/python" "$temporary/bin/hermes"
PATH="$temporary/bin:$PATH" HERMES_PYTHON="$temporary/bin/python" "$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$desktop_home" --desktop --no-setup --no-deps --no-retrieval --no-model-providers >/dev/null
cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$desktop_home/desktop-plugins/plur1bus/plugin.js"
cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$desktop_home/plugins/plur1bus/desktop/plugin.js"
cmp "$repo_dir/scripts/hermes-desktop-host.py" "$desktop_home/bin/plur1bus-desktop-host.py"
cmp "$repo_dir/hermes-dashboard/patches/hermes-desktop-live-profile.patch" "$desktop_home/bin/plur1bus-host-patches/hermes-desktop-live-profile.patch"
cmp "$repo_dir/hermes-dashboard/patches/hermes-desktop-sidebar-action.patch" "$desktop_home/bin/plur1bus-host-patches/hermes-desktop-sidebar-action.patch"
[[ -f "$desktop_home/plugins/plur1bus/dashboard/manifest.json" ]]
mv "$desktop_home/desktop-plugins/plur1bus" "$temporary/outside-desktop"
ln -s "$temporary/outside-desktop" "$desktop_home/desktop-plugins/plur1bus"
if PATH="$temporary/bin:$PATH" HERMES_PYTHON="$temporary/bin/python" "$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$desktop_home" --desktop --no-setup --no-deps --no-retrieval --no-model-providers >/dev/null 2>&1; then
  printf 'Desktop installer followed a symbolic link\n' >&2
  exit 1
fi

# A selected profile gets both backend packages and unified UI without changing
# the default or other profiles. Activation must target that same runtime home.
scoped_home="$temporary/scoped-profiles"
mkdir -p "$scoped_home/profiles/alpha" "$scoped_home/profiles/beta"
scoped_home="$(cd -P "$scoped_home" && pwd)"
printf 'memory: {provider: builtin}\n' > "$scoped_home/config.yaml"
cp "$scoped_home/config.yaml" "$scoped_home/profiles/alpha/config.yaml"
cp "$scoped_home/config.yaml" "$scoped_home/profiles/beta/config.yaml"
printf '#!/bin/sh\nprintf "%%s:%%s\\n" "$HERMES_HOME" "$*" >> "$INSTALLER_TEST_RECORD"\n' > "$temporary/bin/hermes"
chmod +x "$temporary/bin/hermes"
activation_record="$temporary/activation-record"
PATH="$temporary/bin:$PATH" INSTALLER_TEST_RECORD="$activation_record" "$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$scoped_home" --profile alpha --activate --no-deps --no-retrieval --no-model-providers >/dev/null
cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$scoped_home/profiles/alpha/plugins/plur1bus/desktop/plugin.js"
cmp "$repo_dir/hermes-dashboard/plur1bus/dashboard/plugin_api.py" "$scoped_home/profiles/alpha/plugins/plur1bus/dashboard/plugin_api.py"
[[ -f "$scoped_home/profiles/alpha/plugins/plur1bus-controls/__init__.py" ]]
[[ ! -e "$scoped_home/plugins" && ! -e "$scoped_home/profiles/beta/plugins" ]]
grep -Fqx "$scoped_home:--profile alpha config set memory.memory_enabled true" "$activation_record"
grep -Fqx "$scoped_home:--profile alpha plugins enable plur1bus" "$activation_record"
grep -Fqx "$scoped_home:--profile alpha plugins enable plur1bus-controls" "$activation_record"
[[ "$(wc -l < "$activation_record" | tr -d ' ')" == 5 ]]

# Explicit all-profile installation preserves local state and no-activate does
# not invoke Hermes configuration. Invalid mixed selection fails before writes.
printf 'keep custom config\n' > "$scoped_home/profiles/alpha/plugins/plur1bus/config.json"
PATH="$temporary/bin:$PATH" INSTALLER_TEST_RECORD="$activation_record" "$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$scoped_home" --profile all --no-activate --no-deps --no-retrieval --no-model-providers >/dev/null
for installed_home in "$scoped_home" "$scoped_home/profiles/alpha" "$scoped_home/profiles/beta"; do
  cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$installed_home/plugins/plur1bus/desktop/plugin.js"
  cmp "$repo_dir/hermes-dashboard/plur1bus/dashboard/manifest.json" "$installed_home/plugins/plur1bus/dashboard/manifest.json"
  [[ "$(<"$installed_home/config.yaml")" == 'memory: {provider: builtin}' ]]
done
[[ "$(<"$scoped_home/profiles/alpha/plugins/plur1bus/config.json")" == 'keep custom config' ]]
[[ "$(wc -l < "$activation_record" | tr -d ' ')" == 5 ]]
if "$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$scoped_home" --profile all --profile alpha --no-setup --no-deps --no-retrieval --no-model-providers >/dev/null 2>&1; then
  printf 'Mixed all-profile selection was accepted\n' >&2
  exit 1
fi

# Default activation must pin the CLI profile even when Hermes has another
# sticky active profile; root retrieval setup must not follow that profile.
printf 'alpha\n' > "$scoped_home/active_profile"
PATH="$temporary/bin:$PATH" INSTALLER_TEST_RECORD="$activation_record" "$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$scoped_home" --profile default --activate --no-deps --no-model-providers >/dev/null
grep -Fqx "$scoped_home:--profile default config set memory.memory_enabled true" "$activation_record"
grep -Fqx "$scoped_home:--profile default plugins enable plur1bus" "$activation_record"
[[ "$(wc -l < "$activation_record" | tr -d ' ')" == 10 ]]
[[ "$(<"$scoped_home/active_profile")" == alpha ]]

# Existing app-wide Desktop copies mask a selected profile's new unified UI.
# Refresh both markerless and marked roots without installing/activating the
# unselected default backend, and leave other named profiles unchanged.
legacy_home="$temporary/legacy-desktop"
mkdir -p "$legacy_home/profiles/alpha" "$legacy_home/profiles/beta/plugins/plur1bus/desktop" \
  "$legacy_home/plugins/plur1bus/desktop" "$legacy_home/desktop-plugins/plur1bus"
printf 'memory: {provider: builtin}\n' > "$legacy_home/config.yaml"
cp "$legacy_home/config.yaml" "$legacy_home/profiles/alpha/config.yaml"
cp "$legacy_home/config.yaml" "$legacy_home/profiles/beta/config.yaml"
printf 'old default backend\n' > "$legacy_home/plugins/plur1bus/__init__.py"
printf 'other profile UI\n' > "$legacy_home/profiles/beta/plugins/plur1bus/desktop/plugin.js"
printf 'preserve preferences\n' > "$legacy_home/desktop-plugins/plur1bus/preferences.json"
for marker_mode in markerless marked; do
  printf 'old default UI\n' > "$legacy_home/plugins/plur1bus/desktop/plugin.js"
  printf 'old app UI\n' > "$legacy_home/desktop-plugins/plur1bus/plugin.js"
  if [[ "$marker_mode" == marked ]]; then
    printf '{"package":"plur1bus","source":"%s/plugins/plur1bus/desktop","sourceMtimeMs":0}\n' "$legacy_home" \
      > "$legacy_home/desktop-plugins/plur1bus/.hermes-package.json"
    cp "$legacy_home/desktop-plugins/plur1bus/.hermes-package.json" "$temporary/marker-before"
  fi
  PATH="$temporary/bin:$PATH" INSTALLER_TEST_RECORD="$activation_record" "$repo_dir/scripts/install-hermes-plugins.sh" \
    --hermes-home "$legacy_home" --profile alpha --no-activate --no-deps --no-retrieval --no-model-providers >/dev/null
  cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$legacy_home/desktop-plugins/plur1bus/plugin.js"
  cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$legacy_home/plugins/plur1bus/desktop/plugin.js"
  cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$legacy_home/profiles/alpha/plugins/plur1bus/desktop/plugin.js"
  [[ "$(<"$legacy_home/plugins/plur1bus/__init__.py")" == 'old default backend' ]]
  [[ "$(<"$legacy_home/profiles/beta/plugins/plur1bus/desktop/plugin.js")" == 'other profile UI' ]]
  [[ "$(<"$legacy_home/desktop-plugins/plur1bus/preferences.json")" == 'preserve preferences' ]]
  [[ ! -e "$legacy_home/plugins/plur1bus/dashboard" && ! -e "$legacy_home/profiles/alpha/desktop-plugins" ]]
  [[ "$(wc -l < "$activation_record" | tr -d ' ')" == 10 ]]
  for checked_home in "$legacy_home" "$legacy_home/profiles/alpha" "$legacy_home/profiles/beta"; do
    [[ "$(<"$checked_home/config.yaml")" == 'memory: {provider: builtin}' ]]
  done
  if [[ "$marker_mode" == marked ]]; then
    [[ ! -e "$legacy_home/desktop-plugins/plur1bus/.hermes-package.json" ]]
    marker_backups=("$legacy_home/desktop-plugins/plur1bus/".hermes-package.json.plur1bus-backup.*)
    [[ "${#marker_backups[@]}" == 1 ]]
    cmp "$temporary/marker-before" "${marker_backups[0]}"
  fi
done
mv "$legacy_home/desktop-plugins/plur1bus/plugin.js" "$temporary/shared-ui-outside.js"
ln -s "$temporary/shared-ui-outside.js" "$legacy_home/desktop-plugins/plur1bus/plugin.js"
printf 'unchanged selected UI\n' > "$legacy_home/profiles/alpha/plugins/plur1bus/desktop/plugin.js"
if "$repo_dir/scripts/install-hermes-plugins.sh" --hermes-home "$legacy_home" --profile alpha \
  --no-setup --no-deps --no-retrieval --no-model-providers >/dev/null 2>&1; then
  printf 'Shared desktop upgrade followed a symbolic link\n' >&2
  exit 1
fi
[[ "$(<"$legacy_home/profiles/alpha/plugins/plur1bus/desktop/plugin.js")" == 'unchanged selected UI' ]]
cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$temporary/shared-ui-outside.js"

# The new unified destination is validated before touching any selected profile.
mv "$scoped_home/profiles/beta/plugins/plur1bus/desktop" "$temporary/beta-unified-before"
ln -s "$temporary/beta-unified-before" "$scoped_home/profiles/beta/plugins/plur1bus/desktop"
printf 'must remain unchanged\n' > "$scoped_home/plugins/plur1bus/desktop/plugin.js"
if "$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$scoped_home" --profile all --no-setup --no-deps --no-retrieval --no-model-providers >/dev/null 2>&1; then
  printf 'Unified desktop installer followed a symbolic link\n' >&2
  exit 1
fi
[[ "$(<"$scoped_home/plugins/plur1bus/desktop/plugin.js")" == 'must remain unchanged' ]]
cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$temporary/beta-unified-before/plugin.js"
cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$temporary/outside-desktop/plugin.js"

# Explicit all-profile mode installs UI only in real, existing profiles, and
# validates every target before writing anything. No implicit provider enable.
all_home="$temporary/all-profiles"
mkdir -p "$all_home/profiles/alpha" "$all_home/profiles/beta" "$all_home/profiles/not-a-profile"
printf 'memory: {}\n' > "$all_home/config.yaml"
printf 'memory: {provider: builtin}\n' > "$all_home/profiles/alpha/config.yaml"
cp "$all_home/profiles/alpha/config.yaml" "$all_home/profiles/beta/config.yaml"
PATH="$temporary/bin:$PATH" HERMES_PYTHON="$temporary/bin/python" "$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$all_home" --desktop-all-profiles --no-setup --no-deps --no-retrieval --no-model-providers >/dev/null
for profile in alpha beta; do
  cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$all_home/profiles/$profile/desktop-plugins/plur1bus/plugin.js"
  [[ "$(<"$all_home/profiles/$profile/config.yaml")" == 'memory: {provider: builtin}' ]]
  [[ ! -e "$all_home/profiles/$profile/plugins" ]]
done
[[ ! -e "$all_home/profiles/not-a-profile/desktop-plugins" ]]
ln -s "$temporary/outside-desktop" "$all_home/profiles/alpha/desktop-plugins/foreign"
mv "$all_home/profiles/beta/desktop-plugins/plur1bus" "$temporary/beta-before"
ln -s "$temporary/beta-before" "$all_home/profiles/beta/desktop-plugins/plur1bus"
if PATH="$temporary/bin:$PATH" HERMES_PYTHON="$temporary/bin/python" "$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$all_home" --desktop-all-profiles --no-setup --no-deps --no-retrieval --no-model-providers >/dev/null 2>&1; then
  printf 'All-profile installer followed a symbolic link\n' >&2
  exit 1
fi
