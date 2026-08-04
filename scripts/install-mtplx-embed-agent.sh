#!/usr/bin/env bash
# Install (or refresh) the LaunchAgent that keeps the MTPLX embedding and
# reranking sidecar available for PLUR1BUS memory. The models load lazily, so
# an idle agent costs an interpreter process rather than model memory.
set -euo pipefail

label="com.plur1bus.mtplx-embed"
port="${MTPLX_EMBED_PORT:-18086}"
api_key="${MTPLX_EMBED_API_KEY:-mtplx-local}"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
log_dir="$hermes_home/logs"
plist="$HOME/Library/LaunchAgents/$label.plist"

# launchd runs without Full Disk Access, so the launcher must sit outside
# ~/Documents — otherwise macOS TCC refuses to execute it (exit code 126).
launcher="${MTPLX_EMBED_LAUNCHER:-$hermes_home/bin/mtplx-embed}"

uninstall=0
if [[ "${1:-}" == "--uninstall" ]]; then
  uninstall=1
fi

if [[ "$uninstall" == "1" ]]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  printf 'removed %s\n' "$label"
  exit 0
fi

if [[ ! -x "$launcher" ]]; then
  printf 'mtplx-embed launcher not found at %s — run scripts/install-mtplx-embed.sh first\n' "$launcher" >&2
  exit 1
fi

install -d "$log_dir" "$HOME/Library/LaunchAgents"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$launcher</string>
        <string>--host</string>
        <string>127.0.0.1</string>
        <string>--port</string>
        <string>$port</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>MTPLX_EMBED_API_KEY</key>
        <string>$api_key</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Adaptive</string>
    <key>StandardOutPath</key>
    <string>$log_dir/mtplx-embed.log</string>
    <key>StandardErrorPath</key>
    <string>$log_dir/mtplx-embed.log</string>
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

printf 'installed %s on port %s (log: %s/mtplx-embed.log)\n' "$label" "$port" "$log_dir"
