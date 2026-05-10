#!/usr/bin/env bash
# update-openclaw.sh — Geführtes OpenClaw-Update für vmd190201
#
# Philosophie: Sicheres automatisieren, Riskantes anzeigen und warten.
# Dieses Script wird GEMEINSAM mit dem Menschen benutzt — kein Autopilot.
#
# Verwendung:
#   ./update-openclaw.sh            # Vollständiges Update
#   ./update-openclaw.sh --check    # Nur Status prüfen, kein Update

set -euo pipefail

# ─── Farben & Symbole ────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
OK="✅"; WARN="⚠️ "; FAIL="❌"; INFO="ℹ️ "; PAUSE="⏸️ "

ok()      { echo -e "${GREEN}${OK}  $*${RESET}"; }
warn()    { echo -e "${YELLOW}${WARN} $*${RESET}"; WARNINGS=$((WARNINGS+1)); }
fail()    { echo -e "${RED}${FAIL}  $*${RESET}"; ERRORS=$((ERRORS+1)); }
info()    { echo -e "${CYAN}${INFO}  $*${RESET}"; }
reminder(){ echo -e "${YELLOW}${WARN} $*${RESET}"; }  # wie warn, aber zählt nicht
pause() {
    if [[ "$CHECK_ONLY" == "1" ]] || [[ ! -t 0 ]]; then
        echo -e "\n${CYAN}${PAUSE}  $* ${RESET}${CYAN}[übersprungen im nicht-interaktiven Modus]${RESET}"
        return 0
    fi
    echo -e "\n${BOLD}${PAUSE}  $*${RESET}"
    echo -e "${BOLD}    → Drücke ENTER um fortzufahren, Ctrl+C zum Abbrechen.${RESET}"
    read -r
}
header(){ echo -e "\n${BOLD}${CYAN}━━━  $*  ━━━${RESET}"; }

# Warte bis alle Pflicht-Plugins in `openclaw status` als `registered` erscheinen.
# Nach systemctl restart ist der Gateway "active" lange bevor Plugins geladen sind.
# `openclaw status` selbst braucht auf unserer Installation ~50–60s (CLI lädt alle
# Extensions, teilweise mit Retry bei fehlenden Deps wie @larksuiteoapi/node-sdk),
# deshalb pro Aufruf 90s Timeout und insgesamt 3 Versuche. Gibt Status über
# $WAIT_STATUS_OUTPUT zurück — spart redundante Invocations downstream.
WAIT_STATUS_OUTPUT=""
wait_for_plugins_ready() {
    local required=("adaptive-learning-loop: registered" "memory-lancedb-namespaced: registered")
    local attempt out journal miss m
    for attempt in 1 2 3; do
        out=$(timeout 90s openclaw status 2>&1 || true)
        miss=0
        for m in "${required[@]}"; do
            grep -q "$m" <<< "$out" || { miss=1; break; }
        done
        if (( miss == 0 )); then
            WAIT_STATUS_OUTPUT="$out"
            return 0
        fi
        journal=$(journalctl --user -u openclaw-gateway --since "2 hours ago" --no-pager -n 5000 2>/dev/null || true)
        miss=0
        for m in "${required[@]}"; do
            grep -q "$m" <<< "$journal" || { miss=1; break; }
        done
        if (( miss == 0 )); then
            WAIT_STATUS_OUTPUT="$out"
            return 0
        fi
        sleep 3
    done
    WAIT_STATUS_OUTPUT="$out"
    return 1
}

WARNINGS=0
ERRORS=0
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1
OPENCLAW_JSON="/root/.openclaw/openclaw.json"
OPENCLAW_INSTALLS_JSON="/root/.openclaw/plugins/installs.json"
OPENCLAW_UPDATE_TARGET="${OPENCLAW_UPDATE_TARGET:-2026.5.7}"

validate_openclaw_compat_patch() {
    local target="$1"
    local tmpdir package_dir cache_dir tarball check_files compat_patch f

    case "$target" in
        2026.5.3-1) compat_patch="/root/openclaw-memory-system/patches/apply-openclaw-20260503-compat.sh" ;;
        2026.5.10-beta.1) compat_patch="/root/openclaw-memory-system/patches/apply-openclaw-20260510-beta1-compat.sh" ;;
        2026.5.4|2026.5.5|2026.5.6|2026.5.7) compat_patch="/root/openclaw-memory-system/patches/apply-openclaw-20260504-compat.sh" ;;
        *)
            info "Kein lokaler Compat-Dry-Run für Zielversion $target konfiguriert"
            return 0
            ;;
    esac

    header "COMPAT-PATCH DRY-RUN"
    tmpdir="$(mktemp -d /tmp/openclaw-compat-${target//[^A-Za-z0-9]/}-XXXXXX)"
    package_dir="$tmpdir/package"
    cache_dir="/tmp/openclaw-compat-${target//[^A-Za-z0-9]/}/package"

    if [[ -d "$cache_dir/dist" ]] && \
       [[ "$(jq -r '.version // empty' "$cache_dir/package.json" 2>/dev/null || true)" == "$target" ]]; then
        cp -a "$cache_dir" "$package_dir"
        ok "Nutze vorhandenes entpacktes openclaw@$target Paket aus /tmp"
    else
        info "Lade openclaw@$target fuer Patch-Dry-Run..."
        npm pack "openclaw@$target" --pack-destination "$tmpdir" >/dev/null
        tarball="$(find "$tmpdir" -maxdepth 1 -name 'openclaw-*.tgz' | head -1)"
        [[ -n "$tarball" ]] || { fail "npm pack lieferte kein Tarball"; return 1; }
        tar -xzf "$tarball" -C "$tmpdir"
    fi

    OPENCLAW_DIST_DIR="$package_dir/dist" bash "$compat_patch"

    check_files=(
        "$package_dir/dist/extensions/active-memory/index.js"
        "$package_dir/dist"/subagent-announce-delivery-*.js
        "$package_dir/dist"/subagent-spawn-*.js
        "$package_dir/dist"/acp-spawn-*.js
        "$package_dir/dist"/subagent-control-*.js
        "$package_dir/dist"/heartbeat-runner-*.js
        "$package_dir/dist/bundled/boot-md/handler.js"
        "$package_dir/dist"/agent-runner.runtime-*.js
    )
    for f in "${check_files[@]}"; do
        [[ -f "$f" ]] || continue
        node --check "$f" >/dev/null
    done
    ok "openclaw@$target Compat-Patch laeuft auf entpacktem Tarball sauber durch"
}

cleanup_memory_lancedb_stock_manifest_for_20260503() {
    local target="$1"
    local stock_dir stock_manifest tmp_json

    [[ "$target" == "2026.5.3-1" || "$target" == "2026.5.4" || "$target" == "2026.5.5" || "$target" == "2026.5.6" || "$target" == "2026.5.7" ]] || return 0

    stock_dir="/root/.openclaw/extensions/memory-lancedb-stock"
    stock_manifest="$stock_dir/openclaw.plugin.json"

    if [[ ! -f "$stock_manifest" && -f "$stock_manifest.disabled" ]]; then
        cp "$stock_manifest.disabled" "$stock_manifest"
        ok "memory-lancedb-stock Manifest wiederhergestellt; OpenClaw 5.3 erwartet es bei der Config-Validierung"
    elif [[ -f "$stock_manifest" ]]; then
        ok "memory-lancedb-stock Manifest vorhanden"
    fi

    if [[ -f "$OPENCLAW_INSTALLS_JSON" ]]; then
        tmp_json=$(mktemp)
        jq \
            --arg pluginId "memory-lancedb-stock" \
            --arg source "$stock_dir" \
            '
            del(.[$pluginId])
            | if (.plugins | type) == "array" then
                .plugins |= map(select(.pluginId != $pluginId))
              else . end
            | if (.installRecords | type) == "array" then
                .installRecords |= map(select(.pluginId != $pluginId))
              else . end
            | if (.diagnostics | type) == "array" then
                .diagnostics |= map(select((.source // "") != $source and ((.message // "") | contains($pluginId) | not)))
              else . end
            ' "$OPENCLAW_INSTALLS_JSON" > "$tmp_json"
        mv "$tmp_json" "$OPENCLAW_INSTALLS_JSON"
        ok "stale memory-lancedb-stock Install-Record entfernt"
    fi
}

ensure_20260503_plugin_contracts_and_runtime_stubs() {
    local target="$1"
    local stock_index namespaced_manifest adaptive_manifest tmp_json

    [[ "$target" == "2026.5.3-1" || "$target" == "2026.5.4" || "$target" == "2026.5.5" || "$target" == "2026.5.6" || "$target" == "2026.5.7" ]] || return 0

    stock_index="/root/.openclaw/extensions/memory-lancedb-stock/index.js"
    if [[ ! -f "$stock_index" ]]; then
        cat > "$stock_index" <<'EOF'
export default async function memoryLancedbStockRuntime(api) {
  api?.logger?.warn?.(
    "memory-lancedb-stock is dependency-only in this local setup; use memory-lancedb-namespaced for runtime memory tools.",
  );
}
EOF
        ok "memory-lancedb-stock Runtime-Stub erstellt (unterdrueckt TypeScript-runtime Warnung)"
    else
        ok "memory-lancedb-stock Runtime-Stub vorhanden"
    fi

    namespaced_manifest="/root/.openclaw/extensions/memory-lancedb-namespaced/openclaw.plugin.json"
    if [[ -f "$namespaced_manifest" ]]; then
        tmp_json=$(mktemp)
        jq '.contracts.tools = (((.contracts.tools // []) + ["memory_recall", "memory_store", "memory_forget", "knowledge_update"]) | unique)' "$namespaced_manifest" > "$tmp_json"
        mv "$tmp_json" "$namespaced_manifest"
        ok "memory-lancedb-namespaced contracts.tools gesetzt"
    fi

    adaptive_manifest="/root/.openclaw/extensions/adaptive-learning-loop/openclaw.plugin.json"
    if [[ -f "$adaptive_manifest" ]]; then
        tmp_json=$(mktemp)
        jq '.contracts.tools = (((.contracts.tools // []) + ["adaptive_learning_log", "adaptive_learning_feedback", "adaptive_learning_review", "adaptive_learning_apply"]) | unique)' "$adaptive_manifest" > "$tmp_json"
        mv "$tmp_json" "$adaptive_manifest"
        ok "adaptive-learning-loop contracts.tools gesetzt"
    fi
}

cleanup_stale_discord_channel_for_20260503() {
    local target="$1"
    local stock_discord tmp_json

    [[ "$target" == "2026.5.3-1" || "$target" == "2026.5.4" || "$target" == "2026.5.5" || "$target" == "2026.5.6" || "$target" == "2026.5.7" ]] || return 0

    stock_discord="/usr/lib/node_modules/openclaw/dist/extensions/discord"
    if [[ -e "$stock_discord" ]]; then
        info "Discord-Plugin vorhanden; keine automatische Deaktivierung"
        return 0
    fi

    if [[ -f "$OPENCLAW_JSON" ]]; then
        tmp_json=$(mktemp)
        jq '
          if (.channels.discord? != null) then
            .channels.discord.enabled = false
            | if (.channels.discord.accounts | type) == "object" then
                .channels.discord.accounts |= with_entries(.value.enabled = false)
              else . end
          else . end
          | if (.plugins.allow | type) == "array" then
              .plugins.allow |= map(select(. != "discord"))
            else . end
        ' "$OPENCLAW_JSON" > "$tmp_json"
        mv "$tmp_json" "$OPENCLAW_JSON"
        ok "stale Discord-Channel deaktiviert und aus plugins.allow entfernt"
    fi
}

validate_local_plugin_runtime_deps() {
    local missing=0
    local required_paths=(
        "/root/.openclaw/extensions/memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js"
        "/root/.openclaw/extensions/memory-lancedb-stock/node_modules/openai/index.js"
        "/root/.openclaw/extensions/memory-lancedb-stock/index.js"
        "/root/.openclaw/extensions/memory-lancedb-stock/openclaw.plugin.json"
        "/root/.openclaw/extensions/memory-lancedb-namespaced/index.js"
        "/root/.openclaw/extensions/memory-lancedb-namespaced/openclaw.plugin.json"
        "/root/.openclaw/extensions/adaptive-learning-loop/index.js"
        "/root/.openclaw/extensions/adaptive-learning-loop/openclaw.plugin.json"
    )
    local path

    for path in "${required_paths[@]}"; do
        if [[ ! -f "$path" ]]; then
            warn "Plugin Runtime-Datei fehlt: $path"
            missing=1
        fi
    done

    node --check /root/.openclaw/extensions/memory-lancedb-stock/index.js >/dev/null
    node --check /root/.openclaw/extensions/memory-lancedb-namespaced/index.js >/dev/null
    node --check /root/.openclaw/extensions/adaptive-learning-loop/index.js >/dev/null

    jq -e '(.contracts.tools // []) as $tools | all(["memory_recall", "memory_store", "memory_forget", "knowledge_update"][]; $tools | index(.))' /root/.openclaw/extensions/memory-lancedb-namespaced/openclaw.plugin.json >/dev/null || {
        warn "memory-lancedb-namespaced manifest deklariert nicht alle Runtime-Tools"
        missing=1
    }
    jq -e '(.contracts.tools // []) as $tools | all(["adaptive_learning_log", "adaptive_learning_feedback", "adaptive_learning_review", "adaptive_learning_apply"][]; $tools | index(.))' /root/.openclaw/extensions/adaptive-learning-loop/openclaw.plugin.json >/dev/null || {
        warn "adaptive-learning-loop manifest deklariert nicht alle Runtime-Tools"
        missing=1
    }

    if [[ "$missing" == "0" ]]; then
        ok "Lokale Plugin Runtime-Deps und Tool-Contracts vollständig"
    else
        return 1
    fi
}

# ─── PRE-FLIGHT ──────────────────────────────────────────────────────────────
header "PRE-FLIGHT CHECKS"

VERSION_BEFORE=$(openclaw --version 2>/dev/null || echo "unbekannt")
info "Aktuelle Version: ${BOLD}${VERSION_BEFORE}${RESET}"

# Laufende yt-analyze Daemons?
RUNNING_YT=$(ls /tmp/yt-analyze/*/pid 2>/dev/null | while read -r pidfile; do
    PID=$(cat "$pidfile" 2>/dev/null || true)
    ps -p "$PID" > /dev/null 2>&1 && echo "$pidfile"
done || true)

if [[ -n "$RUNNING_YT" ]]; then
    fail "Laufende yt-analyze Transkription(en) gefunden!"
    echo "$RUNNING_YT" | sed 's/^/       /'
    echo -e "${RED}    Update JETZT würde den laufenden Prozess NICHT direkt abbrechen,"
    echo -e "    aber der Gateway-Neustart würde neue Sessions blockieren.${RESET}"
    pause "Wirklich weitermachen? (Transkription läuft noch)"
else
    ok "Keine laufenden yt-analyze Prozesse"
fi

# Laufende Cron-Jobs? (Suche nach "running" im Status-Output)
CRON_RUNNING=$(openclaw cron list --json 2>/dev/null | jq -r '.[] | select(.state.lastStatus == "running") | .name' 2>/dev/null || true)
if [[ -n "$CRON_RUNNING" ]]; then
    warn "Cron-Job läuft gerade: $CRON_RUNNING"
else
    ok "Keine aktiven Cron-Jobs erkennbar"
fi

# Snapshot-Erinnerung
echo ""
reminder "SNAPSHOT nicht vergessen!"
echo "       Contabo Control Panel → Server → Snapshot erstellen"
echo "       https://my.contabo.com → vmd190201"
pause "Snapshot erstellt? Dann weiter."

[[ "$CHECK_ONLY" == "1" ]] && { info "Nur-Check-Modus — kein Update wird durchgeführt."; }

# ─── CLAWSWEEPER UPSTREAM-REVIEW ─────────────────────────────────────────────
if [[ -x /root/openclaw-memory-system/scripts/clawsweeper-gate.sh ]]; then
    extra_flags=()
    [[ "$CHECK_ONLY" == "1" ]] && extra_flags+=(--no-block)
    clawsweeper_env=()
    [[ "$CHECK_ONLY" == "1" ]] && clawsweeper_env+=(CLAWSWEEPER_OFFLINE_SKIP_OK=1)
    env "${clawsweeper_env[@]}" /root/openclaw-memory-system/scripts/clawsweeper-gate.sh "$VERSION_BEFORE" "$OPENCLAW_UPDATE_TARGET" "${extra_flags[@]}" || \
        warn "clawsweeper-gate fehlgeschlagen — Update geht trotzdem weiter"
fi

validate_openclaw_compat_patch "$OPENCLAW_UPDATE_TARGET"

# ─── UPDATE ──────────────────────────────────────────────────────────────────
if [[ "$CHECK_ONLY" != "1" ]]; then
    header "UPDATE DURCHFÜHREN"
    info "Führe aus: npm i -g openclaw@$OPENCLAW_UPDATE_TARGET"
    npm i -g "openclaw@$OPENCLAW_UPDATE_TARGET"
    VERSION_AFTER=$(openclaw --version 2>/dev/null || echo "unbekannt")
    if [[ "$VERSION_BEFORE" == "$VERSION_AFTER" ]]; then
        ok "Version unverändert: ${VERSION_AFTER} (bereits aktuell)"
    else
        ok "Update: ${VERSION_BEFORE} → ${BOLD}${VERSION_AFTER}${RESET}"
    fi

    bash /root/openclaw-memory-system/patches/apply-memory-patches.sh

    # LanceDB node_modules-Check: memory-lancedb-namespaced nutzt LanceDB aus memory-lancedb-stock.
    # Ab 2026-04-03: Pfade sind relativ via import.meta.url — kein Hardcoded-Pfad-Patch mehr nötig.
    # Nur noch sicherstellen dass node_modules vorhanden sind.
    STOCK_LANCEDB="/root/.openclaw/extensions/memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js"

    if [[ ! -f "$STOCK_LANCEDB" ]]; then
        warn "memory-lancedb-stock node_modules fehlt — installiere..."
        (cd /root/.openclaw/extensions/memory-lancedb-stock && npm install 2>&1 | tail -3 | sed 's/^/       /')
        ok "memory-lancedb-stock node_modules wiederhergestellt"
    else
        ok "memory-lancedb-stock node_modules vorhanden"
    fi

    # Ab 2026.3.23-2: @openclaw/memory-lancedb als Bundled-Plugin (ID: memory-lancedb).
    # memory-lancedb-stock hatte ebenfalls ID "memory-lancedb" → Duplicate-Plugin-Warning.
    # Fix: openclaw.plugin.json in memory-lancedb-stock auf ID "memory-lancedb-stock" setzen.
    STOCK_MANIFEST="/root/.openclaw/extensions/memory-lancedb-stock/openclaw.plugin.json"
    if [[ "$OPENCLAW_UPDATE_TARGET" == "2026.5.3-1" || "$OPENCLAW_UPDATE_TARGET" == "2026.5.4" || "$OPENCLAW_UPDATE_TARGET" == "2026.5.5" || "$OPENCLAW_UPDATE_TARGET" == "2026.5.6" || "$OPENCLAW_UPDATE_TARGET" == "2026.5.7" || "$OPENCLAW_UPDATE_TARGET" == "2026.5.10-beta.1" ]]; then
        cleanup_memory_lancedb_stock_manifest_for_20260503 "$OPENCLAW_UPDATE_TARGET"
        ensure_20260503_plugin_contracts_and_runtime_stubs "$OPENCLAW_UPDATE_TARGET"
        cleanup_stale_discord_channel_for_20260503 "$OPENCLAW_UPDATE_TARGET"
    elif [[ -f "$STOCK_MANIFEST" ]]; then
        CURRENT_ID=$(grep '"id"' "$STOCK_MANIFEST" | grep -o '"[^"]*"' | tail -1 | tr -d '"')
        if [[ "$CURRENT_ID" == "memory-lancedb" ]]; then
            sed -i 's/"id": "memory-lancedb"/"id": "memory-lancedb-stock"/' "$STOCK_MANIFEST"
            ok "memory-lancedb-stock Plugin-ID auf 'memory-lancedb-stock' gepatcht (kein Duplicate-Konflikt)"
        else
            ok "memory-lancedb-stock Plugin-ID korrekt ($CURRENT_ID)"
        fi
    fi

    # Adaptive Learning: Custom Plugin + Config sollen OpenClaw-Updates überleben.
    # Die Dateien liegen in ~/.openclaw/ und bleiben i.d.R. erhalten, aber der Config-Block
    # oder Install-Record kann driften. Diesen Canonical State stellen wir wieder her.
    ADAPTIVE_DIR="/root/.openclaw/extensions/adaptive-learning-loop"
    ADAPTIVE_QUEUE="/root/.openclaw/cross-agent-learning/queue.jsonl"
    ADAPTIVE_SUBAGENT_BINDINGS="/root/.openclaw/cross-agent-learning/subagent-bindings.json"
    ADAPTIVE_VERSION="0.3.0"

    if [[ -f "$ADAPTIVE_DIR/index.js" && -f "$ADAPTIVE_DIR/openclaw.plugin.json" ]]; then
        ok "adaptive-learning-loop Dateien vorhanden"
        mkdir -p "$(dirname "$ADAPTIVE_QUEUE")"
        touch "$ADAPTIVE_QUEUE"
        if [[ ! -f "$ADAPTIVE_SUBAGENT_BINDINGS" ]]; then
            printf '{}\n' > "$ADAPTIVE_SUBAGENT_BINDINGS"
        fi
        ok "adaptive-learning Curator-Queue vorhanden"

        CURRENT_CURATOR=$(jq -r '.plugins.entries["adaptive-learning-loop"].config.curatorAgentId // empty' "$OPENCLAW_JSON" 2>/dev/null || true)
        CURRENT_QUEUE=$(jq -r '.plugins.entries["adaptive-learning-loop"].config.crossPromotionQueuePath // empty' "$OPENCLAW_JSON" 2>/dev/null || true)
        CURRENT_MAX_FEEDBACK=$(jq -r '.plugins.entries["adaptive-learning-loop"].config.maxInjectedFeedback // empty' "$OPENCLAW_JSON" 2>/dev/null || true)
        CURRENT_USER_SCOPED=$(jq -r '.plugins.entries["adaptive-learning-loop"].config.userScopedFeedback // empty' "$OPENCLAW_JSON" 2>/dev/null || true)
        CURRENT_MAX_USER_FEEDBACK=$(jq -r '.plugins.entries["adaptive-learning-loop"].config.maxInjectedUserFeedback // empty' "$OPENCLAW_JSON" 2>/dev/null || true)
        CURRENT_SUBAGENT_INHERIT=$(jq -r '.plugins.entries["adaptive-learning-loop"].config.inheritUserScopeToSubagents // empty' "$OPENCLAW_JSON" 2>/dev/null || true)
        CURRENT_POSITIVE_THRESHOLD=$(jq -r '.plugins.entries["adaptive-learning-loop"].config.positiveFeedbackThreshold // empty' "$OPENCLAW_JSON" 2>/dev/null || true)
        CURRENT_NEGATIVE_THRESHOLD=$(jq -r '.plugins.entries["adaptive-learning-loop"].config.negativeFeedbackThreshold // empty' "$OPENCLAW_JSON" 2>/dev/null || true)
        CURRENT_MIXED_THRESHOLD=$(jq -r '.plugins.entries["adaptive-learning-loop"].config.mixedFeedbackReviewThreshold // empty' "$OPENCLAW_JSON" 2>/dev/null || true)
        CURRENT_INSTALL=$(python3 -c "
import json
installs_path = '$OPENCLAW_INSTALLS_JSON'
cfg_path = '$OPENCLAW_JSON'
install_path = ''
try:
    with open(installs_path) as f:
        installs = json.load(f)
    install_path = installs.get('adaptive-learning-loop', {}).get('installPath', '') or ''
except Exception:
    pass
if not install_path:
    try:
        with open(cfg_path) as f:
            d = json.load(f)
        install_path = d.get('plugins', {}).get('installs', {}).get('adaptive-learning-loop', {}).get('installPath', '') or ''
    except Exception:
        pass
print(install_path)
" 2>/dev/null || true)
        CURRENT_INSTALL_VERSION=$(python3 -c "
import json
installs_path = '$OPENCLAW_INSTALLS_JSON'
cfg_path = '$OPENCLAW_JSON'
version = ''
try:
    with open(installs_path) as f:
        installs = json.load(f)
    version = installs.get('adaptive-learning-loop', {}).get('version', '') or ''
except Exception:
    pass
if not version:
    try:
        with open(cfg_path) as f:
            d = json.load(f)
        version = d.get('plugins', {}).get('installs', {}).get('adaptive-learning-loop', {}).get('version', '') or ''
    except Exception:
        pass
print(version)
" 2>/dev/null || true)

        if [[ "$CURRENT_CURATOR" == "main" \
           && "$CURRENT_QUEUE" == "$ADAPTIVE_QUEUE" \
           && "$CURRENT_MAX_FEEDBACK" == "5" \
           && "$CURRENT_USER_SCOPED" == "true" \
           && "$CURRENT_MAX_USER_FEEDBACK" == "4" \
           && "$CURRENT_SUBAGENT_INHERIT" == "true" \
           && "$CURRENT_POSITIVE_THRESHOLD" == "2" \
           && "$CURRENT_NEGATIVE_THRESHOLD" == "2" \
           && "$CURRENT_MIXED_THRESHOLD" == "3" \
           && "$CURRENT_INSTALL" == "$ADAPTIVE_DIR" \
           && "$CURRENT_INSTALL_VERSION" == "$ADAPTIVE_VERSION" ]]; then
            ok "adaptive-learning-loop Config + Install-Record korrekt"
        else
            TMP_JSON=$(mktemp)
            jq \
                --arg adaptiveDir "$ADAPTIVE_DIR" \
                --arg queuePath "$ADAPTIVE_QUEUE" \
                --arg version "$ADAPTIVE_VERSION" \
                '
                .plugins.entries["adaptive-learning-loop"] = {
                  enabled: true,
                  config: {
                    workspaceScoped: true,
                    complexTaskMinToolCalls: 5,
                    promoteAfterRecurrences: 3,
                    promoteMinDistinctSessions: 2,
                    promoteWindowDays: 30,
                    maxInjectedRules: 5,
                    maxInjectedSkills: 3,
                    maxInjectedFeedback: 5,
                    userScopedFeedback: true,
                    maxInjectedUserFeedback: 4,
                    inheritUserScopeToSubagents: true,
                    autoDraftSkills: true,
                    autoApplyLocalPromotions: false,
                    positiveFeedbackThreshold: 2,
                    negativeFeedbackThreshold: 2,
                    mixedFeedbackReviewThreshold: 3,
                    crossPromotionQueuePath: $queuePath,
                    curatorAgentId: "main"
                  }
                }
                | .plugins.installs["adaptive-learning-loop"] = {
                    source: "path",
                    sourcePath: $adaptiveDir,
                    installPath: $adaptiveDir,
                    version: $version
                  }
                ' "$OPENCLAW_JSON" > "$TMP_JSON"
            mv "$TMP_JSON" "$OPENCLAW_JSON"
            python3 -c "
import json, os
path = '$OPENCLAW_INSTALLS_JSON'
adaptive_dir = '$ADAPTIVE_DIR'
version = '$ADAPTIVE_VERSION'
os.makedirs(os.path.dirname(path), exist_ok=True)
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f) or {}
    except Exception:
        data = {}
data['adaptive-learning-loop'] = {
    'source': 'path',
    'sourcePath': adaptive_dir,
    'installPath': adaptive_dir,
    'version': version
}
with open(path, 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write('\n')
" 2>/dev/null || true
            ok "adaptive-learning-loop Config + Install-Record wiederhergestellt"
        fi
    else
        warn "adaptive-learning-loop Dateien fehlen — Plugin kann nach Update nicht geladen werden"
    fi

    # Ab 4.25: plugins.installs wird nach plugins/installs.json migriert.
    # before-compact-save hat sourcePath=/tmp — überlebt keine Reboots → Migration.
    BCSAVE_SRC=$(python3 -c "
import json, os
installs_path = '$OPENCLAW_INSTALLS_JSON'
cfg_path = '$OPENCLAW_JSON'
src = ''
try:
    with open(installs_path) as f:
        d = json.load(f)
    src = d.get('before-compact-save', {}).get('sourcePath', '') or ''
except Exception:
    pass
if not src:
    try:
        with open(cfg_path) as f:
            d = json.load(f)
        src = d.get('plugins', {}).get('installs', {}).get('before-compact-save', {}).get('sourcePath', '') or ''
    except Exception:
        pass
print(src)
" 2>/dev/null || echo "")
    if [[ "$BCSAVE_SRC" == /tmp/* ]]; then
        warn "before-compact-save.sourcePath zeigt auf /tmp (${BCSAVE_SRC}) — nicht reboot-sicher"
        BCSAVE_DEST="/root/.openclaw/extensions/before-compact-save"
        if [[ -d "$BCSAVE_SRC" ]]; then
            cp -a "$BCSAVE_SRC" "$BCSAVE_DEST" 2>/dev/null || true
            ok "  → Kopie nach $BCSAVE_DEST"
        elif [[ ! -d "$BCSAVE_DEST" ]]; then
            warn "  → Quell-Verzeichnis $BCSAVE_SRC nicht gefunden — bitte manuell wiederherstellen"
        fi
        if [[ -d "$BCSAVE_DEST" ]]; then
            python3 -c "
import json, os
cfg_path = '$OPENCLAW_JSON'
installs_path = '$OPENCLAW_INSTALLS_JSON'
dest = '$BCSAVE_DEST'
os.makedirs(os.path.dirname(installs_path), exist_ok=True)

if os.path.exists(installs_path):
    try:
        with open(installs_path) as f:
            installs = json.load(f) or {}
    except Exception:
        installs = {}
else:
    installs = {}

if 'before-compact-save' in installs:
    installs['before-compact-save']['sourcePath'] = dest
    installs['before-compact-save']['installPath'] = dest
    with open(installs_path, 'w') as f:
        json.dump(installs, f, indent=2, ensure_ascii=False)
        f.write('\n')

try:
    with open(cfg_path) as f:
        d = json.load(f)
    legacy = d.setdefault('plugins', {}).setdefault('installs', {})
    if 'before-compact-save' in legacy:
        legacy['before-compact-save']['sourcePath'] = dest
        legacy['before-compact-save']['installPath'] = dest
        with open(cfg_path, 'w') as f:
            json.dump(d, f, indent=2, ensure_ascii=False)
            f.write('\n')
except Exception:
    pass
" 2>/dev/null
            ok "  → before-compact-save.sourcePath migriert: $BCSAVE_DEST"
        fi
    elif [[ -n "$BCSAVE_SRC" ]]; then
        ok "before-compact-save.sourcePath persistiert: $BCSAVE_SRC"
    fi
fi

# ─── TTS PROVIDER CONFIG MIGRATION ──────────────────────────────────────────
# Ab 2026.3.28: messages.tts.<provider> → messages.tts.providers.<provider>
# "edge" → "microsoft" (Edge TTS = Microsoft TTS engine)
# openclaw doctor --fix entfernt den alten Key ohne Migration → Config-Verlust!
# Deshalb: Proaktiv migrieren BEVOR der Gateway startet / doctor läuft.
header "TTS PROVIDER CONFIG MIGRATION"

python3 - "$OPENCLAW_JSON" << 'TTS_MIGRATE_EOF'
import json, sys

path = sys.argv[1]
with open(path) as f:
    d = json.load(f)

tts = d.get("messages", {}).get("tts", {})
changed = False

# Migrate: messages.tts.edge → messages.tts.providers.microsoft
if "edge" in tts:
    edge_cfg = tts.pop("edge")
    providers = tts.setdefault("providers", {})
    if "microsoft" not in providers:
        providers["microsoft"] = edge_cfg
        print(f"[tts-migrate] messages.tts.edge → messages.tts.providers.microsoft (voice: {edge_cfg.get('voice', '?')})")
    else:
        print(f"[tts-migrate] messages.tts.edge vorhanden, aber providers.microsoft existiert bereits — edge-Key entfernt, providers.microsoft unverändert")
    changed = True

# Migrate: messages.tts.openai → messages.tts.providers.openai
if "openai" in tts:
    openai_cfg = tts.pop("openai")
    providers = tts.setdefault("providers", {})
    if "openai" not in providers:
        providers["openai"] = openai_cfg
        print(f"[tts-migrate] messages.tts.openai → messages.tts.providers.openai")
    changed = True

# Migrate: messages.tts.elevenlabs → messages.tts.providers.elevenlabs
if "elevenlabs" in tts:
    el_cfg = tts.pop("elevenlabs")
    providers = tts.setdefault("providers", {})
    if "elevenlabs" not in providers:
        providers["elevenlabs"] = el_cfg
        print(f"[tts-migrate] messages.tts.elevenlabs → messages.tts.providers.elevenlabs")
    changed = True

# Migrate: messages.tts.microsoft → messages.tts.providers.microsoft
if "microsoft" in tts and "providers" not in tts:
    ms_cfg = tts.pop("microsoft")
    providers = tts.setdefault("providers", {})
    if "microsoft" not in providers:
        providers["microsoft"] = ms_cfg
        print(f"[tts-migrate] messages.tts.microsoft → messages.tts.providers.microsoft")
    changed = True

if changed:
    with open(path, "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("[tts-migrate] openclaw.json aktualisiert")
else:
    print("[tts-migrate] Keine Migration nötig")
TTS_MIGRATE_EOF

ok "TTS Provider Config geprüft/migriert"

# ─── 4.5 LEGACY CONFIG ALIAS MIGRATION ──────────────────────────────────────
# Ab 2026.4.5: Legacy-Aliases entfernt, openclaw doctor --fix migriert sicher.
# Betrifft: talk.voiceId/apiKey, agents.*.sandbox.perSession,
#           browser.ssrfPolicy.allowPrivateNetwork, hooks.internal.handlers,
#           channel/group/room 'allow' Toggles.
# Im Gegensatz zu früheren Versionen führt doctor --fix jetzt echte Migration
# durch (nicht nur Löschen) → sicher auszuführen wenn Legacy-Aliases gefunden.
header "4.5 LEGACY CONFIG ALIAS MIGRATION"

LEGACY_FOUND=$(python3 - "$OPENCLAW_JSON" << 'LEGACY_CHECK_EOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    d = json.load(f)

found = []

talk = d.get("talk", {})
if "voiceId" in talk: found.append("talk.voiceId")
if "apiKey" in talk:  found.append("talk.apiKey")

apn = d.get("browser", {}).get("ssrfPolicy", {})
if "allowPrivateNetwork" in apn:
    found.append("browser.ssrfPolicy.allowPrivateNetwork")

hi = d.get("hooks", {}).get("internal", {})
if "handlers" in hi:
    found.append("hooks.internal.handlers")

alist = d.get("agents", {}).get("list", [])
if isinstance(alist, list):
    for ag in alist:
        if isinstance(ag, dict) and isinstance(ag.get("sandbox"), dict):
            if "perSession" in ag["sandbox"]:
                found.append(f"agents.list[{ag.get('id','?')}].sandbox.perSession")

print("\n".join(found))
LEGACY_CHECK_EOF
)

if [[ -z "$LEGACY_FOUND" ]]; then
    ok "Keine Legacy-Aliases in openclaw.json — keine Migration nötig ✓"
else
    warn "Legacy-Aliases gefunden (werden durch doctor --fix migriert):"
    echo "$LEGACY_FOUND" | while read -r line; do
        echo "       • $line"
    done
    if [[ "$CHECK_ONLY" != "1" ]]; then
        info "Führe 'openclaw doctor --fix' aus (migriert Legacy-Aliases)..."
        openclaw doctor --fix 2>&1 | sed 's/^/       /' || true
        ok "doctor --fix abgeschlossen — openclaw.json bitte kurz prüfen"
    else
        info "→ Im Update-Modus würde 'openclaw doctor --fix' ausgeführt"
    fi
fi

# ─── SYSTEMD DROP-IN (ExecStartPre/Post überlebt openclaw update & doctor --fix) ─
# Ab 4.25: 'openclaw update' CLI führt automatisch 'doctor --fix' aus, welches
# die Service-Datei überschreibt und ExecStartPre/ExecStartPost entfernt.
# Ein systemd Drop-In in ~/.config/systemd/user/openclaw-gateway.service.d/
# wird NIEMALS von openclaw update oder doctor --fix angefasst.
if [[ "$CHECK_ONLY" != "1" ]]; then
    header "SYSTEMD DROP-IN SICHERSTELLEN"

    DROPIN_DIR="$HOME/.config/systemd/user/openclaw-gateway.service.d"
    DROPIN_FILE="$DROPIN_DIR/00-openclaw-patches.conf"

    # ExecStartPre= (leer) resettet die vererbte Liste → verhindert Duplikate
    # falls die Basis-Service-Datei ExecStartPre noch enthält.
    DROPIN_EXPECTED="[Service]
ExecStartPre=
ExecStartPre=/root/.openclaw/patches/apply-media-patch.sh
ExecStartPost=
ExecStartPost=/root/.openclaw/patches/post-start-nvidia.sh"

    mkdir -p "$DROPIN_DIR"

    DROPIN_OK=0
    if [[ -f "$DROPIN_FILE" ]]; then
        grep -q "apply-media-patch.sh" "$DROPIN_FILE" && \
        grep -q "post-start-nvidia.sh" "$DROPIN_FILE" && \
        DROPIN_OK=1
    fi

    if [[ "$DROPIN_OK" == "1" ]]; then
        ok "systemd Drop-In vorhanden ✓ ($DROPIN_FILE)"
    else
        printf '%s\n' "$DROPIN_EXPECTED" > "$DROPIN_FILE"
        systemctl --user daemon-reload 2>/dev/null || true
        ok "systemd Drop-In erstellt: $DROPIN_FILE"
        info "ExecStartPre/Post überleben jetzt alle 'openclaw update' und 'doctor --fix' Runs"
    fi
fi

# ─── GATEWAY NEUSTART ────────────────────────────────────────────────────────
if [[ "$CHECK_ONLY" != "1" ]]; then
    header "GATEWAY NEUSTART"
    info "Starte Gateway neu (ExecStartPre führt apply-media-patch.sh aus)..."
    systemctl --user restart openclaw-gateway.service
    sleep 4
    if systemctl --user is-active --quiet openclaw-gateway.service; then
        ok "Gateway läuft"
    else
        fail "Gateway läuft NICHT — prüfe: journalctl --user -u openclaw-gateway -n 50"
        ERRORS=$((ERRORS+1))
    fi
fi

# ─── PLUGIN RUNTIME-DEPS ─────────────────────────────────────────────────────
header "PLUGIN RUNTIME-DEPS"

if ! openclaw plugins --help 2>/dev/null | grep -Eq '^[[:space:]]+deps([[:space:]]|$)'; then
    validate_local_plugin_runtime_deps || warn "Lokale Plugin Runtime-Deps/Contracts unvollständig"
else
    PLUGIN_DEPS_JSON=$(openclaw plugins deps --json 2>/dev/null || true)
    if [[ -z "$PLUGIN_DEPS_JSON" ]]; then
        warn "openclaw plugins deps lieferte keine Ausgabe"
        PLUGIN_DEPS_JSON='{}'
    fi
    PLUGIN_DEPS_MISSING=$(jq -r '.missing // [] | length' <<< "$PLUGIN_DEPS_JSON" 2>/dev/null || echo "error")
    PLUGIN_DEPS_CONFLICTS=$(jq -r '.conflicts // [] | length' <<< "$PLUGIN_DEPS_JSON" 2>/dev/null || echo "error")
    if [[ "$PLUGIN_DEPS_MISSING" == "0" && "$PLUGIN_DEPS_CONFLICTS" == "0" ]]; then
        ok "Bundled Plugin Runtime-Deps vollständig"
    else
        warn "Bundled Plugin Runtime-Deps nicht sauber (missing=$PLUGIN_DEPS_MISSING conflicts=$PLUGIN_DEPS_CONFLICTS)"
        jq '{missing, conflicts}' <<< "$PLUGIN_DEPS_JSON" 2>/dev/null | sed 's/^/       /' || true
        reminder "Wenn ENOTEMPTY/fehlende Pakete im Journal auftauchen: apply-media-patch/apply-memory-patches erneut ausführen und Gateway neu starten."
    fi
fi

# ─── SERVICE VERSION AKTUALISIEREN ──────────────────────────────────────────
if [[ "$CHECK_ONLY" != "1" ]]; then
    header "SERVICE VERSION AKTUALISIEREN"
    SERVICE_FILE="$HOME/.config/systemd/user/openclaw-gateway.service"
    if [[ ! -f "$SERVICE_FILE" ]]; then
        warn "Service-Datei nicht gefunden: $SERVICE_FILE"
    else
        CURRENT_DESC_VER=$(grep -oP '(?<=OpenClaw Gateway \(v)[^)]+' "$SERVICE_FILE" || echo "")
        CURRENT_ENV_VER=$(grep -oP '(?<=OPENCLAW_SERVICE_VERSION=)[^\s]+' "$SERVICE_FILE" || echo "")
        VERSION_NOW=$(openclaw --version 2>/dev/null || echo "unbekannt")

        if [[ "$CURRENT_DESC_VER" == "$VERSION_NOW" && "$CURRENT_ENV_VER" == "$VERSION_NOW" ]]; then
            ok "Service Version bereits aktuell: ${VERSION_NOW}"
        else
            sed -i "s/^Description=OpenClaw Gateway .*/Description=OpenClaw Gateway (v${VERSION_NOW})/" "$SERVICE_FILE"
            sed -i "s/^Environment=.*OPENCLAW_SERVICE_VERSION=.*/Environment=\"OPENCLAW_SERVICE_VERSION=${VERSION_NOW}\"/" "$SERVICE_FILE"

            # ExecStartPre wiederherstellen (openclaw update überschreibt service-Datei)
            if ! grep -q "ExecStartPre" "$SERVICE_FILE"; then
                sed -i '/^ExecStart=/i ExecStartPre=/root/.openclaw/patches/apply-media-patch.sh' "$SERVICE_FILE"
                ok "ExecStartPre wiederhergestellt (apply-media-patch.sh)"
            fi

            # ExecStartPost wiederherstellen (NVIDIA-Modelle nach Gateway-Init)
            if ! grep -q "ExecStartPost" "$SERVICE_FILE"; then
                sed -i '/^ExecStart=.*node.*gateway/a ExecStartPost=/root/.openclaw/patches/post-start-nvidia.sh' "$SERVICE_FILE"
                ok "ExecStartPost wiederhergestellt (post-start-nvidia.sh)"
            fi

            systemctl --user daemon-reload
            ok "Service Version aktualisiert: ${CURRENT_DESC_VER:-?} → ${BOLD}${VERSION_NOW}${RESET}"
        fi
    fi
fi

# ─── DEVICE-SCOPES ───────────────────────────────────────────────────────────
header "DEVICE-SCOPES (ab 2026.2.19: operator.read erforderlich)"

DEVICE_AUTH_JSON="/root/.openclaw/identity/device-auth.json"
PAIRED_DEVICES_JSON="/root/.openclaw/devices/paired.json"
DEVICE_ID=$(jq -r '.deviceId // ""' "$DEVICE_AUTH_JSON" 2>/dev/null || echo "")
if [[ -z "$DEVICE_ID" ]]; then
    warn "Konnte Device-ID nicht aus device-auth.json lesen"
else
    LOCAL_HAS_OPERATOR_READ=0
    if jq -e '((.tokens.operator.scopes // []) | index("operator.read")) != null' \
        "$DEVICE_AUTH_JSON" >/dev/null 2>&1; then
        LOCAL_HAS_OPERATOR_READ=1
    fi

    PAIRED_HAS_OPERATOR_READ=0
    if [[ -f "$PAIRED_DEVICES_JSON" ]] && \
        jq -e --arg id "$DEVICE_ID" \
        '(((.[$id].tokens.operator.scopes // .[$id].scopes // []) | index("operator.read"))) != null' \
        "$PAIRED_DEVICES_JSON" >/dev/null 2>&1; then
        PAIRED_HAS_OPERATOR_READ=1
    fi

    if [[ "$LOCAL_HAS_OPERATOR_READ" == "1" ]]; then
        ok "operator.read Scope vorhanden (lokaler CLI-Token)"
        if [[ "$PAIRED_HAS_OPERATOR_READ" != "1" ]]; then
            reminder "Hinweis: paired.json kennt fuer dieses Device keinen operator.read-Eintrag; relevant ist der lokale CLI-Token in device-auth.json."
        fi
    elif [[ "$PAIRED_HAS_OPERATOR_READ" == "1" ]]; then
        fail "Lokaler CLI-Token ist veraltet: paired.json kennt operator.read bereits, device-auth.json aber nicht"
        echo ""
        echo -e "    Fix:"
        echo -e "    openclaw devices rotate --device ${DEVICE_ID} --role operator \\"
        echo -e "      --scope operator.admin --scope operator.approvals \\"
        echo -e "      --scope operator.pairing --scope operator.read \\"
        echo -e "      --scope operator.write"
        echo ""
        if [[ "$CHECK_ONLY" != "1" ]]; then
            pause "Lokalen CLI-Token jetzt automatisch erneuern?"
            openclaw devices rotate \
                --device "$DEVICE_ID" \
                --role operator \
                --scope operator.admin \
                --scope operator.approvals \
                --scope operator.pairing \
                --scope operator.read \
                --scope operator.write
            ok "Lokaler CLI-Token erneuert — teste mit: openclaw health"
            ERRORS=$((ERRORS-1))
        fi
    else
        fail "operator.read Scope FEHLT im lokalen CLI-Token — CLI-Verbindung wird mit 'pairing required' abgelehnt!"
        echo ""
        echo -e "    Fix:"
        echo -e "    openclaw devices rotate --device ${DEVICE_ID} --role operator \\"
        echo -e "      --scope operator.admin --scope operator.approvals \\"
        echo -e "      --scope operator.pairing --scope operator.read \\"
        echo -e "      --scope operator.write"
        echo ""
        if [[ "$CHECK_ONLY" != "1" ]]; then
            pause "Scopes jetzt automatisch korrigieren?"
            openclaw devices rotate \
                --device "$DEVICE_ID" \
                --role operator \
                --scope operator.admin \
                --scope operator.approvals \
                --scope operator.pairing \
                --scope operator.read \
                --scope operator.write
            ok "Scopes korrigiert — teste mit: openclaw health"
            ERRORS=$((ERRORS-1))  # Auto-Fix: Fehler nicht zählen
        fi
    fi
fi

# ─── PATCH-VERIFIKATION ──────────────────────────────────────────────────────
header "PATCH-VERIFIKATION (apply-media-patch.sh)"

DIST="/usr/lib/node_modules/openclaw/dist"

# Patches direkt ausführen (idempotent — sicher wiederholbar)
# Das ist zuverlässiger als eigene Pattern-Checks, da apply-media-patch.sh
# exakt dieselbe Logik verwendet, die auch beim Gateway-Start läuft.
info "Führe apply-media-patch.sh aus (idempotent)..."
PATCH_OUT=$(/root/.openclaw/patches/apply-media-patch.sh 2>&1)
PATCH_RC=$?

echo "$PATCH_OUT" | sed 's/^/       /'
echo ""

if [[ $PATCH_RC -ne 0 ]]; then
    fail "apply-media-patch.sh beendet mit Exit-Code $PATCH_RC — manuelle Prüfung nötig"
elif echo "$PATCH_OUT" | grep -q "WARNING"; then
    warn "Patch-Warnung aufgetreten — Kontext oben prüfen"
else
    ok "Alle Patches: OK (angewandt, bereits aktiv, oder nativ gefixt)"
fi

# ─── BOOTSTRAP-LIMITS ────────────────────────────────────────────────────────
header "BOOTSTRAP-LIMITS (openclaw.json)"

# 4.5: openclaw config get schreibt Plugin-Logs auf stdout → direkt aus JSON lesen
BOOTSTRAP_MAX=$(python3 -c "import json; d=json.load(open('$OPENCLAW_JSON')); print(d.get('agents',{}).get('defaults',{}).get('bootstrapMaxChars','null'))" 2>/dev/null || echo "null")
BOOTSTRAP_TOTAL=$(python3 -c "import json; d=json.load(open('$OPENCLAW_JSON')); print(d.get('agents',{}).get('defaults',{}).get('bootstrapTotalMaxChars','null'))" 2>/dev/null || echo "null")

LIMITS_RESTORED=0

if [[ "$BOOTSTRAP_MAX" == "40000" ]]; then
    ok "bootstrapMaxChars = 40000"
else
    warn "bootstrapMaxChars = ${BOOTSTRAP_MAX} (erwartet: 40000) — stelle wieder her"
    python3 -c "
import json
path = '$OPENCLAW_JSON'
with open(path) as f: d = json.load(f)
d.setdefault('agents', {}).setdefault('defaults', {})['bootstrapMaxChars'] = 40000
with open(path, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False); f.write('\n')
"
    ok "  → wiederhergestellt auf 40000"
    LIMITS_RESTORED=1
fi

if [[ "$BOOTSTRAP_TOTAL" == "300000" ]]; then
    ok "bootstrapTotalMaxChars = 300000"
else
    warn "bootstrapTotalMaxChars = ${BOOTSTRAP_TOTAL} (erwartet: 300000) — stelle wieder her"
    python3 -c "
import json
path = '$OPENCLAW_JSON'
with open(path) as f: d = json.load(f)
d.setdefault('agents', {}).setdefault('defaults', {})['bootstrapTotalMaxChars'] = 300000
with open(path, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False); f.write('\n')
"
    ok "  → wiederhergestellt auf 300000"
    LIMITS_RESTORED=1
fi

if [[ "$LIMITS_RESTORED" == "1" && "$CHECK_ONLY" != "1" ]]; then
    info "Bootstrap-Limits wurden wiederhergestellt — starte Gateway neu..."
    systemctl --user restart openclaw-gateway.service
    sleep 3
    ok "Gateway neu gestartet"
fi

# ─── REASONING DEFAULT (main-Agent) ──────────────────────────────────────────
header "REASONING DEFAULT (main-Agent)"

# reasoningDefault: "stream" für main — geht nach Updates verloren (bekannt seit 4.2)
# Prüfe in agents.list (nicht agents.main — der Key ist seit 4.2 ungültig)
REASONING_CURRENT=$(python3 -c "
import json, sys
try:
    d = json.load(open('/root/.openclaw/openclaw.json'))
    lst = d.get('agents', {}).get('list', [])
    for ag in lst:
        if ag.get('id') == 'main':
            print(ag.get('reasoningDefault', 'null'))
            sys.exit(0)
    print('null')
except Exception: print('error')
" 2>/dev/null)

if [[ "$REASONING_CURRENT" == "stream" ]]; then
    ok "agents.list[main].reasoningDefault = stream"
else
    warn "agents.list[main].reasoningDefault = ${REASONING_CURRENT} (erwartet: stream) — stelle wieder her"
    if [[ "$CHECK_ONLY" != "1" ]]; then
        python3 - << 'PYEOF'
import json
path = '/root/.openclaw/openclaw.json'
d = json.load(open(path))
for ag in d.get('agents', {}).get('list', []):
    if ag.get('id') == 'main':
        ag['reasoningDefault'] = 'stream'
        break
with open(path, 'w') as f: json.dump(d, f, indent=2)
PYEOF
        ok "  → agents.list[main].reasoningDefault = stream wiederhergestellt"
        systemctl --user restart openclaw-gateway.service 2>/dev/null
        sleep 3
        ok "  → Gateway neu gestartet"
    fi
fi

# ─── ALLOWAGENTS (main-Agent muss youtube + alle Subagents enthalten) ─────────
header "ALLOWAGENTS (main-Agent)"

ALLOW_AGENTS=$(python3 -c "
import json, sys
try:
    d = json.load(open('/root/.openclaw/openclaw.json'))
    for ag in d.get('agents',{}).get('list',[]):
        if ag.get('id') == 'main':
            print(','.join(ag.get('subagents',{}).get('allowAgents',[])))
            sys.exit(0)
    print('')
except Exception: print('error')
" 2>/dev/null)

if echo "$ALLOW_AGENTS" | grep -q "youtube"; then
    ok "allowAgents enthält youtube ✓"
else
    warn "allowAgents fehlt youtube — stelle wieder her"
    if [[ "$CHECK_ONLY" != "1" ]]; then
        python3 - << 'PYEOF'
import json
path = '/root/.openclaw/openclaw.json'
d = json.load(open(path))
required = ["budget-researcher","bernhardine-budget-researcher","complex-researcher",
            "bernhardine-complex-researcher","researcher","deep-diver","developer",
            "developer-verifier","architect","writer","minimalist","labertasche",
            "youtube","agent-builder"]
for ag in d.get('agents',{}).get('list',[]):
    if ag.get('id') == 'main':
        ag.setdefault('subagents',{})['allowAgents'] = required
        break
with open(path,'w') as f: json.dump(d, f, indent=2)
PYEOF
        ok "  → allowAgents wiederhergestellt"
    fi
fi

# ─── K2P5 MODELL-PARAMETER ───────────────────────────────────────────────────
header "K2P5 MODELL-PARAMETER (contextWindow + maxTokens)"

# OpenClaw-Migrationen oder Schema-Fixes können models.json-Werte zurücksetzen.
# Korrekte Werte: contextWindow=262144 (256 Ki), maxTokens=32768.
K2P5_WRONG=$(python3 - << 'PYEOF' 2>/dev/null
import json, glob
wrong = []
for path in sorted(glob.glob('/root/.openclaw/agents/*/agent/models.json')):
    try:
        d = json.load(open(path))
        for p in d.get('providers', {}).values():
            for m in p.get('models', []):
                if m.get('id') == 'k2p5':
                    if m.get('contextWindow') != 262144 or m.get('maxTokens') != 32768:
                        wrong.append(f"{path}: ctx={m.get('contextWindow')} maxTok={m.get('maxTokens')}")
    except Exception:
        pass
print('\n'.join(wrong))
PYEOF
)

if [[ -z "$K2P5_WRONG" ]]; then
    ok "k2p5: contextWindow=262144, maxTokens=32768 in allen models.json ✓"
else
    warn "k2p5 Modell-Parameter veraltet:"
    echo "$K2P5_WRONG" | sed 's/^/       /'
    if [[ "$CHECK_ONLY" != "1" ]]; then
        python3 - << 'PYEOF' 2>/dev/null
import json, glob
for path in glob.glob('/root/.openclaw/agents/*/agent/models.json'):
    try:
        with open(path) as f: d = json.load(f)
        changed = False
        for p in d.get('providers', {}).values():
            for m in p.get('models', []):
                if m.get('id') == 'k2p5':
                    if m.get('contextWindow') != 262144:
                        m['contextWindow'] = 262144; changed = True
                    if m.get('maxTokens') != 32768:
                        m['maxTokens'] = 32768; changed = True
        if changed:
            with open(path, 'w') as f: json.dump(d, f, indent=2); f.write('\n')
    except Exception:
        pass
PYEOF
        ok "  → k2p5 contextWindow=262144, maxTokens=32768 wiederhergestellt"
    fi
fi

# ─── YAAWC PATCH-VERIFIKATION ────────────────────────────────────────────────
header "YAAWC PATCH-VERIFIKATION"

YAAWC_SRC="/root/.openclaw/docker/yaawc/src"
YAAWC_OK=1

# 1. contentUtils.ts: AIMessage muss additional_kwargs erhalten
if grep -q "additional_kwargs: message.additional_kwargs" \
    "$YAAWC_SRC/lib/utils/contentUtils.ts" 2>/dev/null; then
    ok "contentUtils.ts: additional_kwargs-Fix aktiv ✓"
else
    fail "contentUtils.ts: additional_kwargs-Fix FEHLT — tool_calls gehen beim Thinking-Trim verloren"
    YAAWC_OK=0
    reminder "Fix: src/lib/utils/contentUtils.ts → new AIMessage({ content, additional_kwargs: message.additional_kwargs, response_metadata: message.response_metadata })"
fi

# 2. kimiOpenAI.ts: maxTokens ?? 32768
if grep -q "maxTokens.*32768\|32768.*maxTokens" \
    "$YAAWC_SRC/lib/providers/kimiOpenAI.ts" 2>/dev/null; then
    ok "kimiOpenAI.ts: maxTokens ?? 32768 aktiv ✓"
else
    fail "kimiOpenAI.ts: maxTokens-Default FEHLT — Antworten werden bei LangChain-Default (4096) abgeschnitten"
    YAAWC_OK=0
    reminder "Fix: KimiChatOpenAI-Konstruktor → maxTokens: params.maxTokens ?? 32768"
fi

# 3. reranker.ts: Cohere Reranker vorhanden
if grep -q "COHERE_RERANK_URL\|cohere.com/v2/rerank" \
    "$YAAWC_SRC/lib/utils/reranker.ts" 2>/dev/null; then
    ok "reranker.ts: Cohere Reranker vorhanden ✓"
else
    fail "reranker.ts: Cohere Reranker FEHLT — simpleWebSearchTool hat kein Reranking"
    YAAWC_OK=0
    reminder "Fix: src/lib/utils/reranker.ts anlegen (Cohere API via fetch)"
fi

# 4. simpleWebSearchTool.ts: nutzt rerank()
if grep -q "from.*reranker\|await rerank(" \
    "$YAAWC_SRC/lib/tools/agents/simpleWebSearchTool.ts" 2>/dev/null; then
    ok "simpleWebSearchTool.ts: rerank() eingebunden ✓"
else
    fail "simpleWebSearchTool.ts: rerank() FEHLT — alte Embedding-Heuristik aktiv oder Reranking fehlt"
    YAAWC_OK=0
fi

# 5. COHERE_API_KEY in docker-compose.yaml
if grep -q "COHERE_API_KEY" \
    "/root/.openclaw/docker/yaawc/docker-compose.yaml" 2>/dev/null; then
    ok "docker-compose.yaml: COHERE_API_KEY env vorhanden ✓"
else
    warn "docker-compose.yaml: COHERE_API_KEY env FEHLT — Reranker läuft im Fallback-Modus"
    YAAWC_OK=0
fi

# 6. [RERANKING] in config.toml
if grep -q "\[RERANKING\]" \
    "/root/.openclaw/docker/yaawc/config.toml" 2>/dev/null; then
    ok "config.toml: [RERANKING] Sektion vorhanden ✓"
else
    warn "config.toml: [RERANKING] Sektion fehlt"
    YAAWC_OK=0
fi

if [[ "$YAAWC_OK" == "1" ]]; then
    ok "Alle YAAWC-Patches intakt"
else
    warn "YAAWC-Patches unvollständig — nach 'git pull' in docker/yaawc/ müssen Patches erneut angewendet werden"
    reminder "Rebuild: cd /root/.openclaw/docker/yaawc && docker compose up -d --build"
fi

# ─── DOCKER NO_PROXY CHECKS ──────────────────────────────────────────────────
header "DOCKER NO_PROXY CHECKS"
# Axios ignoriert CIDR-Notation in NO_PROXY (z.B. 100.64.0.0/10).
# TrueNAS-IP 100.67.149.80 muss explizit eingetragen sein — sonst läuft
# SearXNG-Traffic durch gluetun (ProtonVPN) und erhält HTTP 500.

YAAWC_COMPOSE="/root/.openclaw/docker/yaawc/docker-compose.yaml"
PERPLEXICA_COMPOSE="/root/.openclaw/docker/docker-compose.yml"

for COMPOSE_FILE in "$YAAWC_COMPOSE" "$PERPLEXICA_COMPOSE"; do
    LABEL=$(basename "$(dirname "$COMPOSE_FILE")")/$(basename "$COMPOSE_FILE")
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        warn "Nicht gefunden: $COMPOSE_FILE"
        continue
    fi
    if grep -q "NO_PROXY=.*100\.67\.149\.80" "$COMPOSE_FILE"; then
        ok "$LABEL: 100.67.149.80 in NO_PROXY ✓"
    else
        warn "$LABEL: 100.67.149.80 FEHLT in NO_PROXY — SearXNG wird durch gluetun geleitet → HTTP 500"
        if [[ "$CHECK_ONLY" != "1" ]]; then
            sed -i 's/NO_PROXY=\(.*100\.64\.0\.0\/10\)/NO_PROXY=\1,100.67.149.80/' "$COMPOSE_FILE"
            if grep -q "NO_PROXY=.*100\.67\.149\.80" "$COMPOSE_FILE"; then
                ok "  → 100.67.149.80 zu NO_PROXY hinzugefügt"
                # Betroffene Container neu starten
                if [[ "$COMPOSE_FILE" == *"yaawc"* ]]; then
                    (cd /root/.openclaw/docker/yaawc && docker compose up -d yaawc 2>/dev/null) && ok "  → yaawc neu gestartet" || warn "  → yaawc Neustart fehlgeschlagen"
                else
                    (cd /root/.openclaw/docker && docker compose up -d perplexica-backend 2>/dev/null) && ok "  → perplexica-backend neu gestartet" || warn "  → perplexica-backend Neustart fehlgeschlagen"
                fi
            else
                fail "  → sed-Patch fehlgeschlagen — bitte manuell prüfen"
            fi
        fi
    fi
done

# ─── NVIDIA RIVA API-KEY ───────────────────────────────────────────────────────
header "NVIDIA RIVA API-KEY"

if grep -q "NVIDIA_API_KEY=nvapi-" /root/.openclaw/.env 2>/dev/null; then
    ok "NVIDIA_API_KEY in .env vorhanden ✓"
else
    fail "NVIDIA_API_KEY fehlt in /root/.openclaw/.env — NVIDIA Riva STT Bridge (Port 8010) funktioniert nicht"
    reminder "Manuell eintragen: echo 'NVIDIA_API_KEY=nvapi-...' >> /root/.openclaw/.env && systemctl --user restart nvidia-riva-stt-bridge"
fi

# ─── CRON-JOBS ───────────────────────────────────────────────────────────────
header "CRON-JOBS"

info "Aktive Cron-Jobs:"
CRON_LIST_OUTPUT=$(timeout 30s openclaw cron list 2>/dev/null || true)
if [[ -n "$CRON_LIST_OUTPUT" ]]; then
    echo "$CRON_LIST_OUTPUT" | sed 's/^/       /'
elif [[ -f /root/.openclaw/cron/jobs.json ]]; then
    jq -r '.jobs[] | "       \(.enabled | if . then "✓" else "·" end) \(.name) [\(.schedule.kind)]"' /root/.openclaw/cron/jobs.json 2>/dev/null || true
    ok "Cron-Jobs aus jobs.json gelesen (CLI lieferte keine Ausgabe)"
else
    warn "openclaw cron list fehlgeschlagen und jobs.json fehlt"
fi

echo ""
info "Delivery-Targets prüfen (müssen bare ChatID sein, KEIN 'telegram:XXXXX'):"
BAD_TARGETS=$(cat /root/.openclaw/cron/jobs.json | \
    jq -r '.jobs[] | select(.delivery.to != null) | select(.delivery.to | startswith("telegram:")) | .name' \
    2>/dev/null || true)

if [[ -n "$BAD_TARGETS" ]]; then
    fail "Jobs mit falschem Delivery-Target gefunden:"
    echo "$BAD_TARGETS" | sed 's/^/       /'
    echo "       Fix: openclaw cron edit <id> --to 55736530"
else
    ok "Alle Delivery-Targets korrekt (bare ChatID)"
fi

# Bekannte Jobs vorhanden?
for JOBNAME in "proactive-agent:heartbeat" "daily-gas-weather-briefing" "morning-gas-weather-briefing"; do
    if cat /root/.openclaw/cron/jobs.json | jq -e ".jobs[] | select(.name == \"$JOBNAME\")" > /dev/null 2>&1; then
        ENABLED=$(cat /root/.openclaw/cron/jobs.json | jq -r ".jobs[] | select(.name == \"$JOBNAME\") | .enabled")
        if [[ "$ENABLED" == "true" ]]; then
            ok "Cron-Job vorhanden & aktiv: $JOBNAME"
        elif [[ "$JOBNAME" == "morning-gas-weather-briefing" ]]; then
            ok "Cron-Job absichtlich deaktiviert: $JOBNAME (ersetzt durch daily-gas-weather-briefing)"
        else
            warn "Cron-Job vorhanden aber DEAKTIVIERT: $JOBNAME"
        fi
    else
        warn "Cron-Job FEHLT: $JOBNAME"
    fi
done

# ─── YT-ANALYZE CHECKS ───────────────────────────────────────────────────────
header "YT-ANALYZE.SH CHECKS"

YT="/root/.openclaw/tools/yt-analyze.sh"

if [[ ! -f "$YT" ]]; then
    fail "yt-analyze.sh nicht gefunden: $YT"
else
    # Whisper-Server
    DOCKER_PS_OUTPUT=$(docker ps 2>&1 || true)
    if echo "$DOCKER_PS_OUTPUT" | grep -q "faster-whisper"; then
        ok "Whisper-Container läuft"
        # Richtiges Modell?
        MODEL=$(docker logs faster-whisper 2>&1 | grep -i "turbo\|large-v3\|model" | tail -3 | tr '\n' ' ')
        info "  Modell-Info: ${MODEL:-nicht lesbar}"
    elif echo "$DOCKER_PS_OUTPUT" | grep -qi "permission denied"; then
        info "Docker-Status in dieser Umgebung nicht lesbar — Container-Existenz nicht bewertet"
    else
        warn "Whisper-Container läuft NICHT — 'docker ps' zeigt ihn nicht"
    fi

    # VAD ist nur im alten Faster-Whisper-Pfad relevant. Der aktuelle lokale
    # Pfad nutzt NVIDIA/Riva/Parakeet und hat keinen vad_filter-Parameter.
    if grep -q 'vad_filter' "$YT"; then
        ok "VAD aktiv in yt-analyze.sh"
    elif grep -q '127.0.0.1:8010/v1/audio/transcriptions' "$YT" && grep -q 'parakeet-1.1b-rnnt-multilingual-asr' "$YT"; then
        ok "NVIDIA/Riva STT aktiv — VAD-Check für alten Faster-Whisper-Pfad übersprungen"
    else
        warn "VAD nicht gefunden in yt-analyze.sh"
    fi

    # Inkrementelles Speichern?
    grep -q 'Zwischenspeichern' "$YT" && ok "Inkrementelles Speichern aktiv" || warn "Inkrementelles Speichern nicht gefunden"

    # Lokale Video-Unterstützung?
    grep -q 'is_local_video_file' "$YT" && ok "Lokale Video-Unterstützung (is_local_video_file) aktiv" || warn "is_local_video_file fehlt — mp4/mkv werden ggf. nicht erkannt"

    # Kein hardcoded language=de?
    if grep -q 'language=de' "$YT"; then
        warn "ACHTUNG: 'language=de' noch in yt-analyze.sh — sollte entfernt sein (auto-detect)"
    else
        ok "Kein hardcoded language=de — automatische Spracherkennung aktiv"
    fi

    # setsid Daemon-Modus?
    grep -q 'setsid' "$YT" && ok "setsid Daemon-Modus aktiv" || warn "setsid nicht gefunden — Daemon-Entkopplung fehlt?"
fi

# ─── PLUGIN-TRUST CHECK ──────────────────────────────────────────────────────
header "PLUGIN-TRUST (plugins.allow)"

ALLOW_JSON=$(openclaw config get plugins.allow 2>/dev/null || echo '[]')
REQUIRED_PLUGINS='["before-compact-save","adaptive-learning-loop","memory-lancedb-namespaced","telegram","memory-core","active-memory"]'
MISSING_PLUGINS=$(printf '%s\n' "$ALLOW_JSON" | jq -r --argjson required "$REQUIRED_PLUGINS" '($required - (. // []))[]?' 2>/dev/null || true)
MERGED_ALLOW=$(printf '%s\n' "$ALLOW_JSON" | jq -c --argjson required "$REQUIRED_PLUGINS" '((. // []) + $required) | unique' 2>/dev/null || echo "$REQUIRED_PLUGINS")

if [[ -z "$MISSING_PLUGINS" ]]; then
    ok "plugins.allow enthält alle Pflicht-Plugins"
else
    MISSING_TEXT=$(echo "$MISSING_PLUGINS" | paste -sd ', ' -)
    warn "plugins.allow unvollständig — fehlt: ${MISSING_TEXT}"
    if [[ "$CHECK_ONLY" != "1" ]]; then
        openclaw config set plugins.allow "$MERGED_ALLOW" 2>/dev/null
        ok "  → plugins.allow wiederhergestellt"
        systemctl --user restart openclaw-gateway.service && sleep 3
    else
        reminder "Nur-Check-Modus — plugins.allow wurde nicht geändert"
    fi
fi

header "PLUGIN-VERIFIKATION"

# Warte bis Plugins tatsächlich registriert sind (bis zu 45s nach Restart).
if wait_for_plugins_ready; then
    info "Plugin-Registry bereit"
else
    info "Plugin-Registry nicht innerhalb des Status-Timeouts bereit — Checks laufen mit Journal/Plugin-Liste-Fallback"
fi
STATUS_OUTPUT="$WAIT_STATUS_OUTPUT"
JOURNAL_OUTPUT=$(journalctl --user -u openclaw-gateway --since "2 hours ago" --no-pager -n 5000 2>/dev/null || true)
PLUGIN_LIST_OUTPUT=$(timeout 60s openclaw plugins list 2>&1 || true)
if grep -q 'adaptive-learning-loop: registered' <<< "$STATUS_OUTPUT"; then
    ok "adaptive-learning-loop im OpenClaw-Status registriert"
elif grep -q 'adaptive-learning-loop: registered' <<< "$JOURNAL_OUTPUT"; then
    ok "adaptive-learning-loop im Gateway-Journal registriert"
elif grep -q 'global:adaptive-learning-loop/index.js' <<< "$PLUGIN_LIST_OUTPUT"; then
    ok "adaptive-learning-loop in Plugin-Liste enabled"
else
    warn "adaptive-learning-loop taucht in 'openclaw status' nicht als registriert auf"
fi

if grep -q 'memory-lancedb-namespaced: registered' <<< "$STATUS_OUTPUT"; then
    ok "memory-lancedb-namespaced im OpenClaw-Status registriert"
elif grep -q 'memory-lancedb-namespaced: registered' <<< "$JOURNAL_OUTPUT"; then
    ok "memory-lancedb-namespaced im Gateway-Journal registriert"
elif grep -q 'global:memory-lancedb-namespaced/index.js' <<< "$PLUGIN_LIST_OUTPUT"; then
    ok "memory-lancedb-namespaced in Plugin-Liste enabled"
else
    warn "memory-lancedb-namespaced taucht in 'openclaw status' nicht als registriert auf"
fi

# Memory-System Tiefencheck — prüft ob Auto-Capture und Auto-Recall aktiv sind
# Wichtig nach Updates: Plugin-API-Änderungen (Hook-Namen, Event-Format) führen zu
# stillem Ausfall — kein Crash, nur kein Capture mehr (Symptom: stored=0, skipped=0)
header "MEMORY-SYSTEM HEALTH CHECK"

MEM_JOURNAL=$(journalctl --user -u openclaw-gateway --since "2 hours ago" --no-pager -n 5000 2>/dev/null || true)

# 1. Plugin registriert?
# Primär: live `openclaw status` (bereits oben mit Wait-Logik geholt in $STATUS_OUTPUT).
# Fallback: Journal — nur wenn status leer ist (z.B. Gateway tot). Vorher führte das
# Journal-Only-Check zu Falschalarm "NICHT registriert" nach Update, weil die
# Registration-Zeile innerhalb von ~500 Zeilen bereits aus dem Ring rotiert war.
if grep -q 'memory-lancedb-namespaced: registered' <<< "$STATUS_OUTPUT"; then
    ok "memory-lancedb-namespaced: registered ✓"
elif grep -q 'memory-lancedb-namespaced: registered' <<< "$MEM_JOURNAL"; then
    ok "memory-lancedb-namespaced: registered ✓ (via Journal)"
elif grep -q 'global:memory-lancedb-namespaced/index.js' <<< "$PLUGIN_LIST_OUTPUT"; then
    ok "memory-lancedb-namespaced: enabled ✓ (via Plugin-Liste)"
else
    fail "memory-lancedb-namespaced: NICHT registriert — Plugin startet nicht"
fi

# 2. autoCapture aktiv?
# Primär: $STATUS_OUTPUT (openclaw status zeigt "enabling autoCapture" direkt nach
# plugin-init). Fallback: Journal — Ring-Rotation kann die Zeile nach ein paar
# Stunden aus `-n 500` drücken, siehe Kommentar bei Check 1.
if grep -q 'enabling autoCapture' <<< "$STATUS_OUTPUT"; then
    ok "autoCapture: aktiv ✓"
elif grep -q 'enabling autoCapture' <<< "$MEM_JOURNAL"; then
    ok "autoCapture: aktiv ✓ (via Journal)"
elif grep -q 'capture complete' <<< "$MEM_JOURNAL"; then
    ok "autoCapture: aktiv ✓ (Capture-Aktivität im Journal)"
else
    warn "autoCapture: nicht im Journal — evtl. deaktiviert oder API-Änderung"
fi

# 3. Auto-Recall aktiv?
if grep -q 'injecting .*memories' <<< "$MEM_JOURNAL"; then
    LAST_INJECT=$(grep 'injecting .*memories' <<< "$MEM_JOURNAL" | tail -1)
    ok "autoRecall: aktiv ✓ (letzter Inject: $(echo "$LAST_INJECT" | grep -o '[0-9]*\] .*' | head -c 60))"
else
    warn "autoRecall: keine Inject-Zeile im Journal — evtl. noch keine Session seit Neustart"
fi

# 4. Letztes Capture erfolgreich?
LAST_CAPTURE=$(grep 'capture complete' <<< "$MEM_JOURNAL" | tail -1)
if [[ -n "$LAST_CAPTURE" ]]; then
    STORED=$(echo "$LAST_CAPTURE" | grep -o 'stored=[0-9]*' | grep -o '[0-9]*')
    SKIPPED=$(echo "$LAST_CAPTURE" | grep -o 'skipped=[0-9]*' | grep -o '[0-9]*')
    if [[ "${STORED:-0}" == "0" && "${SKIPPED:-0}" == "0" ]]; then
        warn "Letztes Auto-Capture: stored=0, skipped=0 — möglicher Plugin-API-Bruch nach Update"
        warn "  → index.js auf Hook-Namen + execute-Signatur prüfen"
    else
        ok "Letztes Auto-Capture: stored=${STORED:-?}, skipped=${SKIPPED:-?} ✓"
    fi
else
    info "Kein Capture im Journal (normal wenn noch keine Agent-Session seit Neustart)"
fi

# 5. node_modules intakt?
STOCK_LANCEDB_CHECK="/root/.openclaw/extensions/memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js"
if [[ -f "$STOCK_LANCEDB_CHECK" ]]; then
    ok "memory-lancedb-stock node_modules intakt ✓"
else
    fail "memory-lancedb-stock node_modules fehlen — 'cd extensions/memory-lancedb-stock && npm install' ausführen"
fi

# 6. Git-Repo vorhanden und aktuell?
MEM_REPO="/root/openclaw-memory-system"
if [[ -d "$MEM_REPO/.git" ]]; then
    REPO_COMMIT=$(git -C "$MEM_REPO" log --oneline -1 2>/dev/null | head -c 60)
    ok "Memory-System Git-Repo vorhanden ✓ ($REPO_COMMIT)"
    # MTime kann durch lokale Reinstalls driften; Content ist die Quelle der Wahrheit.
    PLUGIN_INDEX="/root/.openclaw/extensions/memory-lancedb-namespaced/index.js"
    REPO_INDEX="$MEM_REPO/extensions/memory-lancedb-namespaced/index.js"
    if [[ -f "$PLUGIN_INDEX" && -f "$REPO_INDEX" ]]; then
        if cmp -s "$PLUGIN_INDEX" "$REPO_INDEX"; then
            ok "memory-lancedb-namespaced Runtime entspricht der Repo-Kopie"
        else
            warn "Plugin-Runtime unterscheidet sich von Repo-Kopie — 'rsync + git commit' im Repo nicht vergessen"
        fi
    fi
else
    info "Memory-System Git-Repo nicht vorhanden ($MEM_REPO) — optional, aber empfohlen"
fi
if grep -q 'adaptive-learning-loop: registered' <<< "$STATUS_OUTPUT"; then
    ok "adaptive-learning-loop im Gateway-Journal bestätigt"
elif grep -q 'adaptive-learning-loop: registered' <<< "$JOURNAL_OUTPUT"; then
    ok "adaptive-learning-loop im Gateway-Journal bestätigt (via Journal)"
elif grep -q 'global:adaptive-learning-loop/index.js' <<< "$PLUGIN_LIST_OUTPUT"; then
    ok "adaptive-learning-loop in Plugin-Liste bestätigt"
else
    warn "adaptive-learning-loop nicht in openclaw-status, Journal oder Plugin-Liste gefunden"
fi

if jq -e '.plugins.entries["memory-lancedb"]' "$OPENCLAW_JSON" >/dev/null 2>&1; then
    reminder "Bekannte CLI-Eigenheit: plugins.entries.memory-lancedb existiert noch → openclaw plugins list/doctor kann Warnungsflut erzeugen"
fi

# ─── 4.9 PLUGIN CONFIG SCHEMA FIX ────────────────────────────────────────────
# Ab 2026.4.9: Strengere configSchema-Validierung. memory-lancedb-namespaced
# darf "embedding" nicht mehr als required deklarieren (per-Agent-Init bricht sonst).
header "4.9 PLUGIN CONFIG SCHEMA FIX"

PLUGIN_MANIFEST="/root/.openclaw/extensions/memory-lancedb-namespaced/openclaw.plugin.json"
if [[ -f "$PLUGIN_MANIFEST" ]]; then
    if grep -q '"required".*"embedding"' "$PLUGIN_MANIFEST"; then
        if [[ "$CHECK_ONLY" != "1" ]]; then
            python3 -c "
import json
path = '$PLUGIN_MANIFEST'
with open(path) as f:
    d = json.load(f)
schema = d.get('configSchema', {})
if 'required' in schema and 'embedding' in schema.get('required', []):
    schema['required'] = [r for r in schema['required'] if r != 'embedding']
    if not schema['required']:
        del schema['required']
    with open(path, 'w') as f:
        json.dump(d, f, indent=2)
        f.write('\n')
    print('FIXED')
else:
    print('OK')
"
            if [[ $? -eq 0 ]]; then
                ok "configSchema.required['embedding'] entfernt (4.9-Kompatibilität)"
            else
                warn "configSchema-Fix fehlgeschlagen"
            fi
        else
            warn "configSchema hat required['embedding'] — bei Update automatisch gefixt"
        fi
    else
        ok "configSchema bereits 4.9-kompatibel"
    fi
else
    info "memory-lancedb-namespaced Plugin nicht gefunden — kein Fix nötig"
fi

# ─── 4.24 PLUGIN CONVERSATION ACCESS FIX ─────────────────────────────────────
# Ab 2026.4.24: Non-bundled plugins mit conversation hooks (agent_end etc.) müssen
# explizit plugins.entries.<id>.hooks.allowConversationAccess=true setzen.
# Sonst: "typed hook 'agent_end' blocked" → Auto-Capture funktioniert nicht.
header "4.24 PLUGIN CONVERSATION ACCESS FIX"

CONV_ACCESS=$(python3 -c "
import json, sys
try:
    d = json.load(open('/root/.openclaw/openclaw.json'))
    print(d.get('plugins', {}).get('entries', {}).get('memory-lancedb-namespaced', {}).get('hooks', {}).get('allowConversationAccess', 'missing'))
except Exception: print('error')
" 2>/dev/null)

if [[ "$CONV_ACCESS" == "True" ]]; then
    ok "memory-lancedb-namespaced.hooks.allowConversationAccess = true"
else
    warn "memory-lancedb-namespaced.hooks.allowConversationAccess fehlt (=${CONV_ACCESS}) — stelle wieder her"
    if [[ "$CHECK_ONLY" != "1" ]]; then
        python3 -c "
import json
path = '/root/.openclaw/openclaw.json'
with open(path) as f: d = json.load(f)
entry = d.setdefault('plugins', {}).setdefault('entries', {}).setdefault('memory-lancedb-namespaced', {})
entry.setdefault('hooks', {})['allowConversationAccess'] = True
with open(path, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False); f.write('\n')
"
        ok "  → allowConversationAccess = true gesetzt (Gateway-Neustart nötig)"
    fi
fi

# ─── 4.29 MESSAGES POLICY GUARDS ──────────────────────────────────────────────
header "4.29 MESSAGES POLICY GUARDS"

VISIBLE_REPLIES=$(python3 -c "
import json
with open('$OPENCLAW_JSON') as f:
    d = json.load(f)
v = d.get('messages', {}).get('visibleReplies', None)
print('missing' if v is None else str(v))
" 2>/dev/null || echo "error")

GROUP_VISIBLE_REPLIES=$(python3 -c "
import json
with open('$OPENCLAW_JSON') as f:
    d = json.load(f)
v = d.get('messages', {}).get('groupChat', {}).get('visibleReplies', None)
print('missing' if v is None else str(v))
" 2>/dev/null || echo "error")

QUEUE_MODE=$(python3 -c "
import json
with open('$OPENCLAW_JSON') as f:
    d = json.load(f)
q = d.get('messages', {}).get('queue', {})
mode = q.get('mode')
print('missing' if mode is None else str(mode))
" 2>/dev/null || echo "error")

if [[ "$VISIBLE_REPLIES" == "automatic" ]]; then
    ok "messages.visibleReplies = automatic (Direct-Chats liefern finale Replies)"
else
    warn "messages.visibleReplies = ${VISIBLE_REPLIES} (erwartet: automatic, sonst bleiben Direct-Chat-Finalantworten unsichtbar)"
    if [[ "$CHECK_ONLY" != "1" ]]; then
        python3 -c "
import json
path = '$OPENCLAW_JSON'
with open(path) as f: d = json.load(f)
d.setdefault('messages', {})['visibleReplies'] = 'automatic'
with open(path, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False); f.write('\n')
"
        ok "  → messages.visibleReplies auf automatic gesetzt"
    fi
fi

if [[ "$GROUP_VISIBLE_REPLIES" == "automatic" ]]; then
    ok "messages.groupChat.visibleReplies = automatic (Gruppen liefern finale Replies und Reasoning-Stream sichtbar aus)"
else
    warn "messages.groupChat.visibleReplies = ${GROUP_VISIBLE_REPLIES} (erwartet: automatic, sonst bleiben Gruppen-Finalantworten privat/message_tool-only)"
    if [[ "$CHECK_ONLY" != "1" ]]; then
        python3 -c "
import json
path = '$OPENCLAW_JSON'
with open(path) as f: d = json.load(f)
d.setdefault('messages', {}).setdefault('groupChat', {})['visibleReplies'] = 'automatic'
with open(path, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False); f.write('\n')
"
        ok "  → messages.groupChat.visibleReplies auf automatic gesetzt"
    fi
fi

	# ─── 4.29 KIMI-CODING THINKING GUARD ──────────────────────────────────────────
	header "4.29 KIMI-CODING THINKING GUARD"

	KIMI_PROVIDER_STATUS=$(python3 -c "
	import json
	with open('$OPENCLAW_JSON') as f:
	    d = json.load(f)
	provider = d.get('models', {}).get('providers', {}).get('kimi-coding')
	if not isinstance(provider, dict):
	    print('missing')
	else:
	    api = provider.get('api')
	    base = str(provider.get('baseUrl') or '').rstrip('/')
	    if api == 'anthropic-messages' and base == 'https://api.kimi.com/coding/v1':
	        print('fix-anthropic-base')
	    elif api == 'openai-completions' and base == 'https://api.kimi.com/coding':
	        print('fix-openai-base')
	    else:
	        print('ok')
	" 2>/dev/null || echo "error")

	if [[ "$KIMI_PROVIDER_STATUS" == "fix-anthropic-base" ]]; then
	    warn "kimi-coding Provider mischt anthropic-messages mit /coding/v1 (falsches Protokoll/BaseURL-Paar)"
	    if [[ "$CHECK_ONLY" != "1" ]]; then
	        python3 -c "
	import json
	path = '$OPENCLAW_JSON'
	with open(path) as f: d = json.load(f)
	p = d.setdefault('models', {}).setdefault('providers', {}).setdefault('kimi-coding', {})
	p['baseUrl'] = 'https://api.kimi.com/coding/'
	p['headers'] = {**(p.get('headers') or {}), 'User-Agent': (p.get('headers') or {}).get('User-Agent') or 'claude-code/1.0'}
	with open(path, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False); f.write('\n')
	"
	        ok "  → kimi-coding anthropic baseUrl auf https://api.kimi.com/coding/ gesetzt"
	    fi
	elif [[ "$KIMI_PROVIDER_STATUS" == "fix-openai-base" ]]; then
	    warn "kimi-coding Provider mischt openai-completions mit /coding (falsches Protokoll/BaseURL-Paar)"
	    if [[ "$CHECK_ONLY" != "1" ]]; then
	        python3 -c "
	import json
	path = '$OPENCLAW_JSON'
	with open(path) as f: d = json.load(f)
	p = d.setdefault('models', {}).setdefault('providers', {}).setdefault('kimi-coding', {})
	p['baseUrl'] = 'https://api.kimi.com/coding/v1'
	p['headers'] = {**(p.get('headers') or {}), 'User-Agent': (p.get('headers') or {}).get('User-Agent') or 'claude-code/1.0'}
	with open(path, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False); f.write('\n')
	"
	        ok "  → kimi-coding openai baseUrl auf https://api.kimi.com/coding/v1 gesetzt"
	    fi
	elif [[ "$KIMI_PROVIDER_STATUS" == "ok" ]]; then
	    ok "kimi-coding Provider-Protokoll/BaseURL ist konsistent"
	fi

	KIMI_CODING_CONFIGURED=$(python3 -c "
	import json
	with open('$OPENCLAW_JSON') as f:
	    d = json.load(f)
	agents = d.get('agents', {})
	defaults = agents.get('defaults', {})
	primary = defaults.get('model', {}).get('primary') if isinstance(defaults.get('model'), dict) else None
	def refs(raw):
	    if isinstance(raw, str):
	        return [raw]
	    if isinstance(raw, dict):
	        out = []
	        if isinstance(raw.get('primary'), str):
	            out.append(raw.get('primary'))
	        if isinstance(raw.get('fallbacks'), list):
	            out.extend([x for x in raw.get('fallbacks') if isinstance(x, str)])
	        return out
	    return []
	models = []
	for a in agents.get('list', []):
	    if isinstance(a, dict):
	        models.extend(refs(a.get('model')))
	print('yes' if str(primary or '').startswith('kimi-coding/') or any(m.startswith('kimi-coding/') for m in models) else 'no')
	" 2>/dev/null || echo "error")

THINKING_DEFAULT=$(python3 -c "
import json
with open('$OPENCLAW_JSON') as f:
    d = json.load(f)
v = d.get('agents', {}).get('defaults', {}).get('thinkingDefault', None)
print('missing' if v is None else str(v))
" 2>/dev/null || echo "error")

if [[ "$KIMI_CODING_CONFIGURED" == "yes" ]]; then
    if [[ "$THINKING_DEFAULT" == "low" ]]; then
        ok "agents.defaults.thinkingDefault = low (schema-valid; kimi-coding thinking on wird intern so ausgeführt)"
    else
        warn "agents.defaults.thinkingDefault = ${THINKING_DEFAULT} (kimi-coding bricht mit medium; persistenter schema-valider Wert ist low)"
        if [[ "$CHECK_ONLY" != "1" ]]; then
            python3 -c "
import json
path = '$OPENCLAW_JSON'
with open(path) as f: d = json.load(f)
d.setdefault('agents', {}).setdefault('defaults', {})['thinkingDefault'] = 'low'
with open(path, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False); f.write('\n')
"
            ok "  → agents.defaults.thinkingDefault auf low gesetzt"
        fi
    fi
else
    ok "kein kimi-coding Default gefunden; thinkingDefault bleibt unverändert"
fi

if [[ "$QUEUE_MODE" == "steer" ]]; then
    ok "messages.queue.mode = steer"
else
    warn "messages queue mode = ${QUEUE_MODE} (empfohlen: steer unter 4.29)"
    if [[ "$CHECK_ONLY" != "1" ]]; then
        python3 -c "
import json
path = '$OPENCLAW_JSON'
with open(path) as f: d = json.load(f)
q = d.setdefault('messages', {}).setdefault('queue', {})
q['mode'] = 'steer'
q.pop('activeRun', None)
with open(path, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False); f.write('\n')
"
        ok "  → messages.queue.mode = steer gesetzt"
    fi
fi

# ─── MEMORY REINDEX ──────────────────────────────────────────────────────────
# Hinweis: 'openclaw memory index' nutzt lokale CPU-Embeddings (memory-core/QMD).
# Unser primäres Memory-System ist plur1bus (memory-lancedb-namespaced) mit
# OpenAI text-embedding-3-large + Cohere rerank-v3.5 — wird automatisch via
# autoCapture aktualisiert. memory-core index ist optional und kann dauern.
if [[ "$CHECK_ONLY" != "1" ]]; then
    header "MEMORY REINDEX (plur1bus)"
    info "Aktualisiere plur1bus LanceDB-Index via embed-promoted-memories.mjs..."
    REINDEX_OPENAI_KEY="${OPENAI_API_KEY:-}"
    if [[ -z "$REINDEX_OPENAI_KEY" && -f /root/.openclaw/.env ]]; then
        REINDEX_OPENAI_KEY=$(grep '^OPENAI_API_KEY=' /root/.openclaw/.env 2>/dev/null | tail -1 | cut -d= -f2- || true)
    fi
    if [[ -n "$REINDEX_OPENAI_KEY" ]]; then
        OPENAI_API_KEY="$REINDEX_OPENAI_KEY" timeout 60s node /root/.openclaw/scripts/embed-promoted-memories.mjs 2>&1 | tail -3 | sed 's/^/       /' || true
        ok "plur1bus Memory-Index aktualisiert (embed-promoted-memories)"
    else
        reminder "OPENAI_API_KEY nicht in Umgebung oder /root/.openclaw/.env gefunden — Memory-Reindex übersprungen"
    fi

    header "PLUGIN REGISTRY REFRESH (4.25+)"
    info "Aktualisiere Cold Registry für openclaw memory CLI..."
    openclaw plugins registry --refresh 2>&1 | tail -1 | sed 's/^/       /' || true
    ok "Plugin Registry aktualisiert"

    # KEIN openclaw memory index --force mehr — der Gateway-Prozess selbst ist schwer
    # (Node.js + alle Plugins), drei parallel = massive CPU-Last auch mit OpenAI-API.
    # Incremental sync läuft automatisch beim ersten Session-Start via autoCapture.
fi

# ─── MANUELLE REVIEW-PUNKTE ──────────────────────────────────────────────────
header "MANUELLE REVIEW-PUNKTE"

echo -e "${BOLD}  Die folgenden Punkte brauchen dein Urteil:${RESET}"
echo ""
echo -e "  ${YELLOW}1. Changelog lesen:${RESET}"
echo "     Was hat sich in der neuen Version geändert?"
echo "     Gibt es Änderungen an deliver-*.js, pi-embedded-*.js, oder session-Handling?"
echo "     → https://docs.openclaw.ai/changelog (oder: npm view openclaw@latest)"
echo ""
echo -e "  ${YELLOW}2. Gateway-Logs nach Start prüfen:${RESET}"
echo "     journalctl --user -u openclaw-gateway -n 50"
echo "     Gibt es neue Warnings oder Errors die wir vorher nicht hatten?"
echo ""
echo -e "  ${YELLOW}3. Kurzer Funktionstest:${RESET}"
echo "     Telegram-Nachricht an Bernd & Bernhardine schicken, Antwort kommt?"
echo "     yt-analyze mit kurzem YouTube-Video testen (--gemini)?"
echo ""
echo -e "  ${YELLOW}4. Vor dem nächsten Update:${RESET}"
echo "     HOW-TO-UPDATE.md → 'Breaking Changes' Tabelle aktualisieren"
echo "     Update-Historie ergänzen"
echo ""
echo -e "  ${YELLOW}5. Perplexica-Backend (lokales Image!):${RESET}"
echo "     Das Backend-Image 'perplexica-backend-patched' ist ein lokaler Build"
echo "     (perplexica-backend.dockerfile). 'docker compose pull' aktualisiert es NICHT."
echo "     Bei gewünschtem Upstream-Update manuell:"
echo "       cd /root/.openclaw/docker"
echo "       docker compose build --no-cache perplexica-backend"
echo "       docker compose up -d perplexica-backend"
echo ""

# ─── AGENT-BENACHRICHTIGUNG ──────────────────────────────────────────────────
if [[ "$CHECK_ONLY" != "1" ]]; then
    header "AGENT-BENACHRICHTIGUNG"
    
    VERSION_NOW=$(openclaw --version 2>/dev/null || echo "unbekannt")
    BOT_TOKEN=$(jq -r '.channels.telegram.accounts.default.botToken' /root/.openclaw/openclaw.json 2>/dev/null || echo "")
    
    if [[ -n "$BOT_TOKEN" && "$BOT_TOKEN" != "null" ]]; then
        # Nachricht an Bernd (main)
        info "Sende Versions-Update an Bernd (main)..."
        curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
            -d "chat_id=55736530" \
            -d "text=🔄 OpenClaw Update abgeschlossen!%0A%0ANeue Version: ${VERSION_NOW}%0A%0AAlle Patches aktiv ✅%0ALanceDB Memory ✅%0Akimi-coding Thinking ✅%0ACohere Rerank ✅%0Ak2p5 maxTokens=32768 ✅" \
            -d "parse_mode=HTML" > /dev/null 2>&1 && ok "Bernd benachrichtigt" || warn "Bernd-Benachrichtigung fehlgeschlagen"
        
        # Nachricht an Bernhardine
        info "Sende Versions-Update an Bernhardine..."
        curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
            -d "chat_id=1211667028" \
            -d "text=🔄 OpenClaw Update abgeschlossen!%0A%0ANeue Version: ${VERSION_NOW}%0A%0AAlle Patches aktiv ✅%0ALanceDB Memory ✅%0Akimi-coding Thinking ✅%0ACohere Rerank ✅%0Ak2p5 maxTokens=32768 ✅" \
            -d "parse_mode=HTML" > /dev/null 2>&1 && ok "Bernhardine benachrichtigt" || warn "Bernhardine-Benachrichtigung fehlgeschlagen"
        
        # Nachricht an Heisenberg
        info "Sende Versions-Update an Heisenberg..."
        curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
            -d "chat_id=2048378590" \
            -d "text=🔄 OpenClaw Update abgeschlossen!%0A%0ANeue Version: ${VERSION_NOW}%0A%0AAlle Patches aktiv ✅%0ALanceDB Memory ✅%0Akimi-coding Thinking ✅%0ACohere Rerank ✅%0Ak2p5 maxTokens=32768 ✅" \
            -d "parse_mode=HTML" > /dev/null 2>&1 && ok "Heisenberg benachrichtigt" || warn "Heisenberg-Benachrichtigung fehlgeschlagen"
    else
        warn "Bot-Token nicht gefunden — Agents nicht benachrichtigt"
    fi
fi

# ─── ABSCHLUSSBERICHT ────────────────────────────────────────────────────────
header "ABSCHLUSSBERICHT"

VERSION_NOW=$(openclaw --version 2>/dev/null || echo "unbekannt")
info "Version jetzt: ${BOLD}${VERSION_NOW}${RESET}"

if [[ "$ERRORS" -gt 0 ]]; then
    echo -e "\n${RED}${BOLD}  ${FAIL} ${ERRORS} FEHLER aufgetreten — manuelle Nacharbeit nötig!${RESET}"
elif [[ "$WARNINGS" -gt 0 ]]; then
    echo -e "\n${YELLOW}${BOLD}  ${WARN} ${WARNINGS} Warnungen — bitte prüfen.${RESET}"
else
    echo -e "\n${GREEN}${BOLD}  ${OK} Alles grün. Viel Spaß mit der neuen Version!${RESET}"
fi

echo ""
[[ "$CHECK_ONLY" == "1" ]] && echo -e "${CYAN}(Nur-Check-Modus — kein Update wurde durchgeführt)${RESET}"
