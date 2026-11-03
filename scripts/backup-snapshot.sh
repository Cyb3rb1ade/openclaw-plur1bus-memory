#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
SNAPSHOT_DIR="$OPENCLAW_HOME/.snapshots"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SNAPSHOT_PATH="$SNAPSHOT_DIR/plur1bus-$TIMESTAMP"

# The engine writes run-state.json and .adaptive-learning/merge-proposals.jsonl in
# the workspace, not under memory/. Default <OPENCLAW_HOME>/workspace; set
# OPENCLAW_WORKSPACE_DIR for a different workspace.
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$OPENCLAW_HOME/workspace}"

# Items to back up as "<source>|<path inside the snapshot>"
BACKUP_ITEMS=(
  "$OPENCLAW_HOME/memory/lancedb-namespaced|memory/lancedb-namespaced"
  "$OPENCLAW_HOME/memory/_archive|memory/_archive"
  "$WORKSPACE_DIR/run-state.json|workspace/run-state.json"
  "$OPENCLAW_HOME/vault|vault"
  "$WORKSPACE_DIR/.adaptive-learning/merge-proposals.jsonl|workspace/.adaptive-learning/merge-proposals.jsonl"
)

mkdir -p "$SNAPSHOT_PATH"

SAVED_COUNT=0
SKIPPED_COUNT=0
TOTAL_SIZE=0

home_real="$(realpath "$OPENCLAW_HOME")"
# A workspace outside OPENCLAW_HOME is allowed as its own root, nothing else is.
workspace_real="$(realpath "$WORKSPACE_DIR" 2>/dev/null || true)"

for item in "${BACKUP_ITEMS[@]}"; do
  src="${item%%|*}"
  rel="${item#*|}"
  dest="$SNAPSHOT_PATH/$rel"

  if [[ ! -e "$src" ]]; then
    echo "[SKIP] Missing (optional): $rel"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Validate source is inside OPENCLAW_HOME or the workspace (resolve symlinks for validation)
  src_real="$(realpath "$src")"
  case "$src_real" in
    "$home_real"/*) ;;
    *)
      if [[ -n "$workspace_real" && "$rel" == workspace/* && "$src_real" == "$workspace_real"/* ]]; then
        :
      else
        echo "[SKIP] Outside OPENCLAW_HOME: $rel"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
      fi
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

  # Calculate size from the cleaned snapshot (symlinks already removed).
  # Portable byte count: wc -c works on BSD/macOS and GNU/Linux alike
  # (avoids BSD-only `stat -f%z` vs GNU `stat -c%s`).
  if [[ -d "$dest" ]]; then
    size=$(find "$dest" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
  else
    size=$(wc -c < "$dest" 2>/dev/null | tr -d ' ')
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
