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
