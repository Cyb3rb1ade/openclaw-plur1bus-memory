#!/bin/bash
# TTS State Manager
# Usage: tts-manager.sh <command> <agent-id> [args...]

set -e

COMMAND="$1"
AGENT_ID="$2"
STATE_DIR="/root/.openclaw/settings/tts-toggle"
STATE_FILE="$STATE_DIR/${AGENT_ID}.json"

mkdir -p "$STATE_DIR"

# Initialize state if not exists
if [ ! -f "$STATE_FILE" ]; then
  case "$AGENT_ID" in
    bernhardine) DEFAULT_VOICE="el:KXxZd16DiBqt82nbarJx" ;;
    heisenberg)  DEFAULT_VOICE="el:K5ZVtkkBnuPY6YqXs70E" ;;
    *)           DEFAULT_VOICE="el:uM8iMoqaSe1eDaJiWfxf" ;;
  esac
  echo "{\"enabled\":false,\"voice\":\"$DEFAULT_VOICE\"}" > "$STATE_FILE"
fi

case "$COMMAND" in
  enable)
    jq '.enabled = true | .lastUsed = now | .lastUsed |= todate' "$STATE_FILE" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
    echo "✅ TTS enabled for $AGENT_ID"
    ;;

  disable)
    jq '.enabled = false | .lastUsed = now | .lastUsed |= todate' "$STATE_FILE" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
    echo "✅ TTS disabled for $AGENT_ID"
    ;;

  set-voice)
    VOICE="$3"
    if [ -z "$VOICE" ]; then
      echo "❌ Usage: tts-manager.sh set-voice <agent-id> <voice>" >&2
      exit 1
    fi
    # Validate voice
    case "$VOICE" in
      el-*|el:*)
        if ! /root/.openclaw/tools/elevenlabs-tts.py voice-ok "$VOICE"; then
          echo "❌ Unknown ElevenLabs voice: $VOICE. Use el-otto, el-ben, el-mark, el-susi, el-lea, el-ava or el:<voice_id>." >&2
          exit 1
        fi
        jq --arg voice "$VOICE" '.voice = $voice | .lastUsed = now | .lastUsed |= todate' "$STATE_FILE" > "${STATE_FILE}.tmp"
        mv "${STATE_FILE}.tmp" "$STATE_FILE"
        echo "✅ Voice set to: $VOICE"
        ;;
      thorsten|thorsten-medium|miro|dii|glados|kerstin|ramona|\
      edge-katja|edge-amala|edge-killia|edge-florian|edge-seraphina|edge-conrad|edge-william|\
      *Neural)
        jq --arg voice "$VOICE" '.voice = $voice | .lastUsed = now | .lastUsed |= todate' "$STATE_FILE" > "${STATE_FILE}.tmp"
        mv "${STATE_FILE}.tmp" "$STATE_FILE"
        echo "✅ Voice set to: $VOICE"
        ;;
      *)
        echo "❌ Unknown voice: $VOICE. Local: thorsten, miro, dii, glados, kerstin, ramona. Cloud aliases: edge-katja, edge-amala, edge-killia, edge-florian, edge-seraphina, edge-conrad, edge-william. Full Microsoft voice IDs ending in Neural are also allowed." >&2
        exit 1
        ;;
    esac
    ;;

  get-voice)
    jq -r '.voice' "$STATE_FILE"
    ;;

  is-enabled)
    ENABLED=$(jq -r '.enabled' "$STATE_FILE")
    if [ "$ENABLED" = "true" ]; then
      exit 0
    else
      exit 1
    fi
    ;;

  status)
    VOICE=$(jq -r '.voice' "$STATE_FILE")
    ENABLED=$(jq -r '.enabled' "$STATE_FILE")
    LAST_USED=$(jq -r '.lastUsed // ""' "$STATE_FILE")
    case "$VOICE" in
      el-*|el:*)      ENGINE="elevenlabs" ;;
      edge-*|*Neural) ENGINE="edge-tts" ;;
      *)      ENGINE="piper" ;;
    esac
    case "$AGENT_ID" in
      main)        FALLBACK_VOICE="miro" ;;
      bernhardine) FALLBACK_VOICE="dii" ;;
      heisenberg)  FALLBACK_VOICE="thorsten" ;;
      *)           FALLBACK_VOICE="thorsten" ;;
    esac
    jq -n \
      --arg agentId "$AGENT_ID" \
      --arg enabled "$ENABLED" \
      --arg voice "$VOICE" \
      --arg engine "$ENGINE" \
      --arg fallbackVoice "$FALLBACK_VOICE" \
      --arg fallbackEngine "piper" \
      --arg lastUsed "$LAST_USED" \
      '{
        agentId: $agentId,
        enabled: ($enabled == "true"),
        voice: $voice,
        engine: $engine,
        fallbackVoice: $fallbackVoice,
        fallbackEngine: $fallbackEngine,
        lastUsed: (if $lastUsed == "" then null else $lastUsed end)
      }'
    ;;

  list-voices)
    echo "Available TTS voices:"
    echo ""
    echo "--- Lokal (offline, schnell ~0.2s) ---"
    echo "  thorsten        - Männlich, natürlich (high)"
    echo "  thorsten-medium - Männlich, leichter (medium)"
    echo "  miro            - Männlich, weich (high)"
    echo "  dii             - Weiblich (high)"
    echo "  glados          - Weiblich, Roboter/Portal (high)"
    echo "  kerstin         - Weiblich (low)"
    echo "  ramona          - Weiblich (low)"
    echo ""
    echo "--- Edge TTS (cloud, neural, ~1.5-2s) ---"
    echo "  edge-katja      - Weiblich  (de-DE-KatjaNeural)"
    echo "  edge-amala      - Weiblich  (de-DE-AmalaNeural)"
    echo "  edge-seraphina  - Weiblich  (el:KXxZd16DiBqt82nbarJx)"
    echo "  edge-killia     - Männlich  (el:K5ZVtkkBnuPY6YqXs70E)"
    echo "  edge-florian    - Männlich  (el:uM8iMoqaSe1eDaJiWfxf)"
    echo "  edge-conrad     - Männlich  (de-DE-ConradNeural)"
    echo "  edge-william    - Männlich  (en-AU-WilliamMultilingualNeural)"
    echo ""
    /root/.openclaw/tools/elevenlabs-tts.py voices 2>/dev/null || echo "  (ElevenLabs-Katalog nicht lesbar)"
    echo ""
    echo "Defaults: main=el:uM8iMoqaSe1eDaJiWfxf, bernhardine=el:KXxZd16DiBqt82nbarJx, heisenberg=el:K5ZVtkkBnuPY6YqXs70E"
    ;;

  *)
    echo "Usage: tts-manager.sh <command> <agent-id> [args]" >&2
    echo "" >&2
    echo "Commands:" >&2
    echo "  enable <agent-id>              - Enable TTS" >&2
    echo "  disable <agent-id>             - Disable TTS" >&2
    echo "  set-voice <agent-id> <voice>   - Set voice" >&2
    echo "  get-voice <agent-id>           - Get current voice" >&2
    echo "  is-enabled <agent-id>          - Check if enabled (exit 0/1)" >&2
    echo "  status <agent-id>              - Show status" >&2
    echo "  list-voices                    - List available voices" >&2
    exit 1
    ;;
esac
