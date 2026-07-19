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
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

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
# Optional release metadata restored alongside runtime code. Together with
# FILES this is the single source of truth for preflight, copy, and equality.
METADATA_FILES=(
  package.json
  README.md
  LICENSE
)
RESTORE_FILES=("${FILES[@]}" "${METADATA_FILES[@]}")
# Marker that must be present in deployed code (proves the fix is in place).
MARKER_FILE="lib/neo-arch.js"
MARKER="isInjectedContextText"

mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"; }

[ -d "$SRC" ]    || { log "ERROR: source missing: $SRC"; exit 1; }
[ -d "$DEPLOY" ] || { log "ERROR: deploy missing: $DEPLOY"; exit 1; }
SRC="$(cd -- "$SRC" && pwd -P)"
DEPLOY="$(cd -- "$DEPLOY" && pwd -P)"

drift=0
reasons=()

# 1) marker check — deployed code must contain the fix marker
if ! grep -q "$MARKER" "$DEPLOY/$MARKER_FILE" 2>/dev/null; then
  drift=1; reasons+=("missing-marker:$MARKER")
fi

# 2) safety and md5 check — each restorable source must be a regular file,
# and every source file must have a matching deployed file and hash.
for f in "${RESTORE_FILES[@]}"; do
  if [ ! -e "$SRC/$f" ] && [ ! -L "$SRC/$f" ]; then
    continue
  fi
  if [ -L "$SRC/$f" ] || [ ! -f "$SRC/$f" ]; then
    drift=1; reasons+=("unsafe-source:$f")
    continue
  fi
  if [ ! -f "$DEPLOY/$f" ]; then
    drift=1; reasons+=("missing:$f")
    continue
  fi
  s=$(md5sum "$SRC/$f" 2>/dev/null | cut -d' ' -f1)
  d=$(md5sum "$DEPLOY/$f" 2>/dev/null | cut -d' ' -f1)
  if [ "$s" != "$d" ]; then drift=1; reasons+=("mismatch:$f"); fi
done

if [ "$drift" -eq 0 ]; then
  exit 0   # healthy, stay quiet (cron-friendly)
fi

log "DRIFT detected: ${reasons[*]}"

# Stub-guard: never propagate a broken re-export shim from SRC into DEPLOY.
# Resolve the checker beside this canonicalized script, or (for the installed
# mirror) inside the canonical pinned source repository. Missing, linked,
# unimportable, or incomplete checker state is an explicit fail-closed error.
SCRIPT_CHECKER="$SCRIPT_DIR/lib/deploy-integrity.mjs"
SOURCE_CHECKER="$SRC/scripts/lib/deploy-integrity.mjs"
if [ -e "$SCRIPT_CHECKER" ] || [ -L "$SCRIPT_CHECKER" ]; then
  STUB_CHECKER="$SCRIPT_CHECKER"
  CHECKER_ROOT="$SCRIPT_DIR"
elif [ -e "$SOURCE_CHECKER" ] || [ -L "$SOURCE_CHECKER" ]; then
  STUB_CHECKER="$SOURCE_CHECKER"
  CHECKER_ROOT="$SRC"
else
  log "ERROR: deploy-integrity checker missing: $SCRIPT_CHECKER and $SOURCE_CHECKER"
  exit 1
fi
if [ ! -f "$STUB_CHECKER" ] || [ -L "$STUB_CHECKER" ]; then
  log "ERROR: deploy-integrity checker missing or unsafe: $STUB_CHECKER"
  exit 1
fi
STUB_CHECKER_REAL="$(realpath -- "$STUB_CHECKER")" || {
  log "ERROR: deploy-integrity checker cannot be canonicalized: $STUB_CHECKER"
  exit 1
}
case "$STUB_CHECKER_REAL" in
  "$CHECKER_ROOT"/*) ;;
  *) log "ERROR: deploy-integrity checker escapes repository script location: $STUB_CHECKER_REAL"; exit 1 ;;
esac
if ! node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const checker = await import(pathToFileURL(process.argv[1]).href);
  if (typeof checker.detectBrokenStub !== "function") process.exit(1);
' "$STUB_CHECKER_REAL" >/dev/null 2>&1; then
  log "ERROR: deploy-integrity checker is broken or lacks detectBrokenStub: $STUB_CHECKER_REAL"
  exit 1
fi

source_file_is_broken_stub() {
  node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    try {
      const checker = await import(pathToFileURL(process.argv[1]).href);
      const result = checker.detectBrokenStub(process.argv[2]);
      process.exit(result.isBroken ? 0 : 1);
    } catch (error) {
      console.error(error?.message ?? error);
      process.exit(2);
    }
  ' "$STUB_CHECKER_REAL" "$1"
}

# Validate every source candidate before creating a backup or changing deploy.
for f in "${RESTORE_FILES[@]}"; do
  if [ ! -e "$SRC/$f" ] && [ ! -L "$SRC/$f" ]; then
    continue
  fi
  if [ -L "$SRC/$f" ] || [ ! -f "$SRC/$f" ]; then
    log "ERROR: refusing unsafe source candidate: $SRC/$f"
    exit 1
  fi
  case "$f" in
    *.js|*.mjs)
      if source_file_is_broken_stub "$SRC/$f" >/dev/null 2>&1; then
        log "ERROR: refusing to propagate broken re-export stub from $SRC/$f"
        exit 1
      else
        checker_status=$?
        if [ "$checker_status" -ne 1 ]; then
          log "ERROR: deploy-integrity checker failed for $SRC/$f (status=$checker_status)"
          exit 1
        fi
      fi
      ;;
  esac
done

# Drift-Backup bewusst ausserhalb des Extension-Scan-Roots ablegen: ein Backup-
# Verzeichnis neben der Extension wuerde dieselbe Plugin-ID erneut deklarieren.
BK_ROOT="${PLUR1BUS_BACKUP_DIR:-$HOME/.openclaw-backups/plur1bus-drift}"
BK="$BK_ROOT/$(basename "${DEPLOY%/}").drift-bak-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$BK"
for f in "${RESTORE_FILES[@]}"; do
  if [ -f "$DEPLOY/$f" ]; then
    mkdir -p "$BK/$(dirname "$f")"
    cp -a "$DEPLOY/$f" "$BK/$f"
  fi
done
log "backed up drifted deploy -> $BK"

# Restore canonical source over the deploy (code only; never touch node_modules/state).
for f in "${RESTORE_FILES[@]}"; do
  [ -f "$SRC/$f" ] || continue
  mkdir -p "$DEPLOY/$(dirname "$f")"
  cp -a "$SRC/$f" "$DEPLOY/$f"
done
log "restored canonical source from $SRC"

# Verify the restore took.
if ! grep -q "$MARKER" "$DEPLOY/$MARKER_FILE" 2>/dev/null; then
  log "ERROR: restore failed, marker still missing"
  exit 1
fi
for f in "${RESTORE_FILES[@]}"; do
  [ -f "$SRC/$f" ] || continue
  source_hash=$(md5sum "$SRC/$f" | cut -d' ' -f1)
  deploy_hash=$(md5sum "$DEPLOY/$f" 2>/dev/null | cut -d' ' -f1)
  if [ "$source_hash" != "$deploy_hash" ]; then
    log "ERROR: restore hash verification failed for $f"
    exit 1
  fi
done
log "verified restored file hashes from $SRC"

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
