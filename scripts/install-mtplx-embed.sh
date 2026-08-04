#!/usr/bin/env bash
# Install the MTPLX embedding/reranking sidecar into $HERMES_HOME.
#
# The copy has to live outside ~/Documents because the LaunchAgent that runs it
# has no Full Disk Access, and macOS TCC denies such processes execute access to
# the Documents folder.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hermes_home="${HERMES_HOME:-$HOME/.hermes}"
install_agent=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hermes-home)
      hermes_home="${2:?missing path after --hermes-home}"
      shift 2
      ;;
    --no-agent)
      install_agent=0
      shift
      ;;
    *)
      printf 'Usage: %s [--hermes-home PATH] [--no-agent]\n' "$0" >&2
      exit 2
      ;;
  esac
done

target="$hermes_home/mtplx-embed"
install -d "$target" "$hermes_home/bin"
rsync -a --delete --exclude '__pycache__/' --exclude '*.pyc' \
  "$repo_dir/mtplx-embed/src/mtplx_embed/" "$target/mtplx_embed/"
install -m 0755 "$repo_dir/scripts/mtplx-embed" "$hermes_home/bin/mtplx-embed"

printf 'installed sidecar to %s\n' "$target"

if [[ "$install_agent" == "1" ]]; then
  HERMES_HOME="$hermes_home" MTPLX_EMBED_LAUNCHER="$hermes_home/bin/mtplx-embed" \
    "$repo_dir/scripts/install-mtplx-embed-agent.sh"
fi
