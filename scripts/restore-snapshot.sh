#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

DRY_RUN=true
SNAPSHOT_PATH=""

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --confirm)
      DRY_RUN=false
      ;;
    --help|-h)
      echo "Usage: $0 [--confirm] <snapshot-path>"
      echo ""
      echo "  Default: dry-run (shows what would be restored)"
      echo "  --confirm: actually restore"
      echo ""
      echo "Examples:"
      echo "  $0 ~/.openclaw/.snapshots/plur1bus-20260101-120000"
      echo "  $0 --confirm ~/.openclaw/.snapshots/plur1bus-20260101-120000"
      exit 0
      ;;
    -*)
      echo "Unknown option: $arg"
      exit 1
      ;;
    *)
      if [[ -n "${SNAPSHOT_PATH:-}" ]]; then
        echo "Error: multiple snapshot paths provided"
        exit 1
      fi
      SNAPSHOT_PATH="$arg"
      ;;
  esac
done

if [[ -z "${SNAPSHOT_PATH:-}" ]]; then
  echo "Error: no snapshot path provided"
  echo "Usage: $0 [--confirm] <snapshot-path>"
  exit 1
fi

if [[ ! -d "$SNAPSHOT_PATH" ]]; then
  echo "Error: snapshot directory does not exist: $SNAPSHOT_PATH"
  exit 1
fi

# Validate snapshot path with realpath (prefix match, not string contains)
SNAPSHOT_REAL="$(realpath "$SNAPSHOT_PATH")"
home_real="$(realpath "$OPENCLAW_HOME")"
snapshots_expected="$home_real/.snapshots"

case "$SNAPSHOT_REAL" in
  "$snapshots_expected"/*)
    ;;
  *)
    echo "Error: invalid snapshot path (must be inside $snapshots_expected)"
    exit 1
    ;;
esac

# Validate manifest exists
if [[ ! -f "$SNAPSHOT_PATH/manifest.json" ]]; then
  echo "Error: manifest.json missing in snapshot (not a valid snapshot?)"
  exit 1
fi

echo "=== Restore Report ==="
echo "Snapshot:    $SNAPSHOT_REAL"
echo "Mode:        $(if $DRY_RUN; then echo "DRY-RUN (use --confirm to restore)"; else echo "LIVE"; fi)"
echo ""

# The engine keeps run-state.json and .adaptive-learning/merge-proposals.jsonl in the
# workspace (default <OPENCLAW_HOME>/workspace, override with OPENCLAW_WORKSPACE_DIR).
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$OPENCLAW_HOME/workspace}"
workspace_real="$(realpath "$WORKSPACE_DIR" 2>/dev/null || true)"

# realpath of the nearest existing ancestor plus the not yet existing tail, so a
# destination below a directory that is created on restore still resolves.
resolve_existing_prefix() {
  local p="$1" tail=""
  while [[ ! -d "$p" && "$p" != "/" && "$p" != "." ]]; do
    tail="/$(basename "$p")$tail"
    p="$(dirname "$p")"
  done
  echo "$(realpath "$p" 2>/dev/null || echo "$p")$tail"
}

# Items to restore as "<path inside the snapshot>|<destination>" (same as backup).
# The two memory/ entries at the end only exist in snapshots made before the
# workspace fix; they go back where they were saved from.
RESTORE_ITEMS=(
  "memory/lancedb-namespaced|$OPENCLAW_HOME/memory/lancedb-namespaced"
  "memory/_archive|$OPENCLAW_HOME/memory/_archive"
  "workspace/run-state.json|$WORKSPACE_DIR/run-state.json"
  "vault|$OPENCLAW_HOME/vault"
  "workspace/.adaptive-learning/merge-proposals.jsonl|$WORKSPACE_DIR/.adaptive-learning/merge-proposals.jsonl"
  "memory/run-state.json|$OPENCLAW_HOME/memory/run-state.json"
  "memory/merge-proposals.jsonl|$OPENCLAW_HOME/memory/merge-proposals.jsonl"
)

# Tombstone-Registry: wird NICHT aus dem Snapshot restauriert (der Snapshot ist
# älter). Sie bleibt erhalten und wird nach dem Restore erneut angewendet.
TOMBSTONE_REGISTRY="memory/_tombstones"

# Safety backup of current state before live restore
if ! $DRY_RUN; then
  SAFETY_TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
  SAFETY_PATH="$snapshots_expected/pre-restore-safety-$SAFETY_TIMESTAMP"
  mkdir -p "$SAFETY_PATH"
  echo "Creating safety backup: $SAFETY_PATH"

  for item in "${RESTORE_ITEMS[@]}" "$TOMBSTONE_REGISTRY|$OPENCLAW_HOME/$TOMBSTONE_REGISTRY"; do
    rel="${item%%|*}"
    src="${item#*|}"
    dest="$SAFETY_PATH/$rel"
    if [[ -e "$src" ]]; then
      mkdir -p "$(dirname "$dest")"
      if [[ -d "$src" ]]; then
        cp -r "$src" "$dest"
      else
        cp -p "$src" "$dest"
      fi
    fi
  done

  cat > "$SAFETY_PATH/manifest.json" <<EOF
{
  "createdAt": "$SAFETY_TIMESTAMP",
  "reason": "pre-restore-safety",
  "restoredFrom": "$SNAPSHOT_REAL"
}
EOF
  echo "Safety backup created."
  echo ""
fi

RESTORED_COUNT=0
SKIPPED_COUNT=0

for item in "${RESTORE_ITEMS[@]}"; do
  rel="${item%%|*}"
  src="$SNAPSHOT_PATH/$rel"
  dest="${item#*|}"

  if [[ ! -e "$src" ]]; then
    echo "[SKIP] Missing in snapshot: $rel"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Validate destination would be inside OPENCLAW_HOME (or, for workspace files, the workspace)
  dest_parent="$(dirname "$dest")"
  dest_parent_real="$(resolve_existing_prefix "$dest_parent")"
  case "$dest_parent_real" in
    "$home_real"/*|"$home_real")
      ;;
    *)
      if [[ -n "$workspace_real" && "$rel" == workspace/* && ( "$dest_parent_real" == "$workspace_real" || "$dest_parent_real" == "$workspace_real"/* ) ]]; then
        :
      else
        echo "[SKIP] Would write outside OPENCLAW_HOME: $rel"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
      fi
      ;;
  esac

  if $DRY_RUN; then
    echo "[WOULD RESTORE] $rel"
    RESTORED_COUNT=$((RESTORED_COUNT + 1))
  else
    mkdir -p "$(dirname "$dest")"
    if [[ -d "$src" ]]; then
      rm -rf "$dest"
      cp -r "$src" "$dest"
    else
      cp -p "$src" "$dest"
    fi
    echo "[RESTORED] $rel"
    RESTORED_COUNT=$((RESTORED_COUNT + 1))
  fi
done

echo ""
echo "======================"
echo "Restored:    $RESTORED_COUNT items"
echo "Skipped:     $SKIPPED_COUNT items"
echo "======================"

# Tombstone-Reconciliation: nach dem Restore die erhaltene Tombstone-Registry
# erneut auf die wiederhergestellte LanceDB anwenden, damit keine nach dem
# Snapshot gelöschte Erinnerung reaktiviert wird.
if ! $DRY_RUN; then
  echo ""
  echo "Reapplying tombstones to restored state..."
  REAPPLY_OUTPUT="$(node "$(dirname "$0")/reapply-tombstones.mjs" --apply --base-db-path "$OPENCLAW_HOME/memory/lancedb-namespaced" 2>&1)" || {
    echo "ERROR: tombstone reconciliation failed — restore is INCOMPLETE (recovery state preserved at $SAFETY_PATH)."
    echo "$REAPPLY_OUTPUT"
    exit 1
  }
  echo "$REAPPLY_OUTPUT"
  echo "Tombstone reconciliation complete."
else
  echo ""
  echo "[DRY-RUN] Would reapply tombstones from $OPENCLAW_HOME/$TOMBSTONE_REGISTRY to the restored state."
fi

if ! $DRY_RUN; then
  echo ""
  echo "NOTE: If the gateway is running, restart it to apply restored state:"
  echo "  systemctl --user restart openclaw-gateway  (or equivalent)"
fi
