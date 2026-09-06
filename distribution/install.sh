#!/usr/bin/env sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -eq 0 ]; then set -- --interactive; fi
if [ -n "${PLUR1BUS_PYTHON:-}" ]; then
  exec "$PLUR1BUS_PYTHON" "$base/installer.py" --bundle "$base" "$@"
fi
# A native Hermes interpreter is preferred; no system package installation.
hermes_root=${HERMES_HOME:-"$HOME/.hermes"}
if [ -x "$hermes_root/hermes-agent/venv/bin/python" ]; then
  exec "$hermes_root/hermes-agent/venv/bin/python" "$base/installer.py" --bundle "$base" "$@"
fi
exec python3 "$base/installer.py" --bundle "$base" "$@"
