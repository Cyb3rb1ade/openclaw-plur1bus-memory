#!/bin/bash
# TTS Reply Helper - Generates MEDIA directive if TTS enabled
# Usage: tts-auto.sh <agent-id> "<response-text>"
# Selected ElevenLabs voice is kept across languages; legacy voices may use Piper.

AGENT_ID="$1"
RESPONSE_TEXT="$2"
case "$AGENT_ID" in main|bernhardine|heisenberg) ;; *) echo "ERR:invalid agent" >&2; exit 1;; esac

# Bail out if text is empty or whitespace-only (prevents silent audio)
if [ -z "$(echo "$RESPONSE_TEXT" | tr -d '[:space:]')" ]; then
    exit 0
fi

# Piper fallback voice per agent
declare -A FALLBACK_VOICE
FALLBACK_VOICE[main]="miro"
FALLBACK_VOICE[bernhardine]="dii"
FALLBACK_VOICE[heisenberg]="thorsten"

# Determine workspace path based on agent
if [ "$AGENT_ID" = "bernhardine" ]; then
    WORKSPACE="/root/.openclaw/workspace-bernhardine"
    TMP_PREFIX="/tmp/openclaw/tts-response-bernhardine"
elif [ "$AGENT_ID" = "heisenberg" ]; then
    WORKSPACE="/root/.openclaw/workspace-heisenberg"
    TMP_PREFIX="/tmp/openclaw/tts-response-heisenberg"
else
    WORKSPACE="/root/.openclaw/workspace"
    TMP_PREFIX="/tmp/openclaw/tts-response"
fi

mkdir -p /tmp/openclaw
RUN_ID="$(date +%Y%m%d-%H%M%S-%N)-$$"
TMP_FILE="${TMP_PREFIX}-${RUN_ID}"

MANAGER="${WORKSPACE}/skills/telegram-tts-toggle/bin/tts-manager.sh"
GENERATOR="${WORKSPACE}/skills/telegram-tts-toggle/bin/tts-generate.sh"

# Check if TTS is enabled
if ! $MANAGER is-enabled "$AGENT_ID" >/dev/null 2>&1; then
    exit 0
fi

# Get configured voice
VOICE=$($MANAGER get-voice "$AGENT_ID" 2>/dev/null || echo "thorsten")

# Generate with the selected voice. Never send another speaker/language silently.
if "$GENERATOR" "$RESPONSE_TEXT" "$VOICE" "${TMP_FILE}.wav" "$AGENT_ID" >/dev/null; then
    :
else
    case "$VOICE" in
      el-*|el:*)
        echo "ERR:TTS generation failed for $AGENT_ID ($VOICE); text response remains available" >&2
        rm -f "${TMP_FILE}.wav"
        exit 1
        ;;
    esac
    FALLBACK="${FALLBACK_VOICE[$AGENT_ID]:-thorsten}"
    echo "WARN:TTS falling back to Piper ($FALLBACK) for $AGENT_ID" >&2
    if ! "$GENERATOR" "$RESPONSE_TEXT" "$FALLBACK" "${TMP_FILE}.wav" "$AGENT_ID" >/dev/null; then
        echo "ERR:TTS fallback failed for $AGENT_ID" >&2
        rm -f "${TMP_FILE}.wav"
        exit 1
    fi
fi

# Only advertise a freshly generated, nonempty Telegram audio file.
if [ ! -s "${TMP_FILE}.wav" ] || ! ffmpeg -y -v error -i "${TMP_FILE}.wav" -c:a libopus -b:a 64k "${TMP_FILE}.ogg"; then
    echo "ERR:TTS audio conversion failed for $AGENT_ID" >&2
    rm -f "${TMP_FILE}.wav" "${TMP_FILE}.ogg"
    exit 1
fi
rm -f "${TMP_FILE}.wav"
if [ ! -s "${TMP_FILE}.ogg" ]; then
    echo "ERR:TTS audio is empty for $AGENT_ID" >&2
    rm -f "${TMP_FILE}.ogg"
    exit 1
fi

echo "OK:${TMP_FILE}.ogg"
