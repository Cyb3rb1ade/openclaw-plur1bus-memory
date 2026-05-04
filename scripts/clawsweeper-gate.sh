#!/usr/bin/env bash
# clawsweeper-gate.sh — Upstream-Review-Gate für update-openclaw.sh
#
# Konsumiert Commit-Reviews aus dem öffentlichen Repo
# openclaw/clawsweeper-state (Branch: state) und meldet Befunde für die
# Commit-Range zwischen aktueller und Ziel-Version von openclaw.
#
# Verwendung:
#   clawsweeper-gate.sh <current-version> [target-version] [--no-block]
#   clawsweeper-gate.sh "$(openclaw --version)"
#
# Verhalten:
#   - Findings (high/medium/low) werden aufgelistet.
#   - Bei Findings + interaktiver Shell + ohne --no-block → pause (ENTER).
#   - Netzwerk-/Tag-Fehler werden zu warn herabgestuft, exit 0.
#   - Reports sind immutable → 24h-Cache unter $CLAWSWEEPER_GATE_CACHE.

set -uo pipefail

# ─── Konstanten ──────────────────────────────────────────────────────────────
STATE_REPO="openclaw/clawsweeper-state"
SOURCE_REPO="openclaw/openclaw"
RAW_BASE="https://raw.githubusercontent.com/${STATE_REPO}/state/records/openclaw-openclaw/commits"
API_BASE="https://api.github.com/repos/${SOURCE_REPO}"
COMPARE_LIMIT="${CLAWSWEEPER_COMPARE_LIMIT:-0}"
PARALLEL=8
TIMEOUT_S=$(( ${CLAWSWEEPER_GATE_TIMEOUT_MS:-8000} / 1000 ))
(( TIMEOUT_S < 1 )) && TIMEOUT_S=1
CACHE_DIR="${CLAWSWEEPER_GATE_CACHE:-/tmp/clawsweeper-gate-cache}"
CACHE_TTL_SEC=$(( 24 * 3600 ))

# ─── Mini-Color-Echos (standalone, kein source nötig) ────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
ok()     { echo -e "${GREEN}✅  $*${RESET}"; }
warn()   { echo -e "${YELLOW}⚠️  $*${RESET}"; }
info()   { echo -e "${CYAN}ℹ️   $*${RESET}"; }
header() { echo -e "\n${BOLD}${CYAN}━━━  $*  ━━━${RESET}"; }

# ─── Args ────────────────────────────────────────────────────────────────────
NO_BLOCK=0
ARGS=()
for a in "$@"; do
    case "$a" in
        --no-block) NO_BLOCK=1 ;;
        --help|-h)
            sed -n '2,16p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) ARGS+=("$a") ;;
    esac
done
set -- "${ARGS[@]}"

VERSION_BEFORE_RAW="${1:-}"
VERSION_TARGET_RAW="${2:-}"

if [[ -z "$VERSION_BEFORE_RAW" ]]; then
    echo "Usage: $0 <current-version> [target-version] [--no-block]" >&2
    exit 2
fi

# Extrahiert "2026.4.29" aus z.B. "OpenClaw 2026.4.29 (a448042)" oder
# "v2026.4.29-beta.1". Liefert leeren String wenn nichts Semver-artiges drin ist.
extract_semver() {
    echo "$1" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.+-]+)?' | head -1
}

VERSION_BEFORE=$(extract_semver "$VERSION_BEFORE_RAW")
VERSION_TARGET=$(extract_semver "$VERSION_TARGET_RAW")

header "CLAWSWEEPER UPSTREAM REVIEW"

if [[ "$VERSION_BEFORE_RAW" == "unbekannt" || "$VERSION_BEFORE_RAW" == "unknown" || -z "$VERSION_BEFORE" ]]; then
    warn "Aktuelle Version nicht parsebar (\"$VERSION_BEFORE_RAW\") — Gate übersprungen."
    exit 0
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────
need() {
    command -v "$1" >/dev/null 2>&1 || {
        warn "Tool '$1' fehlt — Gate übersprungen."
        exit 0
    }
}
need curl
need jq
need awk
need xargs

mkdir -p "$CACHE_DIR"

curl_get() {
    # Args: url, optional-output
    local url="$1" out="${2:-}"
    if [[ -n "$out" ]]; then
        curl -sfL --max-time "$TIMEOUT_S" "$url" -o "$out"
    else
        curl -sfL --max-time "$TIMEOUT_S" "$url"
    fi
}

# ─── Ziel-Version ermitteln ──────────────────────────────────────────────────
if [[ -z "$VERSION_TARGET" ]]; then
    VERSION_TARGET=$(npm view openclaw version 2>/dev/null | tr -d '[:space:]' || true)
fi

if [[ -z "$VERSION_TARGET" ]]; then
    warn "Konnte Ziel-Version (npm view openclaw version) nicht auflösen — Gate übersprungen."
    exit 0
fi

info "Vergleich: ${BOLD}${VERSION_BEFORE}${RESET}${CYAN} → ${BOLD}${VERSION_TARGET}${RESET}"

if [[ "$VERSION_BEFORE" == "$VERSION_TARGET" ]]; then
    ok "Bereits aktuell — kein Upstream-Review nötig."
    exit 0
fi

# ─── Tag → SHA ───────────────────────────────────────────────────────────────
resolve_tag_sha() {
    local v="$1"
    # versioniert mit oder ohne führendes 'v' möglich — beides probieren.
    local body sha
    for tag in "v${v}" "${v}"; do
        body=$(curl_get "${API_BASE}/git/ref/tags/${tag}" || true)
        sha=$(echo "$body" | jq -r '.object.sha // empty' 2>/dev/null)
        if [[ -n "$sha" && "$sha" != "null" ]]; then
            # bei annotated tag: object.type == "tag" → dereferenzieren
            local type
            type=$(echo "$body" | jq -r '.object.type // empty')
            if [[ "$type" == "tag" ]]; then
                local tag_obj
                tag_obj=$(curl_get "${API_BASE}/git/tags/${sha}" || true)
                sha=$(echo "$tag_obj" | jq -r '.object.sha // empty')
            fi
            [[ -n "$sha" && "$sha" != "null" ]] && { echo "$sha"; return 0; }
        fi
    done
    return 1
}

SHA_BEFORE=$(resolve_tag_sha "$VERSION_BEFORE") || {
    warn "Tag für v${VERSION_BEFORE} nicht in ${SOURCE_REPO} gefunden — Gate übersprungen."
    exit 0
}
SHA_TARGET=$(resolve_tag_sha "$VERSION_TARGET") || {
    warn "Tag für v${VERSION_TARGET} nicht in ${SOURCE_REPO} gefunden — Gate übersprungen."
    exit 0
}

# ─── Commit-Range ────────────────────────────────────────────────────────────
COMPARE_JSON=$(curl_get "${API_BASE}/compare/${SHA_BEFORE}...${SHA_TARGET}" || true)
if [[ -z "$COMPARE_JSON" ]]; then
    warn "GitHub compare-API leer — Gate übersprungen."
    exit 0
fi

TOTAL=$(echo "$COMPARE_JSON" | jq -r '.total_commits // 0')
if [[ "$TOTAL" == "0" || "$TOTAL" == "null" ]]; then
    ok "Keine Commits in der Range (${VERSION_BEFORE}..${VERSION_TARGET})."
    exit 0
fi

if (( COMPARE_LIMIT > 0 && TOTAL > COMPARE_LIMIT )); then
    warn "Range hat ${TOTAL} Commits, prüfe nur die ersten ${COMPARE_LIMIT}."
fi

# Liste: sha<TAB>author<TAB>summary. GitHub's compare API paginates the
# commits array for large ranges, so COMPARE_LIMIT=0 walks all pages.
commit_tsv_from_json() {
    jq -r --argjson lim "${1:-0}" '
        (if $lim > 0 then .commits[:$lim] else .commits end)[] |
        [
            .sha,
            (.author.login // .commit.author.name // "unknown"),
            ((.commit.message | split("\n")[0]) | tostring)
        ] | @tsv
    '
}

COMMITS_TSV=""
if (( COMPARE_LIMIT > 0 )); then
    COMMITS_TSV=$(echo "$COMPARE_JSON" | commit_tsv_from_json "$COMPARE_LIMIT")
else
    PAGE=1
    while :; do
        PAGE_JSON=$(curl_get "${API_BASE}/compare/${SHA_BEFORE}...${SHA_TARGET}?per_page=100&page=${PAGE}" || true)
        [[ -n "$PAGE_JSON" ]] || break
        PAGE_TSV=$(echo "$PAGE_JSON" | commit_tsv_from_json 0)
        [[ -n "$PAGE_TSV" ]] || break
        if [[ -n "$COMMITS_TSV" ]]; then
            COMMITS_TSV+=$'\n'
        fi
        COMMITS_TSV+="$PAGE_TSV"
        PAGE_COUNT=$(echo "$PAGE_TSV" | wc -l | tr -d ' ')
        (( PAGE_COUNT < 100 )) && break
        PAGE=$(( PAGE + 1 ))
    done
fi

NUM_COMMITS=$(echo "$COMMITS_TSV" | wc -l | tr -d ' ')
info "Commit-Range umfasst ${NUM_COMMITS} Commits."

# ─── Reports parallel laden ──────────────────────────────────────────────────
fetch_one() {
    local sha="$1"
    local cache="${CACHE_DIR}/${sha}.md"
    local miss="${CACHE_DIR}/${sha}.miss"

    # Frischer Cache?
    if [[ -f "$cache" ]]; then
        local age now mtime
        now=$(date +%s)
        mtime=$(stat -c %Y "$cache" 2>/dev/null || echo 0)
        age=$(( now - mtime ))
        if (( age < CACHE_TTL_SEC )); then
            return 0
        fi
    fi
    if [[ -f "$miss" ]]; then
        local mtime now age
        now=$(date +%s); mtime=$(stat -c %Y "$miss" 2>/dev/null || echo 0)
        age=$(( now - mtime ))
        # Miss-Cache nur 30min — neue Reports können nachträglich erscheinen.
        (( age < 1800 )) && return 0
    fi

    if curl -sfL --max-time "$TIMEOUT_S" "${RAW_BASE}/${sha}.md" -o "${cache}.tmp"; then
        mv "${cache}.tmp" "$cache"
        rm -f "$miss"
    else
        rm -f "${cache}.tmp"
        : > "$miss"
    fi
}
export -f fetch_one
export CACHE_DIR RAW_BASE TIMEOUT_S CACHE_TTL_SEC

echo "$COMMITS_TSV" | awk -F'\t' '{print $1}' | \
    xargs -I{} -P "$PARALLEL" bash -c 'fetch_one "$@"' _ {}

# ─── Frontmatter parsen ──────────────────────────────────────────────────────
parse_field() {
    # $1 = file, $2 = key
    awk -v key="$2" '
        BEGIN { in_fm=0 }
        /^---$/ { in_fm = (in_fm==0) ? 1 : 2; next }
        in_fm == 1 {
            # key: value (mit/ohne quotes)
            if (match($0, "^[[:space:]]*"key"[[:space:]]*:[[:space:]]*(.*)$", m)) {
                v = m[1]
                gsub(/^"|"$/, "", v)
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
                print v
                exit
            }
        }
    ' "$1" 2>/dev/null
}

CLEAN=0; SKIPPED=0; FINDINGS=0; UNREVIEWED=0
SEV_HIGH=0; SEV_MED=0; SEV_LOW=0; SEV_NONE=0
FINDING_LINES=()

# Test-Hook: synthetisches finding für Verifikation
if [[ "${CLAWSWEEPER_GATE_FORCE_FINDING:-0}" == "1" ]]; then
    FINDINGS=1; SEV_MED=1
    FINDING_LINES+=("  • deadbee  result: findings, severity: medium  test-hook  „synthetic finding (CLAWSWEEPER_GATE_FORCE_FINDING=1)\"\n    https://github.com/openclaw/openclaw/commit/deadbee")
fi

while IFS=$'\t' read -r sha author summary; do
    [[ -z "$sha" ]] && continue
    cache="${CACHE_DIR}/${sha}.md"
    if [[ ! -f "$cache" ]]; then
        UNREVIEWED=$(( UNREVIEWED + 1 ))
        continue
    fi
    result=$(parse_field "$cache" result)
    sev=$(parse_field "$cache" highest_severity)
    case "$result" in
        nothing_found|"")
            CLEAN=$(( CLEAN + 1 ))
            ;;
        skipped_non_code|skipped)
            # Non-code commit: bewusst nicht reviewt → kein Finding
            SKIPPED=$(( SKIPPED + 1 ))
            ;;
        findings)
            FINDINGS=$(( FINDINGS + 1 ))
            case "$sev" in
                high|critical) SEV_HIGH=$(( SEV_HIGH + 1 ));;
                medium)        SEV_MED=$(( SEV_MED + 1 ));;
                low)           SEV_LOW=$(( SEV_LOW + 1 ));;
                *)             SEV_NONE=$(( SEV_NONE + 1 ));;
            esac
            short="${sha:0:7}"
            FINDING_LINES+=("  • ${short}  result: findings, severity: ${sev:-?}  ${author}  „${summary}\"\n    https://github.com/${SOURCE_REPO}/commit/${sha}")
            ;;
        *)
            # andere result-Werte (z.B. needs_attention, error) als findings zählen
            FINDINGS=$(( FINDINGS + 1 ))
            SEV_NONE=$(( SEV_NONE + 1 ))
            short="${sha:0:7}"
            FINDING_LINES+=("  • ${short}  result: ${result}, severity: ${sev:-?}  ${author}  „${summary}\"\n    https://github.com/${SOURCE_REPO}/commit/${sha}")
            ;;
    esac
done <<< "$COMMITS_TSV"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo
ok    "${CLEAN} clean (nothing_found)"
if (( SKIPPED > 0 )); then
    info "${SKIPPED} skipped (non-code commits)"
fi
if (( FINDINGS > 0 )); then
    warn "${FINDINGS} findings  (high: ${SEV_HIGH}, medium: ${SEV_MED}, low: ${SEV_LOW}, ungewichtet: ${SEV_NONE})"
fi
if (( UNREVIEWED > 0 )); then
    info "${UNREVIEWED} unreviewed (kein Report im state-repo)"
fi

if (( FINDINGS > 0 )); then
    echo
    echo -e "${BOLD}Befunde:${RESET}"
    for line in "${FINDING_LINES[@]}"; do
        echo -e "$line"
    done
fi

# ─── Pause bei Findings ──────────────────────────────────────────────────────
if (( FINDINGS > 0 )) && (( NO_BLOCK == 0 )) && [[ -t 0 ]]; then
    echo
    echo -e "${BOLD}${YELLOW}⏸️   Findings gefunden — wirklich bumpen? Review die Reports oben.${RESET}"
    echo -e "${BOLD}    → Drücke ENTER um fortzufahren, Ctrl+C zum Abbrechen.${RESET}"
    read -r
fi

exit 0
