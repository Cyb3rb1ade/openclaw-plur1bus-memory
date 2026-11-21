#!/bin/bash
# Legacy compatibility wrapper for old prompts/memories.
# Prefer tts-auto.sh for new calls.
# Usage: tts-reply.sh <agent-id> "<response-text>"

set -e

AGENT_ID="$1"
RESPONSE_TEXT="$2"

case "$AGENT_ID" in
  bernhardine) WORKSPACE="/root/.openclaw/workspace-bernhardine" ;;
  heisenberg)  WORKSPACE="/root/.openclaw/workspace-heisenberg" ;;
  main)        WORKSPACE="/root/.openclaw/workspace" ;;
  *) exit 1 ;;
esac

AUTO="${WORKSPACE}/skills/telegram-tts-toggle/bin/tts-auto.sh"
RESULT=$("$AUTO" "$AGENT_ID" "$RESPONSE_TEXT" 2>/dev/null || true)

case "$RESULT" in
  OK:*)
    MEDIA_PATH="${RESULT#OK:}"
    echo ""
    echo "MEDIA:${MEDIA_PATH}"
    echo "[[audio_as_voice]]"
    ;;
esac
