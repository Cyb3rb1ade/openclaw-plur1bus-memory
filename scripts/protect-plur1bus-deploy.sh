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

SOURCE_MISSING=10
SOURCE_UNSAFE=11
SRC_ROOT_ID="$(stat -c '%d:%i' -- "$SRC" 2>/dev/null)" || {
  log "ERROR: source root cannot be identified: $SRC"
  exit 1
}

SOURCE_CANDIDATE_REAL=""
SOURCE_CANDIDATE_ID=""
SOURCE_CANDIDATE_HASH=""
SOURCE_CANDIDATE_ERROR=""

inspect_source_candidate() {
  local rel="$1"
  local remainder="$1"
  local component
  local current="$SRC"
  local current_root_id

  SOURCE_CANDIDATE_REAL=""
  SOURCE_CANDIDATE_ID=""
  SOURCE_CANDIDATE_HASH=""
  SOURCE_CANDIDATE_ERROR=""

  if [ -L "$SRC" ] || [ ! -d "$SRC" ]; then
    SOURCE_CANDIDATE_ERROR="source root is no longer a real directory"
    return "$SOURCE_UNSAFE"
  fi
  current_root_id="$(stat -c '%d:%i' -- "$SRC" 2>/dev/null)" || {
    SOURCE_CANDIDATE_ERROR="source root cannot be identified"
    return "$SOURCE_UNSAFE"
  }
  if [ "$current_root_id" != "$SRC_ROOT_ID" ]; then
    SOURCE_CANDIDATE_ERROR="source root changed after canonicalization"
    return "$SOURCE_UNSAFE"
  fi

  case "$rel" in
    ""|/*)
      SOURCE_CANDIDATE_ERROR="invalid relative allowlist path"
      return "$SOURCE_UNSAFE"
      ;;
  esac

  while :; do
    component="${remainder%%/*}"
    case "$component" in
      ""|.|..)
        SOURCE_CANDIDATE_ERROR="invalid allowlist path component: $component"
        return "$SOURCE_UNSAFE"
        ;;
    esac
    current="$current/$component"
    if [ -L "$current" ]; then
      SOURCE_CANDIDATE_ERROR="symlink component: $current"
      return "$SOURCE_UNSAFE"
    fi
    if [ ! -e "$current" ]; then
      return "$SOURCE_MISSING"
    fi
    if [ "$remainder" = "$component" ]; then
      break
    fi
    if [ ! -d "$current" ]; then
      SOURCE_CANDIDATE_ERROR="non-directory parent component: $current"
      return "$SOURCE_UNSAFE"
    fi
    remainder="${remainder#*/}"
  done

  if [ ! -f "$current" ]; then
    SOURCE_CANDIDATE_ERROR="final candidate is not a regular file: $current"
    return "$SOURCE_UNSAFE"
  fi
  SOURCE_CANDIDATE_REAL="$(realpath -e -- "$current" 2>/dev/null)" || {
    SOURCE_CANDIDATE_ERROR="candidate cannot be canonicalized: $current"
    return "$SOURCE_UNSAFE"
  }
  case "$SOURCE_CANDIDATE_REAL" in
    "$SRC"/*) ;;
    *)
      SOURCE_CANDIDATE_ERROR="candidate escapes canonical source root: $SOURCE_CANDIDATE_REAL"
      return "$SOURCE_UNSAFE"
      ;;
  esac
  SOURCE_CANDIDATE_ID="$(stat -c '%d:%i' -- "$SOURCE_CANDIDATE_REAL" 2>/dev/null)" || {
    SOURCE_CANDIDATE_ERROR="candidate cannot be identified: $SOURCE_CANDIDATE_REAL"
    return "$SOURCE_UNSAFE"
  }
  SOURCE_CANDIDATE_HASH="$(md5sum -- "$SOURCE_CANDIDATE_REAL" 2>/dev/null | cut -d' ' -f1)" || {
    SOURCE_CANDIDATE_ERROR="candidate cannot be hashed: $SOURCE_CANDIDATE_REAL"
    return "$SOURCE_UNSAFE"
  }
  if [ -z "$SOURCE_CANDIDATE_HASH" ]; then
    SOURCE_CANDIDATE_ERROR="candidate produced an empty hash: $SOURCE_CANDIDATE_REAL"
    return "$SOURCE_UNSAFE"
  fi
  return 0
}

drift=0
reasons=()

# 1) marker check — deployed code must contain the fix marker
if ! grep -q "$MARKER" "$DEPLOY/$MARKER_FILE" 2>/dev/null; then
  drift=1; reasons+=("missing-marker:$MARKER")
fi

# 2) safety and md5 check — each restorable source must be a regular file,
# and every source file must have a matching deployed file and hash.
for f in "${RESTORE_FILES[@]}"; do
  if inspect_source_candidate "$f"; then
    source_status=0
  else
    source_status=$?
  fi
  if [ "$source_status" -eq "$SOURCE_MISSING" ]; then
    continue
  fi
  if [ "$source_status" -eq "$SOURCE_UNSAFE" ]; then
    log "ERROR: refusing unsafe source candidate: $SRC/$f ($SOURCE_CANDIDATE_ERROR)"
    exit 1
  fi
  if [ ! -f "$DEPLOY/$f" ]; then
    drift=1; reasons+=("missing:$f")
    continue
  fi
  deploy_hash=$(md5sum -- "$DEPLOY/$f" 2>/dev/null | cut -d' ' -f1)
  if [ "$SOURCE_CANDIDATE_HASH" != "$deploy_hash" ]; then drift=1; reasons+=("mismatch:$f"); fi
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

# Capture every source candidate before creating a backup or changing deploy.
declare -A PREFLIGHT_STATE=()
declare -A PREFLIGHT_REAL=()
declare -A PREFLIGHT_ID=()
declare -A PREFLIGHT_HASH=()
declare -A PREFLIGHT_STUB=()
for f in "${RESTORE_FILES[@]}"; do
  if inspect_source_candidate "$f"; then
    source_status=0
  else
    source_status=$?
  fi
  if [ "$source_status" -eq "$SOURCE_MISSING" ]; then
    PREFLIGHT_STATE["$f"]="absent"
    PREFLIGHT_STUB["$f"]="not-applicable"
    continue
  fi
  if [ "$source_status" -eq "$SOURCE_UNSAFE" ]; then
    log "ERROR: refusing unsafe source candidate: $SRC/$f ($SOURCE_CANDIDATE_ERROR)"
    exit 1
  fi
  PREFLIGHT_STATE["$f"]="present"
  PREFLIGHT_REAL["$f"]="$SOURCE_CANDIDATE_REAL"
  PREFLIGHT_ID["$f"]="$SOURCE_CANDIDATE_ID"
  PREFLIGHT_HASH["$f"]="$SOURCE_CANDIDATE_HASH"
  PREFLIGHT_STUB["$f"]="not-applicable"
  case "$f" in
    *.js|*.mjs)
      if source_file_is_broken_stub "$SOURCE_CANDIDATE_REAL" >/dev/null 2>&1; then
        log "ERROR: refusing to propagate broken re-export stub from $SOURCE_CANDIDATE_REAL"
        exit 1
      else
        checker_status=$?
        if [ "$checker_status" -ne 1 ]; then
          log "ERROR: deploy-integrity checker failed for $SOURCE_CANDIDATE_REAL (status=$checker_status)"
          exit 1
        fi
      fi
      PREFLIGHT_STUB["$f"]="safe"
      ;;
  esac
done

source_candidate_matches_preflight() {
  local rel="$1"
  local source_status

  if inspect_source_candidate "$rel"; then
    source_status=0
  else
    source_status=$?
  fi
  if [ "${PREFLIGHT_STATE[$rel]}" = "absent" ]; then
    [ "$source_status" -eq "$SOURCE_MISSING" ]
    return
  fi
  [ "$source_status" -eq 0 ] || return 1
  [ "$SOURCE_CANDIDATE_REAL" = "${PREFLIGHT_REAL[$rel]}" ] || return 1
  [ "$SOURCE_CANDIDATE_ID" = "${PREFLIGHT_ID[$rel]}" ] || return 1
  [ "$SOURCE_CANDIDATE_HASH" = "${PREFLIGHT_HASH[$rel]}" ] || return 1
}

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

# Revalidate the complete source snapshot after backup and before any restore.
for f in "${RESTORE_FILES[@]}"; do
  if ! source_candidate_matches_preflight "$f"; then
    log "ERROR: source candidate changed after preflight: $f${SOURCE_CANDIDATE_ERROR:+ ($SOURCE_CANDIDATE_ERROR)}"
    exit 1
  fi
done

# Restore canonical source over the deploy (code only; never touch node_modules/state).
for f in "${RESTORE_FILES[@]}"; do
  [ "${PREFLIGHT_STATE[$f]}" = "present" ] || continue
  mkdir -p "$DEPLOY/$(dirname "$f")"
  if ! source_candidate_matches_preflight "$f"; then
    log "ERROR: source candidate changed after preflight: $f${SOURCE_CANDIDATE_ERROR:+ ($SOURCE_CANDIDATE_ERROR)}"
    exit 1
  fi
  cp -a -- "${PREFLIGHT_REAL[$f]}" "$DEPLOY/$f"
done
log "restored canonical source from $SRC"

# Verify the restore took.
if ! grep -q "$MARKER" "$DEPLOY/$MARKER_FILE" 2>/dev/null; then
  log "ERROR: restore failed, marker still missing"
  exit 1
fi
for f in "${RESTORE_FILES[@]}"; do
  [ "${PREFLIGHT_STATE[$f]}" = "present" ] || continue
  deploy_hash=$(md5sum -- "$DEPLOY/$f" 2>/dev/null | cut -d' ' -f1)
  if [ "${PREFLIGHT_HASH[$f]}" != "$deploy_hash" ]; then
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
