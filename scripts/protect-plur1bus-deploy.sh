#!/usr/bin/env bash
# protect-deploy.sh — guard the deployed PLUR1BUS extension against silent reverts.
#
# This is a tracked mirror of the live ops script. It runs in production from
# /root/.openclaw/scripts/protect-plur1bus-deploy.sh (outside this repo, on a
# */15 cron) — there is no automated sync between the two copies yet, so any
# change here must be applied there by hand too. See "Offene Risiken" in
# docs/superpowers/plans/2026-06-16-installer-deploy-integrity-followup.md.
#
# A `plugins update` (or a stale package install) can overwrite the deployed
# extension with code that is version-stamped but missing fixes. This guard
# compares the deployed runtime files against the canonical source and, if they
# drift (or the deployed code is missing required fix markers), restores the
# source and restarts the gateway.
#
# Config via env (sensible OpenClaw defaults):
#   PLUR1BUS_SRC      canonical plugin source     (default: /root)
#   PLUR1BUS_DEPLOY   installed extension path     (default: .openclaw extension)
#   PLUR1BUS_GW       systemd --user gateway unit  (default: openclaw-gateway.service)
#   PLUR1BUS_NO_RESTART=1  restore but do not restart the gateway
#
# 2026-06-16 incident: PLUR1BUS_SRC used to default to /root/plur1bus, a stale
# leftover subdirectory from a pre-restructure layout (real source moved to
# repo root). /root/plur1bus/lib/neo-arch.js had decayed into a broken
# `export * from "../../lib/neo-arch.js"` re-export stub — a path only valid
# inside the repo tree, not in this standalone deploy dir. Every legitimate
# deploy got silently "repaired" back into that stub by this very script.
# Default now points at the real source (repo root) and a stub-guard below
# refuses to ever propagate a broken re-export again, regardless of SRC.
# See docs/superpowers/plans/2026-06-16-installer-deploy-integrity-followup.md
#
# 2026-07-18: default SRC is now the pinned release checkout
# <openclaw-home>/plur1bus-release — a git worktree fixed at the tag of the
# INSTALLED version (maintained by the deploy step). A moving dev branch or a
# stale secondary checkout (the old /root default had decayed to 6.9.11 while
# 7.0.0 was installed) must never be the restore source. All path defaults
# derive from OPENCLAW_HOME (default: $HOME/.openclaw) so the guard also works
# on installs that don't live under /root.
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
SRC="${PLUR1BUS_SRC:-$OPENCLAW_HOME/plur1bus-release}"
DEPLOY="${PLUR1BUS_DEPLOY:-$OPENCLAW_HOME/extensions/memory-lancedb-namespaced}"
GW="${PLUR1BUS_GW:-openclaw-gateway.service}"
LOG="${PLUR1BUS_LOG:-$OPENCLAW_HOME/logs/protect-deploy.log}"

# Runtime files that carry the fixes and must always match source.
# NOTE: scripts/cleanup-stores.mjs is intentionally NOT listed here; the file
# does not exist in this repo and shipping a destructive cleanup helper would
# create deploy drift and an unnecessary foot-gun.
FILES=(
  index.js
  openclaw.plugin.json
  lib/neo-arch.js
  lib/runtime-scheduler.js
  lib/jobs/daily-consolidation.js
  lib/feedback-log.js
  lib/semantic-lens-index.js
  lib/conversation-reactivation-recall.js
  lib/relevant-memory-context.js
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

# Drift-Backup bewusst ausserhalb des Extension-Scan-Roots ablegen: ein Backup-
# Verzeichnis neben der Extension wuerde dieselbe Plugin-ID erneut deklarieren.
BK_ROOT="${PLUR1BUS_BACKUP_DIR:-/root/.openclaw-backups/plur1bus-drift}"
BK="$BK_ROOT/$(basename "${DEPLOY%/}").drift-bak-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$BK"
for f in "${FILES[@]}"; do
  [ -f "$DEPLOY/$f" ] && { mkdir -p "$BK/$(dirname "$f")"; cp -a "$DEPLOY/$f" "$BK/$f"; }
done
for m in openclaw.plugin.json package.json README.md LICENSE; do
  [ -f "$DEPLOY/$m" ] && cp -a "$DEPLOY/$m" "$BK/$m"
done
log "backed up drifted deploy -> $BK"

# Stub-guard: never propagate a broken re-export shim from SRC into DEPLOY.
# Reuses the exact detector that caught the 2026-06-16 incident, so this stays
# safe even if PLUR1BUS_SRC is ever pointed at a stale/partial directory again.
STUB_CHECKER="/root/scripts/lib/deploy-integrity.mjs"
source_file_is_broken_stub() {
  [ -f "$STUB_CHECKER" ] || return 1   # checker missing: don't block on it
  node --input-type=module -e "
    import { detectBrokenStub } from '$STUB_CHECKER';
    process.exit(detectBrokenStub(process.argv[1]).isBroken ? 0 : 1);
  " "$1" 2>/dev/null
}

# Restore canonical source over the deploy (code only; never touch node_modules/state).
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || continue
  if source_file_is_broken_stub "$SRC/$f"; then
    log "ERROR: refusing to propagate broken re-export stub from $SRC/$f — leaving deploy untouched for this file"
    continue
  fi
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
