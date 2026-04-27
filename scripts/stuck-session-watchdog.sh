#!/usr/bin/env bash
# Watchdog for stuck OpenClaw sessions (GitHub #71127)
# Detects sessions stuck in "processing" state for > ABORT_THRESHOLD_S seconds
# and triggers a SIGUSR1 soft-restart to recover without full gateway restart.
#
# Run via cron every minute:
#   * * * * * /root/.openclaw/scripts/stuck-session-watchdog.sh >> /tmp/openclaw/watchdog.log 2>&1

ABORT_THRESHOLD_S=${OPENCLAW_STUCK_ABORT_S:-600}   # default: 10 minutes
LOG_FILE="/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
STATE_FILE="/tmp/openclaw/stuck-watchdog-state.json"

# Ensure state dir exists
mkdir -p /tmp/openclaw

now_s=$(date +%s)

# Parse current stuck sessions from gateway log
# Format: "stuck session: sessionId=X sessionKey=Y state=processing age=Xs"
declare -A current_stuck  # key → age_s

if [ -f "$LOG_FILE" ]; then
    while IFS= read -r line; do
        if [[ "$line" =~ \"stuck session:.*age=([0-9]+)s\" ]] || \
           [[ "$line" =~ stuck\ session:.*sessionId=([^\ ]+).*age=([0-9]+)s ]]; then
            session_id="${BASH_REMATCH[1]}"
            age_s="${BASH_REMATCH[2]}"
            # Also try JSON log format
            if [[ "$line" =~ \"sessionId\":\"([^\"]+)\" ]]; then
                session_id="${BASH_REMATCH[1]}"
            fi
            if [ -n "$session_id" ] && [ -n "$age_s" ]; then
                current_stuck["$session_id"]="$age_s"
            fi
        fi
    done < <(grep -a "stuck session:" "$LOG_FILE" 2>/dev/null | tail -200)
fi

# Check if any session has been stuck beyond threshold
for session_id in "${!current_stuck[@]}"; do
    age_s="${current_stuck[$session_id]}"
    if [ "$age_s" -ge "$ABORT_THRESHOLD_S" ]; then
        # Check we haven't already triggered for this session recently
        last_trigger=$(python3 -c "
import json, sys
try:
    d = json.load(open('$STATE_FILE'))
    print(d.get('$session_id', 0))
except: print(0)
" 2>/dev/null)

        cooldown=300  # 5 min cooldown between triggers for same session
        if [ $((now_s - last_trigger)) -lt $cooldown ]; then
            echo "[watchdog] $(date -Iseconds) session $session_id stuck ${age_s}s — cooldown active, skipping"
            continue
        fi

        echo "[watchdog] $(date -Iseconds) TRIGGER: session $session_id stuck for ${age_s}s (threshold=${ABORT_THRESHOLD_S}s) — sending SIGUSR1 soft-restart"

        # Record trigger timestamp
        python3 - "$STATE_FILE" "$session_id" "$now_s" << 'PYEOF'
import json, sys
state_file, session_id, ts = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    d = json.load(open(state_file))
except: d = {}
d[session_id] = ts
with open(state_file, 'w') as f: json.dump(d, f)
PYEOF

        # Send SIGUSR1 to gateway for soft restart (keeps config, restores channels)
        systemctl --user kill -s SIGUSR1 openclaw-gateway.service 2>/dev/null && \
            echo "[watchdog] SIGUSR1 sent to openclaw-gateway" || \
            echo "[watchdog] ERROR: failed to send SIGUSR1"

        # Only trigger once per watchdog run
        exit 0
    fi
done

# Clean up stale state entries (older than 1 hour)
if [ -f "$STATE_FILE" ]; then
    python3 - "$STATE_FILE" "$now_s" << 'PYEOF'
import json, sys
state_file, now_s = sys.argv[1], int(sys.argv[2])
try:
    d = json.load(open(state_file))
    d = {k: v for k, v in d.items() if now_s - v < 3600}
    with open(state_file, 'w') as f: json.dump(d, f)
except: pass
PYEOF
fi
