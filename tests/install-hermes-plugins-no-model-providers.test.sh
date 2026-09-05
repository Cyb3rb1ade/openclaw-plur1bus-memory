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
[[ -f "$desktop_home/plugins/plur1bus/dashboard/manifest.json" ]]
mv "$desktop_home/desktop-plugins/plur1bus" "$temporary/outside-desktop"
ln -s "$temporary/outside-desktop" "$desktop_home/desktop-plugins/plur1bus"
if PATH="$temporary/bin:$PATH" HERMES_PYTHON="$temporary/bin/python" "$repo_dir/scripts/install-hermes-plugins.sh" \
  --hermes-home "$desktop_home" --desktop --no-setup --no-deps --no-retrieval --no-model-providers >/dev/null 2>&1; then
  printf 'Desktop installer followed a symbolic link\n' >&2
  exit 1
fi
cmp "$repo_dir/hermes-dashboard/plur1bus/desktop/plugin.js" "$temporary/outside-desktop/plugin.js"
