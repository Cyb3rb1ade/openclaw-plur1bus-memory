#!/usr/bin/env bash
# OpenClaw 2026.4.29 compatibility patch entrypoint.
#
# Kept as a versioned wrapper so apply-memory-patches.sh can dispatch by the
# installed OpenClaw version without renaming the historical hotfix script.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$script_dir/apply-plur1bus-user-hotfix.sh" "$@"
