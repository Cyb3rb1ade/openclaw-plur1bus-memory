#!/bin/bash
# Bilingual TTS - generates German + Polish audio
# Usage: tts-bilingual.sh <agent-id> "<german-text>" "<polish-text>"
# Output (one or both lines, only if TTS enabled):
#   OK_DE:/path/to/de.ogg
#   OK_PL:/path/to/pl.ogg

AGENT_ID="$1"
DE_TEXT="$2"
PL_TEXT="$3"
[ "$AGENT_ID" = bernhardine ] || { echo "ERR:invalid agent" >&2; exit 1; }

WORKSPACE="/root/.openclaw/workspace-bernhardine"
MANAGER="${WORKSPACE}/skills/telegram-tts-toggle/bin/tts-manager.sh"
GENERATOR="${WORKSPACE}/skills/telegram-tts-toggle/bin/tts-generate.sh"

if ! "$MANAGER" is-enabled "$AGENT_ID" >/dev/null 2>&1; then
    exit 0
fi

mkdir -p /tmp/openclaw

RUN_ID="$(date +%Y%m%d-%H%M%S-%N)-$$"
DE_OUT="/tmp/openclaw/tts-response-${AGENT_ID}-${RUN_ID}-de"
PL_OUT="/tmp/openclaw/tts-response-${AGENT_ID}-${RUN_ID}-pl"

DE_VOICE=$("$MANAGER" get-voice "$AGENT_ID" 2>/dev/null || echo "de-DE-SeraphinaMultilingualNeural")
PL_VOICE="pl-PL-ZofiaNeural"
DE_FALLBACK_VOICE="dii"
case "$DE_VOICE" in
    el-*|el:*)
        # One ElevenLabs speaker for every language, including mixed text.
        PL_VOICE="$DE_VOICE"
        DE_FALLBACK_VOICE=""
        ;;
esac

case "$DE_VOICE" in
    el-*|el:*)
        python3 -c 'import json,sys; print(json.dumps([{ "id":"de", "text":sys.argv[1] }, { "id":"pl", "text":sys.argv[2] }]))' "$DE_TEXT" "$PL_TEXT" |
          python3 /root/.openclaw/tools/plur1bus-speech-bridge.py bilingual "$AGENT_ID" "$DE_VOICE" "/tmp/openclaw/tts-response-${AGENT_ID}-${RUN_ID}"
        exit $?
        ;;
esac

requested=0
generated=0

if [ -n "$(echo "$DE_TEXT" | tr -d '[:space:]')" ]; then
    requested=$((requested + 1))
    if "$GENERATOR" "$DE_TEXT" "$DE_VOICE" "${DE_OUT}.wav" >/dev/null \
        || { [ -n "$DE_FALLBACK_VOICE" ] && "$GENERATOR" "$DE_TEXT" "$DE_FALLBACK_VOICE" "${DE_OUT}.wav" >/dev/null; }; then
        if [ -s "${DE_OUT}.wav" ] && ffmpeg -y -v error -i "${DE_OUT}.wav" -c:a libopus -b:a 64k "${DE_OUT}.ogg" && [ -s "${DE_OUT}.ogg" ]; then
            echo "OK_DE:${DE_OUT}.ogg"
            generated=$((generated + 1))
        else
            echo "ERR_DE:conversion_failed" >&2
            rm -f "${DE_OUT}.ogg"
        fi
    else
        echo "ERR_DE:generation_failed" >&2
    fi
    rm -f "${DE_OUT}.wav"
fi

if [ -n "$(echo "$PL_TEXT" | tr -d '[:space:]')" ]; then
    requested=$((requested + 1))
    if "$GENERATOR" "$PL_TEXT" "$PL_VOICE" "${PL_OUT}.wav" >/dev/null; then
        if [ -s "${PL_OUT}.wav" ] && ffmpeg -y -v error -i "${PL_OUT}.wav" -c:a libopus -b:a 64k "${PL_OUT}.ogg" && [ -s "${PL_OUT}.ogg" ]; then
            echo "OK_PL:${PL_OUT}.ogg"
            generated=$((generated + 1))
        else
            echo "ERR_PL:conversion_failed" >&2
            rm -f "${PL_OUT}.ogg"
        fi
    else
        echo "ERR_PL:generation_failed" >&2
    fi
    rm -f "${PL_OUT}.wav"
fi

if [ "$generated" -lt "$requested" ]; then
    exit 1
fi
