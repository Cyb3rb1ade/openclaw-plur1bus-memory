#!/bin/bash
# TTS Audio Generator for German voices
# Usage: tts-generate.sh <text> <voice> <output-file>
#
# Local voices (sherpa-onnx/Piper): thorsten, miro, dii, glados, kerstin, ramona
# ElevenLabs (cloud, Abo):         el-otto, el-ben, el-mark, el-susi, el-lea, el-ava, el:<voice_id>
# Edge TTS voices (neural, cloud):  edge-katja, edge-amala, edge-killia,
#                                   edge-florian, edge-seraphina, edge-conrad,
#                                   edge-william or full Microsoft voice IDs

set -e

TEXT="$1"
VOICE="${2:-thorsten}"
OUTPUT="${3:-/tmp/tts-output.wav}"

# Exact ElevenLabs words are prepared once by the shared adapter.
AGENT_ID="$4"
case "$VOICE" in
  el-*|el:*)
    case "$AGENT_ID" in main|bernhardine|heisenberg) ;; *) echo "ERR:missing agent identity" >&2; exit 1;; esac
    if printf '%s' "$TEXT" | python3 /root/.openclaw/tools/plur1bus-speech-bridge.py single "$AGENT_ID" "$VOICE" "$OUTPUT"; then
      [ -s "$OUTPUT" ] && exit 0
    fi
    echo "ERR:ElevenLabs generation failed" >&2
    exit 1
    ;;
esac

# sherpa-onnx paths
RUNTIME_DIR="/root/.openclaw/tools/sherpa-onnx-tts/runtime"
MODELS_DIR="/root/.openclaw/tools/sherpa-onnx-tts/models"

# Filter thinking/reasoning blocks from text
filter_text() {
  echo "$1" | sed -E '
    /<thinking>/,/<\/thinking>/d
    /<extended-thinking>/,/<\/extended-thinking>/d
    /<reasoning>/,/<\/reasoning>/d
    /^##? (Thinking|Reasoning|Extended Thinking)/,/^$/d
  ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

FILTERED_TEXT=$(filter_text "$TEXT")

if [ -z "$FILTERED_TEXT" ]; then
  echo "❌ No text to convert after filtering" >&2
  exit 1
fi

# Truncate if too long (max 5000 chars)
if [ ${#FILTERED_TEXT} -gt 5000 ]; then
  FILTERED_TEXT="${FILTERED_TEXT:0:5000}..."
fi

# Ensure text ends with punctuation — Edge TTS cuts off last words without it
last_char="${FILTERED_TEXT: -1}"
if [[ "$last_char" != "." && "$last_char" != "!" && "$last_char" != "?" && "$last_char" != "…" ]]; then
  FILTERED_TEXT="${FILTERED_TEXT}."
fi

# --- Edge TTS (cloud, neural quality) ---
case "$VOICE" in
  edge-katja)     EDGE_VOICE="de-DE-KatjaNeural" ;;
  edge-amala)     EDGE_VOICE="de-DE-AmalaNeural" ;;
  edge-killia)    EDGE_VOICE="de-DE-KillianNeural" ;;
  edge-florian)   EDGE_VOICE="de-DE-FlorianMultilingualNeural" ;;
  edge-seraphina) EDGE_VOICE="de-DE-SeraphinaMultilingualNeural" ;;
  edge-conrad)    EDGE_VOICE="de-DE-ConradNeural" ;;
  edge-william)   EDGE_VOICE="en-AU-WilliamMultilingualNeural" ;;
  *Neural)       EDGE_VOICE="$VOICE" ;;
  edge-*)
    echo "❌ Unknown edge voice: $VOICE. Use an alias (edge-katja, edge-amala, edge-killia, edge-florian, edge-seraphina, edge-conrad, edge-william) or a full Microsoft voice ID ending in Neural." >&2
    exit 1
    ;;
esac

if [ -n "${EDGE_VOICE:-}" ]; then
  TMP_MP3="${OUTPUT%.wav}.mp3"
  edge-tts --voice "$EDGE_VOICE" --text "$FILTERED_TEXT" --write-media "$TMP_MP3" 2>/dev/null
  # Convert MP3→WAV so caller gets consistent format
  ffmpeg -y -i "$TMP_MP3" "$OUTPUT" >/dev/null 2>&1
  rm -f "$TMP_MP3"
  if [ -f "$OUTPUT" ]; then
    echo "✅ Audio generated (edge/$EDGE_VOICE): $OUTPUT"
  else
    echo "❌ Edge TTS generation failed" >&2
    exit 1
  fi
  exit 0
fi

# --- Local Piper/sherpa-onnx ---
case "$VOICE" in
  thorsten|miro|dii|glados)
    MODEL_DIR="$MODELS_DIR/vits-piper-de_DE-${VOICE}-high"
    ;;
  thorsten-medium)
    MODEL_DIR="$MODELS_DIR/vits-piper-de_DE-thorsten-medium"
    ;;
  kerstin|ramona)
    MODEL_DIR="$MODELS_DIR/vits-piper-de_DE-${VOICE}-low"
    ;;
  *)
    echo "❌ Unknown voice: $VOICE. Local: thorsten, miro, dii, glados, kerstin, ramona. Cloud aliases: edge-katja, edge-amala, edge-killia, edge-florian, edge-seraphina, edge-conrad, edge-william. Full Microsoft voice IDs ending in Neural are also allowed." >&2
    exit 1
    ;;
esac

if [ ! -d "$MODEL_DIR" ]; then
  echo "❌ Model not found: $MODEL_DIR" >&2
  exit 1
fi

ONNX_FILE=$(find "$MODEL_DIR" -name "*.onnx" -type f | head -1)
if [ -z "$ONNX_FILE" ]; then
  echo "❌ No .onnx file found in $MODEL_DIR" >&2
  exit 1
fi

"$RUNTIME_DIR/bin/sherpa-onnx-offline-tts" \
  --vits-model="$ONNX_FILE" \
  --vits-tokens="$MODEL_DIR/tokens.txt" \
  --vits-data-dir="$MODEL_DIR/espeak-ng-data" \
  --output-filename="$OUTPUT" \
  "$FILTERED_TEXT" 2>&1 | grep -v "parse-options.cc" || true

if [ -f "$OUTPUT" ]; then
  echo "✅ Audio generated: $OUTPUT"
else
  echo "❌ Audio generation failed" >&2
  exit 1
fi
