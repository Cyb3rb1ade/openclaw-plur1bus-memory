#!/usr/bin/env bash
# Install (or refresh) the LaunchAgent that keeps the MTPLX chat daemon running.
#
# Unlike the embedding sidecar, MTPLX loads its weights eagerly, so this agent
# holds the model in memory for as long as it runs. Only install it when MTPLX
# is meant to be the permanent chat backend — otherwise start it on demand with
# scripts/mtplx-hermes-up.
set -euo pipefail

label="com.plur1bus.mtplx"
port="${MTPLX_PORT:-18085}"
api_key="${MTPLX_API_KEY:-mtplx-local}"
model="${MTPLX_MODEL:-Jonandrop/Ornith-1.0-35B-MTPLX-Vision}"
profile="${MTPLX_PROFILE:-sustained}"
mtplx_bin="${MTPLX_BIN:-$HOME/.mtplx/bin/mtplx}"
log_dir="${HERMES_HOME:-$HOME/.hermes}/logs"
plist="$HOME/Library/LaunchAgents/$label.plist"
depth="${MTPLX_DEPTH:-}"
# MTPLX serves retrieval natively since the /v1/embeddings + /v1/rerank
# endpoints landed; these replace the former standalone sidecar.
embedding_model="${MTPLX_EMBEDDING_MODEL:-}"
reranker_model="${MTPLX_RERANKER_MODEL:-}"
max_resident="${MTPLX_RETRIEVAL_MAX_RESIDENT:-}"
# Artifacts whose mtplx_runtime.json predates the current contract schema are
# refused by the server even when `mtplx forge verify` passes their quality
# rows. Opting in trades MTPLX's exactness guarantee for the measured speed.
force_unverified="${MTPLX_FORCE_UNVERIFIED:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall)
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      rm -f "$plist"
      printf 'removed %s\n' "$label"
      exit 0
      ;;
    --model) model="${2:?missing model after --model}"; shift 2 ;;
    --port) port="${2:?missing port after --port}"; shift 2 ;;
    --profile) profile="${2:?missing profile after --profile}"; shift 2 ;;
    --depth) depth="${2:?missing depth after --depth}"; shift 2 ;;
    --embedding-model) embedding_model="${2:?missing model after --embedding-model}"; shift 2 ;;
    --reranker-model) reranker_model="${2:?missing model after --reranker-model}"; shift 2 ;;
    --retrieval-max-resident) max_resident="${2:?missing value}"; shift 2 ;;
    --force-unverified) force_unverified=1; shift ;;
    *)
      printf 'Usage: %s [--model REF] [--port N] [--profile NAME] [--depth N] [--force-unverified] [--uninstall]\n' "$0" >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$mtplx_bin" ]]; then
  printf 'MTPLX launcher not found at %s\n' "$mtplx_bin" >&2
  exit 1
fi

install -d "$log_dir" "$HOME/Library/LaunchAgents"

extra_args=""
if [[ -n "$depth" ]]; then
  extra_args+="        <string>--depth</string>
        <string>$depth</string>
"
fi
if [[ "$force_unverified" == "1" ]]; then
  extra_args+="        <string>--unsafe-force-unverified</string>
"
fi
if [[ -n "$embedding_model" ]]; then
  extra_args+="        <string>--embedding-model</string>
        <string>$embedding_model</string>
"
fi
if [[ -n "$reranker_model" ]]; then
  extra_args+="        <string>--reranker-model</string>
        <string>$reranker_model</string>
"
fi
if [[ -n "$max_resident" ]]; then
  extra_args+="        <string>--retrieval-max-resident</string>
        <string>$max_resident</string>
"
fi

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$mtplx_bin</string>
        <string>quickstart</string>
        <string>--model</string>
        <string>$model</string>
        <string>--port</string>
        <string>$port</string>
        <string>--profile</string>
        <string>$profile</string>
        <string>--api-key</string>
        <string>$api_key</string>
        <string>--yes</string>
$extra_args    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$log_dir/mtplx-server.log</string>
    <key>StandardErrorPath</key>
    <string>$log_dir/mtplx-server.log</string>
</dict>
</plist>
PLIST

# bootout is asynchronous: bootstrapping while the old job still holds the
# label fails with "Input/output error" (5). Wait for the label to clear.
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
for _ in $(seq 1 30); do
  launchctl list 2>/dev/null | grep -qE "[[:space:]]$label\$" || break
  sleep 1
done
launchctl bootstrap "gui/$(id -u)" "$plist"

printf 'installed %s: model=%s port=%s profile=%s\n' "$label" "$model" "$port" "$profile"
printf 'log: %s/mtplx-server.log\n' "$log_dir"
