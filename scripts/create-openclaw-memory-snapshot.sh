#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?Usage: $0 OPENCLAW_MEMORY_ROOT [DESTINATION]}"
destination="${2:-$source_root/.snapshots/plur1bus-hermes-$(date +%Y%m%d-%H%M%S)}"

if [[ ! -d "$source_root/lancedb-namespaced" ]]; then
  printf 'No lancedb-namespaced store under: %s\n' "$source_root" >&2
  exit 2
fi
if [[ -e "$destination" ]]; then
  printf 'Snapshot destination already exists: %s\n' "$destination" >&2
  exit 2
fi

install -d "$(dirname "$destination")"
rsync -a --exclude '.snapshots/' "$source_root/" "$destination/"
printf 'Created consistent migration snapshot: %s\n' "$destination"
