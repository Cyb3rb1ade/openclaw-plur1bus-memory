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

# Paths to restore (same as backup)
RESTORE_PATHS=(
  "memory/lancedb-namespaced"
  "memory/_archive"
  "memory/run-state.json"
  "vault"
  "memory/merge-proposals.jsonl"
)

# Safety backup of current state before live restore
if ! $DRY_RUN; then
  SAFETY_TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
  SAFETY_PATH="$snapshots_expected/pre-restore-safety-$SAFETY_TIMESTAMP"
  mkdir -p "$SAFETY_PATH"
  echo "Creating safety backup: $SAFETY_PATH"

  for rel in "${RESTORE_PATHS[@]}"; do
    src="$OPENCLAW_HOME/$rel"
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

for rel in "${RESTORE_PATHS[@]}"; do
  src="$SNAPSHOT_PATH/$rel"
  dest="$OPENCLAW_HOME/$rel"

  if [[ ! -e "$src" ]]; then
    echo "[SKIP] Missing in snapshot: $rel"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Validate destination would be inside OPENCLAW_HOME
  dest_parent="$(dirname "$dest")"
  dest_parent_real="$(realpath "$dest_parent" 2>/dev/null || echo "$dest_parent")"
  case "$dest_parent_real" in
    "$home_real"/*|"$home_real")
      ;;
    *)
      echo "[SKIP] Would write outside OPENCLAW_HOME: $rel"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
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

if ! $DRY_RUN; then
  echo ""
  echo "NOTE: If the gateway is running, restart it to apply restored state:"
  echo "  systemctl --user restart openclaw-gateway  (or equivalent)"
fi
