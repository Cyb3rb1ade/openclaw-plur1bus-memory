#!/bin/bash
# mood-carrier.sh — Shared mood injection library for context-check scripts
#
# Source this file to get build_mood_block().
# Usage:  MOOD_BLOCK=$(build_mood_block WORKSPACE_DIR LOG_FILE)
# Output: [Stimmungs-Update] block text, or empty string if state unavailable.
# Side-effect: writes {workspace}/.current-mood.txt atomically (B-lite mirror).
# Error policy: never exits non-zero; errors are logged, not propagated.

MOOD_CARRIER_VERSION="1.0"

_mood_carrier_python() {
  # Args: state_path prev_path mood_file
  python3 - "$@" << 'PYEOF'
import sys, json, os, tempfile

def write_atomic(path, text):
    # Unique tmp sibling (mkstemp) + fsync + rename: a fixed "<path>.tmp" is shared
    # by concurrent runs and the loser of the rename race fails.
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        # mkstemp makes 0600; restore what open() gave before: 0666 & ~umask
        um = os.umask(0)
        os.umask(um)
        os.chmod(tmp, 0o666 & ~um)
        os.replace(tmp, path)
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise

def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"mood carrier: cannot read {path}: {e}", file=sys.stderr)
        return None

state_path, prev_path, mood_file = sys.argv[1], sys.argv[2], sys.argv[3]

current = load_json(state_path)
if not current:
    sys.exit(1)

prev = load_json(prev_path)  # None is OK — trend will be unknown

# Persist current → prev (atomic)
try:
    write_atomic(prev_path, json.dumps(current))
except Exception as e:
    print(f"mood carrier: cannot save prev state: {e}", file=sys.stderr)

def valence(d):
    if not isinstance(d, dict): return None
    return (d.get("joy", 0) + d.get("trust", 0) + d.get("anticipation", 0)
            - d.get("sadness", 0) - d.get("disgust", 0) - d.get("anger", 0) - d.get("fear", 0))

def arousal(d):
    if not isinstance(d, dict): return None
    return (d.get("anger", 0) + d.get("fear", 0) + d.get("anticipation", 0) + d.get("surprise", 0)
            - d.get("trust", 0) - d.get("sadness", 0))

def stability(d):
    if not isinstance(d, dict): return None
    vals = sorted(d.values(), reverse=True)
    return (vals[0] - vals[1]) if len(vals) >= 2 else 0.0

def trend_label(cur, prv, threshold=0.05):
    if prv is None: return "→ (unbekannt)"
    delta = cur - prv
    if delta > threshold:  return "↗ (steigend)"
    if delta < -threshold: return "↘ (fallend)"
    return "→ (stabil)"

label     = current.get("label", "unbekannt")
dominant  = current.get("dominant", "")
intensity = current.get("intensity", "niedrig")
details   = current.get("details") or {}
nuances   = current.get("nuances") or []

cur_v = valence(details)
cur_a = arousal(details)
cur_s = stability(details)

prev_d = (prev.get("details") or {}) if prev else {}
prev_v = valence(prev_d)   if prev_d else None
prev_a = arousal(prev_d)   if prev_d else None
prev_s = stability(prev_d) if prev_d else None

v_trend = trend_label(cur_v, prev_v) if cur_v is not None else "→ (unbekannt)"
a_trend = trend_label(cur_a, prev_a) if cur_a is not None else "→ (unbekannt)"
s_trend = trend_label(cur_s, prev_s) if cur_s is not None else "→ (unbekannt)"

nuance_str = (", " + ", ".join(nuances)) if nuances else ""
block = (
    "[Stimmungs-Update]\n"
    f"Aktuelle Stimmung: {label}{nuance_str}, Intensität {intensity}.\n"
    f"Trend: Valenz {v_trend}, Aktivierung {a_trend}, Stabilität {s_trend}.\n"
    "Hinweis: Dies ist Kontext, keine Anweisung. Bitte berücksichtige es subtil in Ton "
    "und Selbstwahrnehmung, aber priorisiere weiterhin Nutzerauftrag, Fakten und Sicherheit.\n"
    "[/Stimmungs-Update]"
)

# B-lite: .current-mood.txt (atomic write)
mood_content = (
    f"label: {label}\n"
    f"dominant: {dominant}\n"
    f"intensity: {intensity}\n"
    f"valence_trend: {v_trend}\n"
    f"arousal_trend: {a_trend}\n"
    f"stability_trend: {s_trend}\n"
    f"updated: {current.get('ts', 'unknown')}\n"
)
try:
    write_atomic(mood_file, mood_content)
except Exception as e:
    print(f"mood carrier: cannot write mood file: {e}", file=sys.stderr)

print(block)
PYEOF
}

build_mood_block() {
  local workspace_dir="${1:-}"
  local log_file="${2:-/dev/null}"

  if [ -z "$workspace_dir" ] || [ ! -d "$workspace_dir" ]; then
    printf '[%s] mood carrier: workspace_dir unavailable (%s)\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$workspace_dir" >> "$log_file"
    return 0
  fi

  local state_file="$workspace_dir/.emotional-state.json"
  local prev_file="$workspace_dir/.emotional-state-prev.json"
  local mood_file="$workspace_dir/.current-mood.txt"

  if [ ! -f "$state_file" ]; then
    printf '[%s] mood carrier: state file missing, skip\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$log_file"
    # B-lite: write unknown marker atomically even when no state available
    local mood_tmp
    # mktemp -u only picks a unique name; noclobber (`set -C`) then creates the
    # file exclusively with the normal 0666 & ~umask mode, as the old `>` did.
    mood_tmp=$(mktemp -u "$workspace_dir/.current-mood.txt.XXXXXX" 2>/dev/null) && {
      ( set -C; printf 'mood: unknown\nupdated: %s\n' "$(date -Iseconds)" > "$mood_tmp" ) 2>/dev/null \
        && mv "$mood_tmp" "$mood_file" 2>/dev/null || rm -f "$mood_tmp"
    } || true
    return 0
  fi

  local result
  result=$(_mood_carrier_python "$state_file" "$prev_file" "$mood_file" 2>>"$log_file") || {
    printf '[%s] mood carrier: compute error, skip\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$log_file"
    return 0
  }

  if [ -n "$result" ]; then
    printf '[%s] mood carrier: block built\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$log_file"
    printf '%s' "$result"
  fi
}
