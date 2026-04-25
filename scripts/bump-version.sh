#!/usr/bin/env bash
# bump-version.sh — synchronisiert die Plugin-Version in allen Manifest-Dateien.
#
# Usage:
#   ./scripts/bump-version.sh 1.8.3        # set explicit version
#   ./scripts/bump-version.sh patch        # increment patch (1.8.2 → 1.8.3)
#   ./scripts/bump-version.sh minor        # increment minor (1.8.2 → 1.9.0)
#   ./scripts/bump-version.sh major        # increment major (1.8.2 → 2.0.0)
#   ./scripts/bump-version.sh check        # nur prüfen, kein Schreiben
#
# Was wird geändert:
#   extensions/memory-lancedb-namespaced/openclaw.plugin.json (.version)
#   extensions/memory-lancedb-namespaced/package.json (.version)
#
# Was sollte SEPARAT manuell gepflegt werden:
#   CHANGELOG.md (neue Section am Anfang mit dem Bump-Grund)
#   git tag v<version>

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$REPO_DIR/extensions/memory-lancedb-namespaced/openclaw.plugin.json"
PACKAGE="$REPO_DIR/extensions/memory-lancedb-namespaced/package.json"
CHANGELOG="$REPO_DIR/CHANGELOG.md"

[[ -f "$MANIFEST" ]] || { echo "FATAL: Manifest fehlt: $MANIFEST" >&2; exit 1; }
[[ -f "$PACKAGE"  ]] || { echo "FATAL: Package fehlt: $PACKAGE"   >&2; exit 1; }
[[ -f "$CHANGELOG" ]] || { echo "FATAL: CHANGELOG fehlt: $CHANGELOG" >&2; exit 1; }

current_manifest=$(jq -r '.version' "$MANIFEST")
current_package=$(jq -r '.version' "$PACKAGE")
current_changelog=$(grep -oE '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$CHANGELOG" | head -1 | sed 's/^## \[\(.*\)\]/\1/')

echo "Current versions:"
echo "  manifest:  $current_manifest"
echo "  package:   $current_package"
echo "  changelog: $current_changelog"

if [[ "${1:-check}" == "check" ]]; then
  if [[ "$current_manifest" == "$current_package" && "$current_package" == "$current_changelog" ]]; then
    echo
    echo "✓ Alle Versionen identisch ($current_manifest)"
    exit 0
  else
    echo
    echo "✗ Versions-Drift erkannt!"
    echo "  Repariere mit:  $0 $current_changelog"
    exit 1
  fi
fi

# Compute target version
case "${1:-}" in
  patch|minor|major)
    IFS='.' read -r MA MI PA <<< "$current_changelog"
    case "$1" in
      patch) PA=$((PA + 1)) ;;
      minor) MI=$((MI + 1)); PA=0 ;;
      major) MA=$((MA + 1)); MI=0; PA=0 ;;
    esac
    target="$MA.$MI.$PA"
    ;;
  [0-9]*)
    target="$1"
    [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "FATAL: ungültige Version: $target" >&2; exit 1; }
    ;;
  *)
    echo "Usage: $0 <version|patch|minor|major|check>" >&2
    exit 1
    ;;
esac

echo
echo "Setze Versionen auf: $target"

# Manifest
tmp=$(mktemp)
jq --arg v "$target" '.version = $v' "$MANIFEST" > "$tmp" && mv "$tmp" "$MANIFEST"
echo "  ✓ $MANIFEST"

# Package
tmp=$(mktemp)
jq --arg v "$target" '.version = $v' "$PACKAGE" > "$tmp" && mv "$tmp" "$PACKAGE"
echo "  ✓ $PACKAGE"

echo
echo "Nächste Schritte (manuell):"
echo "  1. CHANGELOG.md mit neuer Section am Anfang ergänzen"
echo "  2. git add -A && git commit -m 'feat(v$target): ...'"
echo "  3. git tag -a v$target -m 'v$target — ...'"
echo "  4. git push origin main && git push origin v$target"
