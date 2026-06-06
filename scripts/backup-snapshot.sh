#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
SNAPSHOT_DIR="$OPENCLAW_HOME/.snapshots"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SNAPSHOT_PATH="$SNAPSHOT_DIR/plur1bus-$TIMESTAMP"

# Paths to back up (all relative to OPENCLAW_HOME)
BACKUP_PATHS=(
  "memory/lancedb-namespaced"
  "memory/_archive"
  "memory/run-state.json"
  "vault"
  "memory/merge-proposals.jsonl"
)

mkdir -p "$SNAPSHOT_PATH"

SAVED_COUNT=0
SKIPPED_COUNT=0
TOTAL_SIZE=0

home_real="$(realpath "$OPENCLAW_HOME")"

for rel in "${BACKUP_PATHS[@]}"; do
  src="$OPENCLAW_HOME/$rel"
  dest="$SNAPSHOT_PATH/$rel"

  if [[ ! -e "$src" ]]; then
    echo "[SKIP] Missing (optional): $rel"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Validate source is inside OPENCLAW_HOME (resolve symlinks for validation)
  src_real="$(realpath "$src")"
  case "$src_real" in
    "$home_real"/*) ;;
    *)
      echo "[SKIP] Outside OPENCLAW_HOME: $rel"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
      ;;
  esac

  # Skip if source itself is a symlink
  if [[ -L "$src" ]]; then
    echo "[SKIP] Symlink: $rel"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  mkdir -p "$(dirname "$dest")"

  if [[ -d "$src" ]]; then
    # cp -R preserves symlinks as symlinks; cp -r follows them on macOS
    cp -R "$src" "$dest"
    # Remove any symlinks from the snapshot (do not follow them)
    find "$dest" -type l -delete 2>/dev/null || true
    SAVED_COUNT=$((SAVED_COUNT + 1))
  else
    cp -p "$src" "$dest"
    SAVED_COUNT=$((SAVED_COUNT + 1))
  fi

  # Calculate size from the cleaned snapshot (symlinks already removed)
  if [[ -d "$dest" ]]; then
    size=$(find "$dest" -type f -exec stat -f%z {} + 2>/dev/null | awk '{sum+=$1} END {print sum}')
  else
    size=$(stat -f%z "$dest" 2>/dev/null)
  fi
  size="${size:-0}"
  TOTAL_SIZE=$((TOTAL_SIZE + size))
done

# Write manifest
cat > "$SNAPSHOT_PATH/manifest.json" <<EOF
{
  "createdAt": "$TIMESTAMP",
  "openclawHome": "$OPENCLAW_HOME",
  "savedCount": $SAVED_COUNT,
  "skippedCount": $SKIPPED_COUNT,
  "totalSizeBytes": $TOTAL_SIZE
}
EOF

echo ""
echo "=== Backup Report ==="
echo "Snapshot:    $SNAPSHOT_PATH"
echo "Saved:       $SAVED_COUNT items"
echo "Skipped:     $SKIPPED_COUNT items"
echo "Total size:  $(numfmt --to=iec-i $TOTAL_SIZE 2>/dev/null || echo "${TOTAL_SIZE} bytes")"
echo "====================="
