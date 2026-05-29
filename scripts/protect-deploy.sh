#!/usr/bin/env bash
# protect-deploy.sh — guard the deployed PLUR1BUS extension against silent reverts.
#
# A `plugins update` (or a stale package install) can overwrite the deployed
# extension with code that is version-stamped but missing fixes. This guard
# compares the deployed runtime files against the canonical source and, if they
# drift (or the deployed code is missing required fix markers), restores the
# source and restarts the gateway.
#
# Config via env (sensible OpenClaw defaults):
#   PLUR1BUS_SRC      canonical plugin source     (default: /root/plur1bus)
#   PLUR1BUS_DEPLOY   installed extension path     (default: .openclaw extension)
#   PLUR1BUS_GW       systemd --user gateway unit  (default: openclaw-gateway.service)
#   PLUR1BUS_NO_RESTART=1  restore but do not restart the gateway
set -euo pipefail

SRC="${PLUR1BUS_SRC:-/root/plur1bus}"
DEPLOY="${PLUR1BUS_DEPLOY:-/root/.openclaw/extensions/memory-lancedb-namespaced}"
GW="${PLUR1BUS_GW:-openclaw-gateway.service}"
LOG="${PLUR1BUS_LOG:-/root/.openclaw/logs/protect-deploy.log}"

# Runtime files that carry the fixes and must always match source.
FILES=(
  index.js
  lib/neo-arch.js
  lib/runtime-scheduler.js
  lib/jobs/daily-consolidation.js
  scripts/cleanup-stores.mjs
  test/neo-maintenance.test.js
)
# Marker that must be present in deployed code (proves the fix is in place).
MARKER_FILE="lib/neo-arch.js"
MARKER="isInjectedContextText"

mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"; }

[ -d "$SRC" ]    || { log "ERROR: source missing: $SRC"; exit 1; }
[ -d "$DEPLOY" ] || { log "ERROR: deploy missing: $DEPLOY"; exit 1; }

drift=0
reasons=()

# 1) marker check — deployed code must contain the fix marker
if ! grep -q "$MARKER" "$DEPLOY/$MARKER_FILE" 2>/dev/null; then
  drift=1; reasons+=("missing-marker:$MARKER")
fi

# 2) md5 check — each runtime file must match source
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || continue   # only enforce files that exist in source
  s=$(md5sum "$SRC/$f" 2>/dev/null | cut -d' ' -f1)
  d=$(md5sum "$DEPLOY/$f" 2>/dev/null | cut -d' ' -f1)
  if [ "$s" != "$d" ]; then drift=1; reasons+=("mismatch:$f"); fi
done

if [ "$drift" -eq 0 ]; then
  exit 0   # healthy, stay quiet (cron-friendly)
fi

log "DRIFT detected: ${reasons[*]}"

# Back up the drifted deploy before overwriting.
BK="${DEPLOY%/}.drift-bak-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$BK"
for f in "${FILES[@]}"; do
  [ -f "$DEPLOY/$f" ] && { mkdir -p "$BK/$(dirname "$f")"; cp -a "$DEPLOY/$f" "$BK/$f"; }
done
for m in openclaw.plugin.json package.json; do
  [ -f "$DEPLOY/$m" ] && cp -a "$DEPLOY/$m" "$BK/$m"
done
log "backed up drifted deploy -> $BK"

# Restore canonical source over the deploy (code only; never touch node_modules/state).
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || continue
  mkdir -p "$DEPLOY/$(dirname "$f")"
  cp -a "$SRC/$f" "$DEPLOY/$f"
done
# Keep version metadata in sync so the deploy reports the right version.
for m in openclaw.plugin.json package.json README.md LICENSE; do
  [ -f "$SRC/$m" ] && cp -a "$SRC/$m" "$DEPLOY/$m"
done
log "restored canonical source from $SRC"

# Verify the restore took.
if ! grep -q "$MARKER" "$DEPLOY/$MARKER_FILE" 2>/dev/null; then
  log "ERROR: restore failed, marker still missing"
  exit 1
fi

if [ "${PLUR1BUS_NO_RESTART:-0}" = "1" ]; then
  log "restore complete (restart suppressed by PLUR1BUS_NO_RESTART)"
  exit 0
fi

if systemctl --user restart "$GW" 2>>"$LOG"; then
  log "gateway restarted ($GW)"
else
  log "WARN: gateway restart failed ($GW) — restore is on disk, restart manually"
fi
exit 0
