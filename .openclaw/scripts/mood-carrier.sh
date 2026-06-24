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
  # Args: state_path prev_path mood_file mood_tmp
  python3 - "$@" << 'PYEOF'
import sys, json, os

def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"mood carrier: cannot read {path}: {e}", file=sys.stderr)
        return None

state_path, prev_path, mood_file, mood_tmp = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

current = load_json(state_path)
if not current:
    sys.exit(1)

prev = load_json(prev_path)  # None is OK — trend will be unknown

# Persist current → prev (atomic)
try:
    tmp = prev_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(current, f)
    os.rename(tmp, prev_path)
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
    with open(mood_tmp, "w") as f:
        f.write(mood_content)
    os.rename(mood_tmp, mood_file)
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
  local mood_tmp="$workspace_dir/.current-mood.txt.tmp"

  if [ ! -f "$state_file" ]; then
    printf '[%s] mood carrier: state file missing, skip\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$log_file"
    # B-lite: write unknown marker atomically even when no state available
    printf 'mood: unknown\nupdated: %s\n' "$(date -Iseconds)" > "$mood_tmp" \
      && mv "$mood_tmp" "$mood_file" 2>/dev/null || true
    return 0
  fi

  local result
  result=$(_mood_carrier_python "$state_file" "$prev_file" "$mood_file" "$mood_tmp" 2>>"$log_file") || {
    printf '[%s] mood carrier: compute error, skip\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$log_file"
    return 0
  }

  if [ -n "$result" ]; then
    printf '[%s] mood carrier: block built\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$log_file"
    printf '%s' "$result"
  fi
}
