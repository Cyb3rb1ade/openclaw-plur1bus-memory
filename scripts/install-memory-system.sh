#!/usr/bin/env bash
# install-memory-system.sh — Installiert/aktualisiert das memory-lancedb-namespaced-System
# in eine OpenClaw-Instanz (lokal oder remote via SSH).
#
# Stand: 2026-05-28
#
# Verwendung:
#   ./install-memory-system.sh                          # Auto-Erkennung lokaler Installationen
#   ./install-memory-system.sh <ziel>                   # lokal: /home/user/.openclaw
#   ./install-memory-system.sh user@host:/path          # remote via SSH
#   ./install-memory-system.sh --dry-run <ziel>         # Vorschau ohne Änderungen
#   ./install-memory-system.sh --update-plugin-only <ziel>  # Nur Plugin aktualisieren; Memory/Embeddings/Provider bleiben erhalten
#   ./install-memory-system.sh --rollback <ziel>        # Letzten Snapshot wiederherstellen
#   ./install-memory-system.sh --legacy-host-cron <ziel> # Legacy-User-Crontab-Jobs explizit einrichten
#
# Ohne Ziel-Argument: sucht automatisch nach lokalen OpenClaw-Installationen
# (prüft ~/.openclaw, /root/.openclaw, /home/*/.openclaw, /opt/, /srv/ etc.)
# und zeigt ein Auswahlmenü wenn mehrere gefunden werden.
#
# Snapshot-/Daten-Verhalten: Vor jeder Installation wird ein LanceDB-Snapshot
# unter {ziel}/memory/.snapshots/ erstellt. Max. 5 Snapshots, ältere werden
# gelöscht. Plugin-Updates löschen nicht {ziel}/memory/lancedb-namespaced,
# bestehende Embeddings, Provider-Konfiguration oder Cohere-Reranker-Settings.
#
# Runtime-Verhalten: Der v4-Normalbetrieb nutzt OpenClaw-Hooks, Plugin-Services
# und OpenClaw-managed Crons. Dieses Script richtet keine Host-/User-Crontabs
# als Primärpfad ein, außer --legacy-host-cron wird ausdrücklich gesetzt.
#
# Voraussetzungen (Quellinstanz):
#   - Node.js (für jq-ähnliche JSON-Operationen via node)
#   - rsync (für Dateiübertragung)
#   - ssh/scp (bei Remote-Ziel)
#   - python3 (für Versions-Anzeige im Auswahlmenü)

set -euo pipefail

# ─── Konstanten ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"  # /root/.openclaw
PLUGIN_SRC="$SOURCE_DIR/extensions/memory-lancedb-namespaced"
STOCK_SRC="$SOURCE_DIR/extensions/memory-lancedb-stock"
DOC_FILES=("README.md" "CHANGELOG.md" "how-to-memory.md" "how-to-memory-perfect.md" "HOW-TO-OBSIDIAN.md" "HOW-TO-UPDATE.md")
GC_SCRIPT="$SOURCE_DIR/scripts/memory-gc.mjs"
MIN_OPENCLAW_VERSION="2026.5.10-beta.5"
# Ab dieser Version (inkl. Betas) führt OpenClaw das STRICT-State-Schema v2
# (cron_jobs mit schedule_identity + kanonischem job_json).
STATE_SCHEMA_V2_MIN_VERSION="2026.7.2-beta.1"
INSTALLER_CONFIG_HELPER="$SOURCE_DIR/scripts/lib/installer-config.mjs"
AGENTS_PATCHER_HELPER="$SOURCE_DIR/scripts/lib/patch-agents-memory-instructions.mjs"
INSTALL_LOG_FILE="plur1bus-install-log.jsonl"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
BOLD='\033[1m'

# ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

info()    { echo -e "${CYAN}[info]${RESET} $*"; }
ok()      { echo -e "${GREEN}[ok]${RESET}   $*"; }
warn()    { echo -e "${YELLOW}[warn]${RESET} $*"; }
error()   { echo -e "${RED}[error]${RESET} $*" >&2; }
step()    { echo -e "\n${BOLD}▶ $*${RESET}"; }
dryrun()  { echo -e "${YELLOW}[dry-run]${RESET} $*"; }

usage() {
  cat <<EOF
Verwendung: $0 [--dry-run] [--update-plugin-only] [--rollback] [ziel]

Ziele:
  Lokal:              $0 /home/user/.openclaw
  Remote:             $0 user@host:/home/user/.openclaw
  Auto-Erkennung:     $0

Optionen:
  --dry-run              Vorschau ohne Änderungen
  --update-plugin-only   Nur Plugin-Dateien und Registry aktualisieren; Memory-Daten, Embeddings und Provider-Config bleiben erhalten
  --rollback             Letzten Snapshot wiederherstellen
  --accept-defaults      Keine Prompts; Recommended/Full-Experience-Defaults verwenden
  --non-interactive      Alias für --accept-defaults
  --legacy-host-cron     Legacy-User-Crontab-Jobs für GC/KNOWLEDGE explizit einrichten
  -h, --help             Diese Hilfe anzeigen
EOF
}

version_ge() {
  local have="$1" need="$2"
  [[ -z "$have" || -z "$need" ]] && return 1

  local have_rank need_rank
  have_rank=$(version_rank "$have") || return 1
  need_rank=$(version_rank "$need") || return 1
  [[ "$have_rank" -ge "$need_rank" ]]
}

version_rank() {
  local version="$1"
  local major minor patch beta patch_release prerelease_rank
  version="${version#v}"
  if [[ "$version" =~ ^([0-9]{4})\.([0-9]{1,2})\.([0-9]{1,2})(-beta\.([0-9]+))?(-([0-9]+))?$ ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    patch="${BASH_REMATCH[3]}"
    beta="${BASH_REMATCH[5]:-}"
    patch_release="${BASH_REMATCH[7]:-0}"
    if [[ -n "$beta" ]]; then
      prerelease_rank="$beta"
    else
      # Stable releases on the same date are newer than all beta builds.
      prerelease_rank=$((100000 + patch_release))
    fi
    printf '%04d%02d%02d%06d\n' "$major" "$minor" "$patch" "$prerelease_rank"
    return 0
  fi
  return 1
}

display_default() {
  local prompt_text="$1" default_val="${2:-}"
  if [[ "$prompt_text" =~ ([Kk]ey|[Ss]ecret|API) && -n "$default_val" && "$default_val" != \$\{* ]]; then
    printf '%s' '***'
  else
    printf '%s' "$default_val"
  fi
}

confirm() {
  local prompt="$1" default="${2:-y}"
  local yn
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "Würde Ja/Nein fragen: $prompt (default=$default)"
    [[ "$default" =~ ^[Yy]$ ]]
    return $?
  fi
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    info "Non-interactive: $prompt (default=$default)"
    [[ "$default" =~ ^[Yy]$ ]]
    return $?
  fi
  read -rp "$prompt [y/n, default=$default]: " yn
  yn="${yn:-$default}"
  [[ "$yn" =~ ^[Yy]$ ]]
}

prompt_choice() {
  local var_name="$1" prompt_text="$2" default_val="$3"
  shift 3
  local choices=("$@")
  local val valid
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "Würde Auswahl fragen: $prompt_text (default=$default_val; Optionen: ${choices[*]})"
    printf -v "$var_name" '%s' "$default_val"
    return 0
  fi
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    info "Non-interactive: $prompt_text -> $default_val"
    printf -v "$var_name" '%s' "$default_val"
    return 0
  fi
  while true; do
    read -rp "  $prompt_text [${default_val}] (${choices[*]}): " val
    val="${val:-$default_val}"
    valid=0
    for choice in "${choices[@]}"; do
      [[ "$val" == "$choice" ]] && valid=1 && break
    done
    if [[ "$valid" == "1" ]]; then
      printf -v "$var_name" '%s' "$val"
      return 0
    fi
    warn "Ungültige Auswahl: $val"
  done
}

prompt_secret() {
  local var_name="$1" prompt_text="$2" default_hint="${3:-}"
  local val
  if [[ -n "$default_hint" ]]; then
    echo -e "  ${CYAN}$prompt_text${RESET} [$(display_default "$prompt_text" "$default_hint")]:"
  else
    echo -e "  ${CYAN}$prompt_text${RESET}:"
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "Würde Secret abfragen: $prompt_text"
    printf -v "$var_name" '%s' "$default_hint"
    return 0
  fi
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    info "Non-interactive: Secret-Prompt übersprungen: $prompt_text"
    printf -v "$var_name" '%s' "$default_hint"
    return 0
  fi
  read -rs val
  echo
  val="${val:-$default_hint}"
  printf -v "$var_name" '%s' "$val"
}

prompt_input() {
  local var_name="$1" prompt_text="$2" default_val="${3:-}"
  local val
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "Würde Eingabe abfragen: $prompt_text [$(display_default "$prompt_text" "$default_val")]"
    printf -v "$var_name" '%s' "$default_val"
    return 0
  fi
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    info "Non-interactive: $prompt_text -> $(display_default "$prompt_text" "$default_val")"
    printf -v "$var_name" '%s' "$default_val"
    return 0
  fi
  read -rp "  $prompt_text [$(display_default "$prompt_text" "$default_val")]: " val
  val="${val:-$default_val}"
  printf -v "$var_name" '%s' "$val"
}

# ─── Remote/Lokal-Abstraktion ─────────────────────────────────────────────────

# Führt einen Befehl auf dem Ziel aus (lokal oder remote)
run_target() {
  if [[ "$IS_REMOTE" == "1" ]]; then
    ssh "$SSH_HOST" "$@"
  else
    bash -c "$1"
  fi
}

# Kopiert eine Datei/Verzeichnis zum Ziel
copy_to_target() {
  local src="$1" dest="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "rsync -a '$src' '$dest'"
    return 0
  fi
  if [[ "$IS_REMOTE" == "1" ]]; then
    rsync -a --delete "$src" "${SSH_HOST}:${dest}"
  else
    rsync -a --delete "$src" "$dest"
  fi
}

# Schreibt Text in eine Datei auf dem Ziel (via heredoc)
write_target_file() {
  local path="$1" content="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "Schreibe nach '$path'"
    return 0
  fi
  if [[ "$IS_REMOTE" == "1" ]]; then
    local escaped_path
    escaped_path=$(printf '%q' "$path")
    ssh "$SSH_HOST" "cat > $escaped_path" <<< "$content"
  else
    printf '%s' "$content" > "$path"
  fi
}

# Hängt eine JSONL-Zeile oder Text sicher an eine Datei auf dem Ziel an.
append_target_file() {
  local path="$1" content="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "Hänge an '$path' an"
    return 0
  fi
  if [[ "$IS_REMOTE" == "1" ]]; then
    local escaped_path
    escaped_path=$(printf '%q' "$path")
    ssh "$SSH_HOST" "cat >> $escaped_path" <<< "$content"
  else
    printf '%s\n' "$content" >> "$path"
  fi
}

# Liest eine Datei vom Ziel
read_target_file() {
  local path="$1"
  if [[ "$IS_REMOTE" == "1" ]]; then
    ssh "$SSH_HOST" "cat '$path' 2>/dev/null || echo ''"
  else
    cat "$path" 2>/dev/null || echo ""
  fi
}

# Aktualisiert die OpenClaw-Plugin-Registry, damit Versionsanzeigen nicht aus
# plugins/installs.json veralten, nachdem Dateien direkt kopiert wurden.
refresh_plugin_registry() {
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "openclaw plugins registry --refresh"
    return 0
  fi
  if ! run_target "command -v openclaw >/dev/null 2>&1"; then
    warn "openclaw CLI nicht gefunden — Plugin-Registry nicht aktualisiert"
    return 0
  fi
  if run_target "openclaw plugins registry --refresh >/dev/null"; then
    ok "OpenClaw Plugin-Registry aktualisiert"
  else
    warn "OpenClaw Plugin-Registry konnte nicht aktualisiert werden"
  fi
}

# ─── Argument-Parsing ─────────────────────────────────────────────────────────

DRY_RUN=0
UPDATE_ONLY=0
ROLLBACK=0
LEGACY_HOST_CRON=0
NON_INTERACTIVE=0
TARGET=""

for arg in "$@"; do
  case "$arg" in
    -h|--help)          usage; exit 0 ;;
    --dry-run)            DRY_RUN=1 ;;
    --update-plugin-only) UPDATE_ONLY=1 ;;
    --rollback)           ROLLBACK=1 ;;
    --accept-defaults|--non-interactive) NON_INTERACTIVE=1 ;;
    --legacy-host-cron)    LEGACY_HOST_CRON=1 ;;
    --*)                  error "Unbekannte Option: $arg"; usage; exit 2 ;;
    *) TARGET="$arg" ;;
  esac
done

# ─── Auto-Erkennung lokaler OpenClaw-Instanzen ────────────────────────────────

detect_local_installations() {
  local found=()
  local search_dirs=(
    "$HOME/.openclaw"
    "/root/.openclaw"
    "/home/*/.openclaw"
    "/opt/openclaw"
    "/opt/*/openclaw"
    "/srv/openclaw"
    "/var/lib/openclaw"
  )
  for pattern in "${search_dirs[@]}"; do
    for dir in $pattern; do
      [[ -f "$dir/openclaw.json" ]] && found+=("$dir")
    done
  done
  # Deduplizieren
  local seen=()
  for d in "${found[@]}"; do
    local abs
    abs=$(realpath "$d" 2>/dev/null || echo "$d")
    local already=0
    for s in "${seen[@]}"; do [[ "$s" == "$abs" ]] && already=1 && break; done
    [[ "$already" == "0" ]] && seen+=("$abs")
  done
  printf '%s\n' "${seen[@]}"
}

if [[ -z "$TARGET" ]]; then
  # Kein Ziel angegeben — lokale Instanzen suchen
  mapfile -t FOUND_INSTALLS < <(detect_local_installations)

  if [[ ${#FOUND_INSTALLS[@]} -eq 0 ]]; then
    usage
    echo
    warn "Keine lokale OpenClaw-Installation gefunden. Bitte Pfad manuell angeben."
    exit 1

  elif [[ ${#FOUND_INSTALLS[@]} -eq 1 ]]; then
    echo -e "${BOLD}Gefundene OpenClaw-Installation:${RESET}"
    echo "  ${FOUND_INSTALLS[0]}"
    echo
    if [[ "$NON_INTERACTIVE" == "1" ]]; then
      info "Non-interactive: verwende gefundene Installation ${FOUND_INSTALLS[0]}"
      TARGET="${FOUND_INSTALLS[0]}"
    else
      read -rp "Diese Installation verwenden? [Y/n]: " yn
      yn="${yn:-y}"
      if [[ ! "$yn" =~ ^[Yy]$ ]]; then
        read -rp "Pfad manuell eingeben: " TARGET
      else
        TARGET="${FOUND_INSTALLS[0]}"
      fi
    fi

  else
    echo -e "${BOLD}Mehrere OpenClaw-Installationen gefunden:${RESET}"
    echo
    for i in "${!FOUND_INSTALLS[@]}"; do
      # Version aus openclaw.json lesen falls vorhanden
      ver=$(python3 -c "
import json, sys
try:
    d = json.load(open('${FOUND_INSTALLS[$i]}/openclaw.json'))
    print(d.get('meta',{}).get('lastTouchedVersion','?'))
except: print('?')
" 2>/dev/null || echo "?")
      echo "  [$((i+1))] ${FOUND_INSTALLS[$i]}  (v${ver})"
    done
    echo "  [m] Pfad manuell eingeben"
    echo
    if [[ "$NON_INTERACTIVE" == "1" ]]; then
      TARGET="${FOUND_INSTALLS[0]}"
      info "Non-interactive: verwende erste gefundene Installation $TARGET"
    else
      while true; do
        read -rp "Auswahl [1-${#FOUND_INSTALLS[@]}]: " sel
        if [[ "$sel" == "m" ]]; then
          read -rp "Pfad: " TARGET
          break
        elif [[ "$sel" =~ ^[0-9]+$ ]] && (( sel >= 1 && sel <= ${#FOUND_INSTALLS[@]} )); then
          TARGET="${FOUND_INSTALLS[$((sel-1))]}"
          break
        else
          warn "Ungültige Auswahl. Bitte Zahl zwischen 1 und ${#FOUND_INSTALLS[@]} eingeben."
        fi
      done
    fi
  fi

  [[ -z "$TARGET" ]] && { error "Kein Ziel gewählt."; exit 1; }
fi

# ─── Ziel analysieren ─────────────────────────────────────────────────────────

IS_REMOTE=0
SSH_HOST=""
TARGET_DIR=""

if [[ "$TARGET" == *":"* ]]; then
  IS_REMOTE=1
  SSH_HOST="${TARGET%%:*}"
  TARGET_DIR="${TARGET#*:}"
else
  # Normalize local path — prevents traversal via symlinks or relative components
  TARGET_DIR="$(realpath -m "$TARGET" 2>/dev/null || echo "$TARGET")"
fi

# ─── Header ───────────────────────────────────────────────────────────────────

echo -e "\n${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   memory-lancedb-namespaced — Installationsskript        ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo
info "Quelle:  $SOURCE_DIR"
if [[ "$IS_REMOTE" == "1" ]]; then
  info "Ziel:    $SSH_HOST:$TARGET_DIR (remote)"
else
  info "Ziel:    $TARGET_DIR (lokal)"
fi
[[ "$DRY_RUN" == "1" ]] && warn "DRY-RUN-Modus — keine Änderungen werden vorgenommen."
[[ "$UPDATE_ONLY" == "1" ]] && warn "UPDATE-PLUGIN-ONLY-Modus — nur Plugin-Dateien werden aktualisiert."
[[ "$ROLLBACK" == "1" ]] && warn "ROLLBACK-Modus — stellt letzten Snapshot wieder her."
[[ "$LEGACY_HOST_CRON" == "1" ]] && warn "LEGACY-HOST-CRON-Modus — User-Crontab-Jobs werden explizit eingerichtet."
echo

# ─── Rollback: Schnellpfad ────────────────────────────────────────────────────

if [[ "$ROLLBACK" == "1" ]]; then
  step "Rollback"

  SNAPSHOT_DIR="$TARGET_DIR/memory/.snapshots"
  LATEST_SNAP=$(run_target "ls -t '$SNAPSHOT_DIR'/*.tar.gz 2>/dev/null | head -1" 2>/dev/null || echo "")

  if [[ -z "$LATEST_SNAP" ]]; then
    error "Kein Snapshot gefunden unter $SNAPSHOT_DIR"
    exit 1
  fi

  info "Neuester Snapshot: $LATEST_SNAP"

  # openclaw.json Backup wiederherstellen
  LATEST_BAK=$(run_target "ls -t '${TARGET_DIR}/openclaw.json.bak.'* 2>/dev/null | head -1" 2>/dev/null || echo "")
  if [[ -n "$LATEST_BAK" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      dryrun "cp '$LATEST_BAK' '$TARGET_DIR/openclaw.json'"
    else
      run_target "cp '$LATEST_BAK' '$TARGET_DIR/openclaw.json'"
      ok "openclaw.json wiederhergestellt aus: $LATEST_BAK"
    fi
  else
    warn "Kein openclaw.json-Backup gefunden — Config wird nicht zurückgesetzt."
  fi

  # LanceDB wiederherstellen
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "tar -xzf '$LATEST_SNAP' -C '$TARGET_DIR/memory'"
  else
    run_target "tar -xzf '$LATEST_SNAP' -C '$TARGET_DIR/memory'"
    ok "LanceDB wiederhergestellt aus: $LATEST_SNAP"
  fi

  echo
  echo -e "${BOLD}Rollback abgeschlossen.${RESET}"
  echo "  Gateway neu starten:"
  if [[ "$IS_REMOTE" == "1" ]]; then
    echo "    ssh $SSH_HOST 'systemctl --user restart openclaw-gateway.service'"
  else
    echo "    systemctl --user restart openclaw-gateway.service"
  fi
  echo
  exit 0
fi

# ─── Update-Only: Schnellpfad ─────────────────────────────────────────────────

if [[ "$UPDATE_ONLY" == "1" ]]; then
  step "Plugin-Update (--update-plugin-only)"

  EXTENSIONS_DIR="$TARGET_DIR/extensions"

  if [[ "$IS_REMOTE" == "1" ]]; then
    if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$SSH_HOST" "echo ok" &>/dev/null; then
      error "SSH-Verbindung zu '$SSH_HOST' fehlgeschlagen."
      exit 1
    fi
  fi

  if [[ ! -d "$PLUGIN_SRC" ]]; then
    error "Plugin nicht gefunden: $PLUGIN_SRC"
    exit 1
  fi

  info "Kopiere memory-lancedb-namespaced..."
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "rsync -a --delete '$PLUGIN_SRC' '$EXTENSIONS_DIR/'"
  else
    if [[ "$IS_REMOTE" == "1" ]]; then
      rsync -a --delete "$PLUGIN_SRC" "${SSH_HOST}:${EXTENSIONS_DIR}/"
    else
      rsync -a --delete "$PLUGIN_SRC" "$EXTENSIONS_DIR/"
    fi
    ok "Plugin aktualisiert: $EXTENSIONS_DIR/memory-lancedb-namespaced/"
  fi
  refresh_plugin_registry

  echo
  echo -e "${BOLD}Plugin-Update abgeschlossen.${RESET}"
  echo
  echo "  Gateway neu starten:"
  if [[ "$IS_REMOTE" == "1" ]]; then
    echo "    ssh $SSH_HOST 'systemctl --user restart openclaw-gateway.service'"
  else
    echo "    systemctl --user restart openclaw-gateway.service"
  fi
  echo
  exit 0
fi

# ─── Schritt 0: Voraussetzungen prüfen ────────────────────────────────────────

step "Schritt 0: Voraussetzungen prüfen"

# Lokale Voraussetzungen
for cmd in rsync jq node; do
  if ! command -v "$cmd" &>/dev/null; then
    error "Voraussetzung fehlt: '$cmd' nicht gefunden."
    exit 1
  fi
done
ok "rsync, jq, node verfügbar"

# Plugin-Quellen vorhanden?
if [[ ! -d "$PLUGIN_SRC" ]]; then
  error "Plugin nicht gefunden: $PLUGIN_SRC"
  exit 1
fi
if [[ ! -d "$STOCK_SRC" ]]; then
  error "LanceDB stock nicht gefunden: $STOCK_SRC"
  exit 1
fi
if [[ ! -f "$INSTALLER_CONFIG_HELPER" ]]; then
  error "Installer-Config-Helper nicht gefunden: $INSTALLER_CONFIG_HELPER"
  exit 1
fi
ok "Plugin-Quellen vorhanden"

# Remote-Verbindung testen
if [[ "$IS_REMOTE" == "1" ]]; then
  if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$SSH_HOST" "echo ok" &>/dev/null; then
    error "SSH-Verbindung zu '$SSH_HOST' fehlgeschlagen. SSH-Key eingerichtet?"
    exit 1
  fi
  ok "SSH-Verbindung zu $SSH_HOST erfolgreich"
fi

# Ziel-openclaw.json vorhanden?
TARGET_CONFIG="$TARGET_DIR/openclaw.json"
if ! run_target "test -f '$TARGET_CONFIG'" 2>/dev/null; then
  error "Keine openclaw.json gefunden unter $TARGET_CONFIG"
  error "Ist das ein gültiges OpenClaw-Verzeichnis?"
  exit 1
fi
ok "openclaw.json gefunden"

# Mindestversion prüfen. CLI-Version ist maßgeblich; meta.lastTouchedVersion in
# openclaw.json kann nach Updates stale sein.
OPENCLAW_VERSION_RAW=$(run_target "openclaw --version 2>/dev/null | head -1" 2>/dev/null || true)
OPENCLAW_VERSION=$(printf '%s\n' "$OPENCLAW_VERSION_RAW" | grep -Eo '[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(-beta\.[0-9]+)?(-[0-9]+)?' | head -1 || true)
if [[ -z "$OPENCLAW_VERSION" ]]; then
  warn "OpenClaw-Version konnte nicht automatisch erkannt werden."
  warn "Dieses Release benötigt OpenClaw >= $MIN_OPENCLAW_VERSION."
elif version_ge "$OPENCLAW_VERSION" "$MIN_OPENCLAW_VERSION"; then
  ok "OpenClaw-Version kompatibel: $OPENCLAW_VERSION >= $MIN_OPENCLAW_VERSION"
else
  error "OpenClaw $OPENCLAW_VERSION erkannt; erforderlich ist >= $MIN_OPENCLAW_VERSION."
  error "Bitte zuerst OpenClaw aktualisieren, dann Installer erneut ausführen."
  exit 1
fi

# ─── Schritt 1: API-Keys abfragen ─────────────────────────────────────────────

step "Schritt 1: API-Keys"
echo "  Diese Keys werden in die Ziel-openclaw.json eingetragen."
echo "  Leer lassen = Umgebungsvariablen-Syntax verwenden (\${VAR})."
echo

OPENAI_KEY=""
COHERE_KEY=""
USE_MERGING="n"
USE_EMBEDDING_FALLBACK="n"
EMBEDDING_FALLBACK_KEY=""
EMBEDDING_FALLBACK_BASEURL=""
EMBEDDING_FALLBACK_MODEL=""
USE_ACTIVE_MEMORY="n"
KEEP_EXISTING_MEMORY_CONFIG=0
KEEP_EXISTING_ACTIVE_MEMORY_CONFIG=0
MEMORY_CONFIG_MODE=""
ACTIVE_MEMORY_MODE=""
FEATURE_UPDATE_MODE="preserve"
FEATURE_POLICY_MODE="preserve"
FEATURE_UPDATE_PLAN=""
FEATURE_UPDATE_IS_UPDATE="false"
INSTALL_LOG_PATH="$TARGET_DIR/state/$INSTALL_LOG_FILE"
INSTALL_LOG_CONTENT=""

# Bestehende Config als Default verwenden. Full-Install darf bei Updates nicht
# versehentlich Keys, Pfade oder moderne 4.x-Konfigurationen überschreiben.
EXISTING_PLUGIN_ENTRY=$(run_target "jq -c '.plugins.entries[\"memory-lancedb-namespaced\"] // null' '$TARGET_CONFIG' 2>/dev/null" || echo "null")
EXISTING_EMBEDDING_KEY=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.embedding.apiKey // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_EMBEDDING_PROVIDER=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.embedding.provider // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_EMBEDDING_MODEL=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.embedding.model // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_EMBEDDING_BASE_URL=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.embedding.baseUrl // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_EMBEDDING_DIMS=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.embedding.dimensions // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_BASE_DB_PATH=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.baseDbPath // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_COHERE_KEY=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.reranker.apiKey // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_RERANKER_PROVIDER=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.reranker.provider // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_RERANKER_MODEL=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.reranker.model // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_MEMORY_SLOT=$(run_target "jq -r '.plugins.slots.memory // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
MEMORY_SEARCH_EMBEDDING_KEY=$(run_target "jq -r '.agents.defaults.memorySearch.remote.apiKey // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
MEMORY_SEARCH_EMBEDDING_MODEL=$(run_target "jq -r '.agents.defaults.memorySearch.model // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_ACTIVE_MEMORY_ENTRY=$(run_target "jq -c '.plugins.entries[\"active-memory\"] // null' '$TARGET_CONFIG' 2>/dev/null" || echo "null")
DEFAULT_CHAT_MODEL=$(run_target "jq -r '.agents.defaults.model.primary // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
DEFAULT_CHAT_FALLBACK=$(run_target "jq -r '.agents.defaults.model.fallbacks[0] // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
INSTALL_LOG_CONTENT=$(read_target_file "$INSTALL_LOG_PATH" || true)

FEATURE_PLAN_INPUT=$(jq -n \
  --argjson existing "$EXISTING_PLUGIN_ENTRY" \
  --arg log "$INSTALL_LOG_CONTENT" \
  '{
    existingPluginEntry: (if $existing == null then null else $existing end),
    existingPluginConfig: (if $existing == null then null else ($existing.config // {}) end),
    proposedPluginConfig: (if $existing == null then {} else ($existing.config // {}) end),
    installLogContent: $log,
    mode: "preserve"
  }')
FEATURE_UPDATE_PLAN=$(PLUR1BUS_INSTALLER_INPUT="$FEATURE_PLAN_INPUT" node "$INSTALLER_CONFIG_HELPER" feature-plan)
eval "$(printf '%s' "$FEATURE_UPDATE_PLAN" | jq -r '@sh "FEATURE_UPDATE_IS_UPDATE=\(.isUpdate) DETECTED_BY_CONFIG=\(.detectedBy.config) DETECTED_BY_LOG=\(.detectedBy.log) NEW_FEATURE_COUNT=\(.newlyActivated | length) PRESERVED_DISABLED_COUNT=\(.preservedDisabled | length)"')"

if [[ "$FEATURE_UPDATE_IS_UPDATE" == "true" ]]; then
  info "Bestehende PLUR1BUS-Installation erkannt (config=$DETECTED_BY_CONFIG, log=$DETECTED_BY_LOG)."
  if [[ "$NEW_FEATURE_COUNT" -gt 0 ]]; then
    info "Fehlende Core-Features mit wirksamen Manifest-Defaults (ohne die Rohconfig umzuschreiben):"
    printf '%s\n' "$FEATURE_UPDATE_PLAN" | jq -r '.newlyActivated[]? | "  - " + .label'
  fi
  if [[ "$PRESERVED_DISABLED_COUNT" -gt 0 ]]; then
    warn "Explizit deaktivierte Features bleiben im sicheren Update-Modus deaktiviert:"
    printf '%s\n' "$FEATURE_UPDATE_PLAN" | jq -r '.preservedDisabled[]? | "  - " + .label'
  fi
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    FEATURE_UPDATE_MODE="recommended"
    info "--accept-defaults: Recommended wurde ausdrücklich ausgewählt."
  else
    prompt_choice FEATURE_UPDATE_MODE "Feature-Profil: preserve=unverändert, safe=Safe, recommended=Recommended" "preserve" "preserve" "safe" "recommended"
  fi
else
  info "Keine bestehende PLUR1BUS-Installation in Config/Install-Log erkannt."
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    FEATURE_UPDATE_MODE="recommended"
    info "--accept-defaults: Recommended wurde ausdrücklich ausgewählt."
  else
    prompt_choice FEATURE_UPDATE_MODE "Feature-Profil: safe=Safe, recommended=Recommended" "safe" "safe" "recommended"
  fi
fi

case "$FEATURE_UPDATE_MODE" in
  preserve|safe|recommended) FEATURE_POLICY_MODE="$FEATURE_UPDATE_MODE" ;;
  *) error "Ungültiger Feature-Modus: $FEATURE_UPDATE_MODE"; exit 2 ;;
esac
EMBEDDING_KEY_DEFAULT="$EXISTING_EMBEDDING_KEY"
[[ -z "$EMBEDDING_KEY_DEFAULT" ]] && EMBEDDING_KEY_DEFAULT="$MEMORY_SEARCH_EMBEDDING_KEY"
[[ -z "$EMBEDDING_KEY_DEFAULT" ]] && EMBEDDING_KEY_DEFAULT='${OPENAI_API_KEY}'
EMBEDDING_MODEL_DEFAULT="$EXISTING_EMBEDDING_MODEL"
[[ -z "$EMBEDDING_MODEL_DEFAULT" ]] && EMBEDDING_MODEL_DEFAULT="$MEMORY_SEARCH_EMBEDDING_MODEL"
[[ -z "$EMBEDDING_MODEL_DEFAULT" ]] && EMBEDDING_MODEL_DEFAULT="text-embedding-3-large"

if [[ "$EXISTING_PLUGIN_ENTRY" != "null" && -n "$EXISTING_PLUGIN_ENTRY" ]]; then
  info "Bestehende memory-lancedb-namespaced-Config gefunden."
  info "Der Installer kann bestehende Provider/Modelle unverändert übernehmen oder bewusst neu konfigurieren."
  prompt_choice MEMORY_CONFIG_MODE "Memory-Konfigurationsmodus: keep=unverändert übernehmen, reconfigure=neu konfigurieren" "keep" "keep" "reconfigure"
else
  info "Keine bestehende memory-lancedb-namespaced-Config gefunden — Fresh-Install wird konfiguriert."
  MEMORY_CONFIG_MODE="fresh"
fi

case "$MEMORY_CONFIG_MODE" in
  keep)
    KEEP_EXISTING_MEMORY_CONFIG=1
    info "Memory-Config wird übernommen; keine provider-spezifischen Defaults werden gesetzt."
    ;;
  reconfigure)
    info "Memory-Config wird bewusst neu konfiguriert."
    ;;
  fresh)
    info "Memory-Config wird neu angelegt."
    ;;
esac

if [[ "$EXISTING_ACTIVE_MEMORY_ENTRY" != "null" && -n "$EXISTING_ACTIVE_MEMORY_ENTRY" ]]; then
  info "Bestehende active-memory-Config gefunden."
  prompt_choice ACTIVE_MEMORY_MODE "ActiveMemory-Modus: keep=unverändert übernehmen, reconfigure=neu konfigurieren, disable=nicht anfassen/deaktiviert lassen" "keep" "keep" "reconfigure" "disable"
  if [[ "$ACTIVE_MEMORY_MODE" == "keep" ]]; then
    KEEP_EXISTING_ACTIVE_MEMORY_CONFIG=1
    USE_ACTIVE_MEMORY="y"
  elif [[ "$ACTIVE_MEMORY_MODE" == "reconfigure" ]]; then
    USE_ACTIVE_MEMORY="y"
  fi
else
  prompt_choice ACTIVE_MEMORY_MODE "ActiveMemory installieren? yes=ja, no=nein" "yes" "yes" "no"
  [[ "$ACTIVE_MEMORY_MODE" == "yes" ]] && USE_ACTIVE_MEMORY="y"
fi

EMBEDDING_PROVIDER="openai"
EMBEDDING_BASE_URL=""
EMBEDDING_DIMENSIONS=""
EMBEDDING_LOCAL_MODEL="intfloat/multilingual-e5-small"
EMBEDDING_LOCAL_REVISION="614241f622f53c4eeff9890bdc4f31cfecc418b3"
EMBEDDING_LOCAL_QUERY_PREFIX="query: "
EMBEDDING_LOCAL_PASSAGE_PREFIX="passage: "
EMBEDDING_LOCAL_CACHE_DIR="\${OPENCLAW_HOME}/models/plur1bus"
JINA_LICENSE_ACCEPTED="false"
MODEL_PREPARATION_PROFILE=""
RERANKER_PROVIDER="cohere"
RERANKER_MODEL="rerank-v3.5"
RERANKER_LOCAL_MODEL="woxpas-ai/bge-reranker-v2-m3-onnx"
RERANKER_LOCAL_CACHE_DIR="\${OPENCLAW_HOME}/models/plur1bus"

# Provider-Wizard: neue Installationen nutzen scripts/provider-wizard.mjs (Node i18n-konform).
# Das interaktive Bash-Fallback unten bleibt für Kompatibilität aktiv.
# Aufruf via Node: node "$(dirname "$0")/provider-wizard.mjs" > /tmp/wizard-out.json

if [[ "$KEEP_EXISTING_MEMORY_CONFIG" != "1" ]]; then
echo ""
info "Embedding-Provider-Auswahl:"
info "  1) OpenAI text-embedding-3-large — empfohlen, remote, API-Key erforderlich."
info "  2) Local multilingual-e5-small — lokal/privat, kein API-Key, CPU/Download-Hinweis."
info "  3) Local JinaAI jina-embeddings-v3 — mehrsprachig, Matryoshka, optionaler verifizierter ~0,58-GB-Q8-Download."
warn "     Lizenz: CC BY-NC 4.0 — nicht für kommerzielle Nutzung."
info "  4) Custom OpenAI-compatible — OpenRouter, lokales Gateway oder kompatible Provider."
prompt_choice EMBEDDING_PROVIDER_MODE "Embedding provider: openai=empfohlen, local=E5, jina=JinaAI, custom=OpenAI-kompatibel" "openai" "openai" "local" "jina" "custom"

case "$EMBEDDING_PROVIDER_MODE" in
  openai)
    EMBEDDING_PROVIDER="openai"
    OPENAI_KEY="${EMBEDDING_KEY_DEFAULT}"
    prompt_secret OPENAI_KEY "OpenAI API Key" "$OPENAI_KEY"
    EMBEDDING_MODEL="text-embedding-3-large"
    EMBEDDING_DIMENSIONS=3072
    ;;
  local)
    EMBEDDING_PROVIDER="local-transformers"
    EMBEDDING_LOCAL_MODEL="intfloat/multilingual-e5-small"
    EMBEDDING_LOCAL_REVISION="614241f622f53c4eeff9890bdc4f31cfecc418b3"
    EMBEDDING_LOCAL_QUERY_PREFIX="query: "
    EMBEDDING_LOCAL_PASSAGE_PREFIX="passage: "
    EMBEDDING_MODEL="$EMBEDDING_LOCAL_MODEL"
    EMBEDDING_DIMENSIONS=384
    info "Lokaler Provider nutzt $EMBEDDING_MODEL (384d) mit query/passage Prefixing."
    info "Erster echter Local-Smoke/Call lädt das Modell nach $EMBEDDING_LOCAL_CACHE_DIR."
    ;;
  jina)
    if ! confirm "CC BY-NC 4.0 für JinaAI jina-embeddings-v3 ausdrücklich akzeptieren?" "n"; then
      error "JinaAI jina-embeddings-v3 wird ohne ausdrückliche Zustimmung zur CC BY-NC 4.0 nicht konfiguriert."
      exit 1
    fi
    JINA_LICENSE_ACCEPTED="true"
    MODEL_PREPARATION_PROFILE="jina-v3-multilingual-1024"
    EMBEDDING_PROVIDER="local-transformers"
    EMBEDDING_LOCAL_MODEL="jinaai/jina-embeddings-v3"
    EMBEDDING_LOCAL_REVISION="68ed94909d564380f954be27ae2e133214c1adc9"
    EMBEDDING_LOCAL_QUERY_PREFIX=""
    EMBEDDING_LOCAL_PASSAGE_PREFIX=""
    EMBEDDING_MODEL="$EMBEDDING_LOCAL_MODEL"
    EMBEDDING_DIMENSIONS=1024
    info "Lokaler Provider nutzt $EMBEDDING_MODEL (1024d; Matryoshka: 32/64/128/256/512/768/1024)."
    warn "CC BY-NC 4.0: Diese lokale Modelloption ist nur für nicht-kommerzielle Nutzung vorgesehen."
    info "Der erste echte Aufruf lädt den gepinnten Q8-ONNX-Export nach $EMBEDDING_LOCAL_CACHE_DIR."
    ;;
  custom)
    EMBEDDING_PROVIDER="openai-compatible"
    prompt_secret OPENAI_KEY "Embedding API Key" "$EMBEDDING_KEY_DEFAULT"
    prompt_input EMBEDDING_BASE_URL "Embedding Base-URL" "${EXISTING_EMBEDDING_BASE_URL:-}"
    EMBEDDING_MODEL="$EMBEDDING_MODEL_DEFAULT"
    prompt_input EMBEDDING_MODEL "Embedding-Modell" "$EMBEDDING_MODEL"
    EMBEDDING_DIMENSIONS="${EXISTING_EMBEDDING_DIMS:-}"
    if [[ -z "$EMBEDDING_DIMENSIONS" && "$EMBEDDING_MODEL" == *"text-embedding-3-large"* ]]; then
      EMBEDDING_DIMENSIONS=3072
    elif [[ -z "$EMBEDDING_DIMENSIONS" && ( "$EMBEDDING_MODEL" == *"small"* || "$EMBEDDING_MODEL" == *"ada"* ) ]]; then
      EMBEDDING_DIMENSIONS=1536
    elif [[ -z "$EMBEDDING_DIMENSIONS" ]]; then
      EMBEDDING_DIMENSIONS=1024
    fi
    prompt_input EMBEDDING_DIMENSIONS "Embedding-Dimension (muss zur DB passen)" "$EMBEDDING_DIMENSIONS"
    ;;
esac

echo ""
info "Reranker-Auswahl:"
info "  1) Local BGE reranker-v2-m3 — empfohlen: frei, mehrsprachig, Apache 2.0, verifizierter ~570-MB-ONNX-Download."
info "  2) Cohere rerank — remote, API-Key erforderlich."
info "  3) Disabled — Vector-only Recall."
prompt_choice RERANKER_PROVIDER_MODE "Reranker provider: local=BGE empfohlen, cohere=remote, disabled=aus" "local" "local" "cohere" "disabled"
case "$RERANKER_PROVIDER_MODE" in
  cohere)
    RERANKER_PROVIDER="cohere"
    prompt_secret COHERE_KEY "Cohere API Key" "${EXISTING_COHERE_KEY:-\${COHERE_API_KEY}}"
    RERANKER_MODEL="${EXISTING_RERANKER_MODEL:-rerank-v3.5}"
    prompt_input RERANKER_MODEL "Cohere Rerank-Modell" "$RERANKER_MODEL"
    ;;
  local)
    RERANKER_PROVIDER="local-transformers"
    RERANKER_MODEL="$RERANKER_LOCAL_MODEL"
    info "Lokaler Reranker nutzt den revisions- und hashgeprüften BGE-ONNX-Export."
    ;;
  disabled)
    RERANKER_PROVIDER="disabled"
    ;;
esac

# Embedding-Fallback
echo ""
info "Embedding-Fallback: zweiter OpenAI/OpenAI-kompatibler Endpunkt falls Primary nicht erreichbar."
warn "  ⚠️  Fallback MUSS dasselbe Modell / dieselbe Dimension verwenden — LanceDB hat fixes Schema."
if [[ "$EMBEDDING_PROVIDER" != "local-transformers" ]] && confirm "Embedding-Fallback konfigurieren?" "n"; then
  USE_EMBEDDING_FALLBACK="y"
  prompt_secret EMBEDDING_FALLBACK_KEY     "Fallback API Key" "\${OPENAI_API_KEY_FALLBACK}"
  prompt_input EMBEDDING_FALLBACK_BASEURL "Fallback Base-URL (leer = Provider-Default)" ""
  prompt_input EMBEDDING_FALLBACK_MODEL   "Fallback Modell (leer = wie Primary)" ""
fi

if confirm "LLM-Merging aktivieren? (dedupliziert ähnliche Memories über das effektive OpenClaw-Agentenmodell)" "n"; then
  USE_MERGING="y"
  info "Merging übernimmt die live OpenClaw-Modellauswahl; der Installer persistiert kein Chat-Modell und keine direkte Route."
fi

else
  EMBEDDING_PROVIDER="${EXISTING_EMBEDDING_PROVIDER:-openai-compatible}"
  EMBEDDING_MODEL="${EXISTING_EMBEDDING_MODEL:-}"
  EMBEDDING_DIMENSIONS="${EXISTING_EMBEDDING_DIMS:-3072}"
  EMBEDDING_BASE_URL="${EXISTING_EMBEDDING_BASE_URL:-}"
  RERANKER_PROVIDER="${EXISTING_RERANKER_PROVIDER:-}"
  [[ -z "$RERANKER_PROVIDER" && -n "$EXISTING_COHERE_KEY" ]] && RERANKER_PROVIDER="cohere"
  [[ -z "$RERANKER_PROVIDER" ]] && RERANKER_PROVIDER="disabled"
fi

# v2.1.1: Pre-Flight-Check — vergleiche neue Dim mit bestehenden LanceDBs.
# Verhindert silent Datenkorruption bei Provider-Wechsel.
echo ""
info "Pre-Flight: prüfe bestehende LanceDB-Dimensionen vs. neue Config ($EMBEDDING_DIMENSIONS)…"
TARGET_DB_PATH="$TARGET_DIR/memory/lancedb-namespaced"
EXISTING_DBS=$(run_target "ls -d '$TARGET_DB_PATH'/*/ 2>/dev/null | xargs -n1 basename 2>/dev/null || true" || echo "")
if [[ -n "$EXISTING_DBS" ]]; then
  MISMATCH_COUNT=0
  DIM_CHECK_SKIPPED=0
  while IFS= read -r ag; do
    [[ -z "$ag" ]] && continue
    [[ "$ag" == "defaults" || "$ag" == "list" ]] && continue
    # Schema-Dim per Python aus LanceDB lesen — funktioniert remote nicht direkt, nur lokal
    if [[ "$DRY_RUN" == "1" ]]; then
      DIM_CHECK_SKIPPED=1
      dryrun "Dry-run: LanceDB-Dimensionen wurden nicht live geprüft für Agent '$ag'"
      continue
    fi
    if [[ "$IS_REMOTE" == "1" ]]; then
      DIM_CHECK_SKIPPED=1
      warn "Remote-Ziel: LanceDB-Dimension für Agent '$ag' wurde nicht live geprüft."
      continue
    fi
    DB_DIM=$(timeout 10s python3 -c "
import sys
try:
  sys.path.insert(0, '$SOURCE_DIR/extensions/memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/python')
except: pass
try:
  import lancedb
  db = lancedb.connect('$TARGET_DB_PATH/$ag')
  if 'memories' in db.table_names():
    tbl = db.open_table('memories')
    for f in tbl.schema:
      if f.name == 'vector':
        print(str(f.type).split('<')[1].split('>')[0].split(',')[0].strip())
        break
except: pass
" 2>/dev/null || echo "")
    if [[ -n "$DB_DIM" && "$DB_DIM" != "$EMBEDDING_DIMENSIONS" ]]; then
      warn "  Agent '$ag': bestehende DB hat ${DB_DIM} dims, neue Config will $EMBEDDING_DIMENSIONS"
      MISMATCH_COUNT=$((MISMATCH_COUNT + 1))
    fi
  done <<< "$EXISTING_DBS"

  if [[ "$MISMATCH_COUNT" -gt 0 ]]; then
    warn ""
    warn "⚠ $MISMATCH_COUNT Agent-DB(s) haben andere Dimension als die neue Config."
    warn "   Speichern wird brechen, Recall wird brechen."
    warn ""
    warn "   Optionen:"
    warn "   1. Wechsel rückgängig (auf altes Modell zurück)"
    warn "   2. Fresh DBs: rm -r $TARGET_DB_PATH/<agent>/  → Dreaming/Migrate füllen sie wieder"
    warn ""
    if ! confirm "Trotzdem fortfahren?" "n"; then
      error "Abgebrochen wegen Dim-Mismatch."
      exit 1
    fi
  elif [[ "$DIM_CHECK_SKIPPED" -gt 0 ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      warn "Dry-run: LanceDB-Dimensionen wurden nicht live geprüft; keine Kompatibilitätszusage."
    else
      warn "Remote-Ziel: LanceDB-Dimensionen wurden nicht live geprüft; keine Kompatibilitätszusage."
    fi
  else
    ok "Alle bestehenden DBs sind kompatibel."
  fi
else
  info "Keine bestehenden DBs gefunden — Fresh-Install."
fi

# ─── Schritt 2: Agenten ermitteln ─────────────────────────────────────────────

step "Schritt 2: Agenten ermitteln"

AGENTS_JSON=$(run_target "jq -r 'if (.agents.list? | type) == \"array\" then .agents.list[]?.id else (.agents | keys[] | select(. != \"defaults\" and . != \"list\")) end' '$TARGET_CONFIG' 2>/dev/null || echo ''")
AGENT_LIST=()
while IFS= read -r agent; do
  [[ -n "$agent" ]] && AGENT_LIST+=("$agent")
done <<< "$AGENTS_JSON"

if [[ ${#AGENT_LIST[@]} -eq 0 ]]; then
  warn "Keine Agenten in openclaw.json gefunden. Nur Main-Agent wird angenommen."
  AGENT_LIST=("main")
fi

info "Gefundene Agenten: ${AGENT_LIST[*]}"

# Workspace-Pfade ermitteln
declare -A WORKSPACE_MAP
for agent in "${AGENT_LIST[@]}"; do
  ws=$(run_target "jq -r --arg agent '$agent' 'if (.agents.list? | type) == \"array\" then (.agents.list[]? | select(.id == \$agent) | .workspace // empty) else (.agents[\$agent].workspace // empty) end' '$TARGET_CONFIG' 2>/dev/null || echo ''")
  if [[ -z "$ws" || "$ws" == "null" ]]; then
    ws="$TARGET_DIR/workspace"
    [[ "$agent" != "main" ]] && ws="${ws}-${agent}"
  fi
  WORKSPACE_MAP["$agent"]="$ws"
  info "  $agent → $ws"
done

# ─── Schritt 2b: Snapshot erstellen ──────────────────────────────────────────

step "Schritt 2b: LanceDB-Snapshot"

SNAPSHOT_DIR="$TARGET_DIR/memory/.snapshots"
SNAP_FILE="$SNAPSHOT_DIR/lancedb-$(date +%Y%m%d-%H%M%S).tar.gz"
LANCEDB_DIR="$TARGET_DIR/memory/lancedb-namespaced"

LANCEDB_EXISTS=$(run_target "test -d '$LANCEDB_DIR' && echo yes || echo no" 2>/dev/null)

if [[ "$LANCEDB_EXISTS" == "yes" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "mkdir -p '$SNAPSHOT_DIR' && tar -czf '$SNAP_FILE' -C '$TARGET_DIR/memory' lancedb-namespaced"
  else
    run_target "mkdir -p '$SNAPSHOT_DIR'"
    run_target "tar -czf '$SNAP_FILE' -C '$TARGET_DIR/memory' lancedb-namespaced"
    ok "Snapshot erstellt: $SNAP_FILE"
    # Alte Snapshots aufräumen — max. 5 behalten
    run_target "ls -t '$SNAPSHOT_DIR'/*.tar.gz 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true"
  fi
else
  info "Keine bestehende LanceDB gefunden — kein Snapshot nötig (Erstinstallation)."
fi

# ─── Schritt 3: Plugins kopieren ──────────────────────────────────────────────

step "Schritt 3: Plugins kopieren"

EXTENSIONS_DIR="$TARGET_DIR/extensions"

if [[ "$DRY_RUN" == "0" ]]; then
  run_target "mkdir -p '$EXTENSIONS_DIR'"
fi

info "Kopiere memory-lancedb-namespaced..."
copy_to_target "$PLUGIN_SRC" "$EXTENSIONS_DIR/"

info "Kopiere memory-lancedb-stock (LanceDB node_modules)..."
copy_to_target "$STOCK_SRC" "$EXTENSIONS_DIR/"

if [[ "$DRY_RUN" == "1" ]]; then
  dryrun "Würde Plugins nach $EXTENSIONS_DIR kopieren"
else
  ok "Plugins kopiert nach $EXTENSIONS_DIR"
fi

# ─── Schritt 3b: Feature-Cron-Plan (Vorschau) ─────────────────────────────────
# Nur advisory: der Gateway läuft an dieser Stelle noch mit der alten Config
# (Neustart folgt erst in Schritt 10), daher hier ausschließlich --dry-run.
# setup-feature-crons.mjs selbst ist best-effort (exit 0 immer) — schlägt
# also nie den Installer fehl, egal ob openclaw/Gateway erreichbar sind.

step "Schritt 3b: Feature-Cron-Plan (Vorschau)"

FEATURE_CRON_SCRIPT="$EXTENSIONS_DIR/memory-lancedb-namespaced/scripts/setup-feature-crons.mjs"

if [[ "$DRY_RUN" == "1" ]]; then
  dryrun "Würde Feature-Cron-Plan anzeigen: node '$FEATURE_CRON_SCRIPT' --dry-run"
else
  if run_target "test -f '$FEATURE_CRON_SCRIPT'"; then
    run_target "node '$FEATURE_CRON_SCRIPT' --dry-run" || true
    info "Hinweis: Nach dem Gateway-Neustart aktivieren mit:"
    info "  node '$FEATURE_CRON_SCRIPT'  (oder: /plur1bus setup crons)"
  else
    info "setup-feature-crons.mjs nicht im kopierten Plugin gefunden — übersprungen (nicht kritisch)."
  fi
fi

# ─── Schritt 4: openclaw.json patchen ─────────────────────────────────────────

step "Schritt 4: openclaw.json patchen"

if [[ "$KEEP_EXISTING_MEMORY_CONFIG" == "1" ]]; then
  PLUGIN_CONFIG="$EXISTING_PLUGIN_ENTRY"
else
  # Reranker-Block aufbauen
  case "$RERANKER_PROVIDER" in
    cohere)
      if [[ -n "$COHERE_KEY" && "$COHERE_KEY" != "" ]]; then
        RERANKER_BLOCK=$(jq -n \
          --arg key "$COHERE_KEY" \
          --arg model "${RERANKER_MODEL:-rerank-v3.5}" \
          '{"provider": "cohere", "enabled": true, "apiKey": $key, "model": $model, "candidates": 20}')
      else
        RERANKER_BLOCK='{"provider": "disabled", "enabled": false}'
      fi
      ;;
    local-transformers)
      RERANKER_BLOCK=$(jq -n \
        --arg model "$RERANKER_LOCAL_MODEL" \
        --arg cacheDir "$RERANKER_LOCAL_CACHE_DIR" \
        '{"provider": "local-transformers", "enabled": true, "local": {"model": $model, "cacheDir": $cacheDir}, "candidates": 20}')
      ;;
    *)
      RERANKER_BLOCK='{"provider": "disabled", "enabled": false}'
      ;;
  esac

  # Merging-Block aufbauen
  if [[ "$USE_MERGING" == "y" ]]; then
    MERGING_BLOCK='{"enabled": true, "threshold": 0.70}'
    SCHICHT15_BLOCK='{"enabled": true, "minImportance": 0.7}'
  else
    MERGING_BLOCK='{"enabled": false}'
    SCHICHT15_BLOCK='{"enabled": false}'
  fi

  # Embedding Fallback Block
  if [[ "$USE_EMBEDDING_FALLBACK" == "y" ]]; then
    EMBEDDING_FALLBACK_BLOCK=$(jq -n \
      --arg key "$EMBEDDING_FALLBACK_KEY" \
      --arg baseUrl "$EMBEDDING_FALLBACK_BASEURL" \
      --arg model "$EMBEDDING_FALLBACK_MODEL" \
      '{
        "apiKey": (if $key == "" then null else $key end),
        "baseUrl": (if $baseUrl == "" then null else $baseUrl end),
        "model":   (if $model   == "" then null else $model   end)
      } | with_entries(select(.value != null))')
  else
    EMBEDDING_FALLBACK_BLOCK='null'
  fi

  # --- Obsidian-Vault einrichten -------------------------------------------
  # Bis 7.5.0 zeigte obsidianBridge.workspaces auf die Agenten-Workspaces, die
  # keine Vaults sind. requireVaultPathConfirmation blieb damit dauerhaft
  # unerfüllt und jede Installation stand auf "PENDING SETUP", ohne dass es
  # einen Weg gab, das abzuschliessen. Jetzt wird der Vault hier geklaert.
  OBSIDIAN_VAULT_PATH=""
  OBSIDIAN_BRIDGE_ENABLED="true"
  declare -a FOUND_VAULTS=()
  for probe_root in "$HOME/Documents" "$HOME/Obsidian" "$HOME"; do
    [[ -d "$probe_root" ]] || continue
    while IFS= read -r marker; do
      [[ -n "$marker" ]] || continue
      FOUND_VAULTS+=("$(dirname "$(dirname "$marker")")")
    done < <(find "$probe_root" -maxdepth 3 -type f \
      \( -name app.json -o -name workspace.json \) -path '*/.obsidian/*' 2>/dev/null | head -20)
  done
  # Duplikate entfernen, Reihenfolge erhalten
  if ((${#FOUND_VAULTS[@]} > 0)); then
    mapfile -t FOUND_VAULTS < <(printf '%s\n' "${FOUND_VAULTS[@]}" | awk '!seen[$0]++')
  fi

  if ((${#FOUND_VAULTS[@]} > 0)); then
    info "Obsidian erkannt. Gefundene Vaults:"
    for idx in "${!FOUND_VAULTS[@]}"; do
      printf '    [%d] %s\n' "$((idx + 1))" "${FOUND_VAULTS[$idx]}"
    done
    prompt_choice OBSIDIAN_VAULT_MODE \
      "Obsidian-Vault: existing=vorhandenen nutzen, new=neuen anlegen, skip=Bridge aus" \
      "existing" "existing" "new" "skip"
  else
    info "Kein Obsidian-Vault gefunden."
    prompt_choice OBSIDIAN_VAULT_MODE \
      "Obsidian-Vault: new=neuen anlegen, skip=Bridge aus" \
      "new" "new" "skip"
  fi

  case "$OBSIDIAN_VAULT_MODE" in
    existing)
      if ((${#FOUND_VAULTS[@]} == 1)); then
        OBSIDIAN_VAULT_PATH="${FOUND_VAULTS[0]}"
      else
        prompt_input OBSIDIAN_VAULT_PATH "Pfad des zu nutzenden Vaults" "${FOUND_VAULTS[0]}"
      fi
      ;;
    new)
      prompt_input OBSIDIAN_VAULT_PATH "Pfad fuer den neuen Vault" "$HOME/Documents/PLUR1BUS"
      if [[ -n "$OBSIDIAN_VAULT_PATH" ]]; then
        mkdir -p "$OBSIDIAN_VAULT_PATH/.obsidian"
        if [[ ! -f "$OBSIDIAN_VAULT_PATH/.obsidian/app.json" ]]; then
          printf '{\n  "attachmentFolderPath": "attachments"\n}\n' \
            > "$OBSIDIAN_VAULT_PATH/.obsidian/app.json"
        fi
        info "Vault angelegt: $OBSIDIAN_VAULT_PATH"
      fi
      ;;
    skip)
      OBSIDIAN_BRIDGE_ENABLED="false"
      info "Obsidian-Bridge bleibt ausgeschaltet."
      ;;
  esac

  if [[ "$OBSIDIAN_BRIDGE_ENABLED" == "true" && -n "$OBSIDIAN_VAULT_PATH" ]]; then
    info "Vault bestaetigen nach dem Start:"
    info "  plur1bus-obsidian use --session <key> --path $OBSIDIAN_VAULT_PATH"
    info "  plur1bus-obsidian confirm --session <key> --path $OBSIDIAN_VAULT_PATH --token <token>"
  fi

  # Workspaces-Array für obsidianBridge bauen: der gewaehlte Vault, sonst leer
  OBSIDIAN_WORKSPACES_JSON="["
  first_ws=1
  for agent in "${AGENT_LIST[@]}"; do
    # Der Bridge spiegelt in den Vault, nicht in den Agenten-Workspace. Ohne
    # gewaehlten Vault bleibt die Liste leer und die Bridge damit inaktiv.
    [[ -n "$OBSIDIAN_VAULT_PATH" ]] || continue
    [[ "$first_ws" -eq 0 ]] && OBSIDIAN_WORKSPACES_JSON+=","
    OBSIDIAN_WORKSPACES_JSON+=$(jq -n --arg id "$agent" --arg path "$OBSIDIAN_VAULT_PATH" \
      '{"workspaceId": $id, "agentId": $id, "path": $path}')
    first_ws=0
  done
  OBSIDIAN_WORKSPACES_JSON+="]"

  if [[ "$JINA_LICENSE_ACCEPTED" == "true" ]]; then
    MODEL_PREPARATION_BLOCK=$(jq -n \
      --arg profile "$MODEL_PREPARATION_PROFILE" \
      '{"profile": $profile, "acceptNonCommercialLicense": true}')
  else
    MODEL_PREPARATION_BLOCK='null'
  fi

  # Plugin-Config-Objekt
  PLUGIN_CONFIG=$(jq -n \
    --arg embedding_provider "$EMBEDDING_PROVIDER" \
    --arg openai_key "$OPENAI_KEY" \
    --arg embedding_model "$EMBEDDING_MODEL" \
    --arg embedding_base_url "${EMBEDDING_BASE_URL:-}" \
    --argjson embedding_dims "${EMBEDDING_DIMENSIONS:-3072}" \
    --arg embedding_local_model "$EMBEDDING_LOCAL_MODEL" \
    --arg embedding_local_revision "$EMBEDDING_LOCAL_REVISION" \
    --arg embedding_local_query_prefix "$EMBEDDING_LOCAL_QUERY_PREFIX" \
    --arg embedding_local_passage_prefix "$EMBEDDING_LOCAL_PASSAGE_PREFIX" \
    --arg embedding_local_cache_dir "$EMBEDDING_LOCAL_CACHE_DIR" \
    --arg db_path "${EXISTING_BASE_DB_PATH:-$TARGET_DIR/memory/lancedb-namespaced}" \
    --argjson obsidian_workspaces "$OBSIDIAN_WORKSPACES_JSON" \
    --argjson obsidian_enabled "$OBSIDIAN_BRIDGE_ENABLED" \
    --argjson reranker "$RERANKER_BLOCK" \
    --argjson merging "$MERGING_BLOCK" \
    --argjson schicht15 "$SCHICHT15_BLOCK" \
    --argjson embedding_fallback "$EMBEDDING_FALLBACK_BLOCK" \
    --argjson model_preparation "$MODEL_PREPARATION_BLOCK" \
    '{
      "enabled": true,
      "config": ({
        "embedding": (
          if $embedding_provider == "local-transformers" then
            {
              "provider": "local-transformers",
              "local": {
                "model": $embedding_local_model,
                "revision": $embedding_local_revision,
                "dimensions": $embedding_dims,
                "queryPrefix": $embedding_local_query_prefix,
                "passagePrefix": $embedding_local_passage_prefix,
                "cacheDir": $embedding_local_cache_dir
              }
            }
          else
            {
              "provider": $embedding_provider,
              "apiKey": $openai_key,
              "model": $embedding_model,
              "dimensions": $embedding_dims
            }
          end
          | if $embedding_base_url != "" then . + {"baseUrl": $embedding_base_url} else . end
          | if $embedding_fallback != null then . + {"fallback": $embedding_fallback} else . end
        ),
        "baseDbPath": $db_path,
        "autoCapture": true,
        "autoRecall": true,
        "captureMaxChars": 15000,
        "summaryMaxWords": 150,
        "recallMinScore": 0.15,
        "autoRecallMinScore": 0.20,
        "duplicateThreshold": 0.95,
        "forgetThreshold": 0.30,
        "gc": {"enabled": true},
        "recall": {
          "importanceBoost": 0.3,
          "dedup": true,
          "dedupJaccard": 0.6,
          "canonicalFirst": true,
          "canonicalMinScore": 0.30,
          "canonicalMaxItems": 2
        },
        "reranker": $reranker,
        "merging": $merging,
        "schicht15": $schicht15,
        "obsidianBridge": {
          "enabled": $obsidian_enabled,
          "watch": false,
          "mode": "augment",
          "dryRun": true,
          "requireVaultPathConfirmation": true,
          "autoApplyLowRisk": false,
          "workspaces": $obsidian_workspaces,
          "graphLinks": {
            "semanticDiscovery": {
              "enabled": true,
              "maxPerRun": 500,
              "threshold": 0.78
            }
          }
        }
      } | if $model_preparation == null then . else . + {"modelPreparation": $model_preparation} end)
    }')
fi

PLUGIN_POLICY_INPUT=$(jq -n \
  --argjson pluginEntry "$PLUGIN_CONFIG" \
  --arg mode "$FEATURE_POLICY_MODE" \
  '{pluginEntry: $pluginEntry, mode: $mode}')
PLUGIN_CONFIG=$(PLUR1BUS_INSTALLER_INPUT="$PLUGIN_POLICY_INPUT" node "$INSTALLER_CONFIG_HELPER" complete-plugin-entry)
eval "$(printf '%s' "$PLUGIN_CONFIG" | jq -r '@sh "FINAL_MERGING_ENABLED=\(.config.merging.enabled // false)"')"

FINAL_FEATURE_PLAN_INPUT=$(jq -n \
  --argjson existing "$EXISTING_PLUGIN_ENTRY" \
  --argjson pluginEntry "$PLUGIN_CONFIG" \
  --arg log "$INSTALL_LOG_CONTENT" \
  --arg mode "$FEATURE_POLICY_MODE" \
  '{
    existingPluginEntry: (if $existing == null then null else $existing end),
    existingPluginConfig: (if $existing == null then {} else ($existing.config // {}) end),
    proposedPluginConfig: ($pluginEntry.config // {}),
    installLogContent: $log,
    mode: $mode
  }')
FEATURE_UPDATE_PLAN=$(PLUR1BUS_INSTALLER_INPUT="$FINAL_FEATURE_PLAN_INPUT" node "$INSTALLER_CONFIG_HELPER" feature-plan)

# jq-Patch-Script (wird remote oder lokal ausgeführt)
JQ_PATCH=$(cat <<'JQEOF'
# Plugin-Entry + Allow-Eintrag + Slots
.plugins.allow = ((.plugins.allow // []) | if index("memory-lancedb-namespaced") then . else . + ["memory-lancedb-namespaced"] end)
| .plugins.slots.memory = (.plugins.slots.memory // "memory-core")
| .plugins.entries["memory-lancedb-namespaced"] = $plugin_config
JQEOF
)

if [[ "$DRY_RUN" == "1" ]]; then
  dryrun "Würde openclaw.json mit Plugin-Config patchen"
  dryrun "  - plugins.allow += memory-lancedb-namespaced"
  dryrun "  - plugins.slots.memory bleibt '${EXISTING_MEMORY_SLOT:-memory-core}'"
  dryrun "  - kein Backend-Wechsel: bestehende Legacy-Backends bleiben unverändert"
  dryrun "  - hooks.allowConversationAccess=true wird verbindlich sichergestellt; sonstige explizite Hooks bleiben erhalten"
  if [[ "$KEEP_EXISTING_MEMORY_CONFIG" == "1" ]]; then
    dryrun "  - plugins.entries.memory-lancedb-namespaced bleibt inhaltlich erhalten"
  else
    dryrun "  - plugins.entries.memory-lancedb-namespaced wird aus User-Auswahl neu geschrieben"
  fi
else
  # Backup erstellen
  run_target "cp '$TARGET_CONFIG' '${TARGET_CONFIG}.bak.$(date +%Y%m%d-%H%M%S)'"
  info "Backup erstellt: ${TARGET_CONFIG}.bak.*"

  # Config patchen (lokal: via jq + tmpfile, remote: via node inline)
  if [[ "$IS_REMOTE" == "1" ]]; then
    # Remote: Sende Plugin-Config als JSON, wende Patch via node.js an
    PLUGIN_CONFIG_ESCAPED=$(echo "$PLUGIN_CONFIG" | jq -c .)
    ssh "$SSH_HOST" node --input-type=module << NODEOF
import { readFileSync, writeFileSync } from 'fs';
const cfg = JSON.parse(readFileSync('${TARGET_CONFIG}', 'utf8'));
const plugin = ${PLUGIN_CONFIG_ESCAPED};
cfg.plugins = cfg.plugins || {};
cfg.plugins.allow = cfg.plugins.allow || [];
if (!cfg.plugins.allow.includes('memory-lancedb-namespaced'))
  cfg.plugins.allow.push('memory-lancedb-namespaced');
cfg.plugins.slots = cfg.plugins.slots || {};
cfg.plugins.slots.memory = cfg.plugins.slots.memory || 'memory-core';
cfg.plugins.entries = cfg.plugins.entries || {};
cfg.plugins.entries['memory-lancedb-namespaced'] = plugin;
writeFileSync('${TARGET_CONFIG}', JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('patched');
NODEOF
  else
    # Lokal: via jq
    TMPFILE=$(mktemp)
    jq --argjson plugin_config "$PLUGIN_CONFIG" \
      "$JQ_PATCH" \
      "$TARGET_CONFIG" > "$TMPFILE" && mv "$TMPFILE" "$TARGET_CONFIG"
  fi
  ok "openclaw.json gepatcht"
fi

# ─── Schritt 4b: ActiveMemory-Plugin konfigurieren ────────────────────────────

if [[ "$USE_ACTIVE_MEMORY" == "y" ]]; then
  step "Schritt 4b: ActiveMemory-Plugin"

  if [[ "$KEEP_EXISTING_ACTIVE_MEMORY_CONFIG" == "1" ]]; then
    ACTIVE_MEMORY_CONFIG="$EXISTING_ACTIVE_MEMORY_ENTRY"
  else
    ACTIVE_MEMORY_MODEL="${DEFAULT_CHAT_MODEL:-}"
    ACTIVE_MEMORY_FALLBACK="${DEFAULT_CHAT_FALLBACK:-}"
    prompt_input ACTIVE_MEMORY_MODEL "ActiveMemory Modell (leer = OpenClaw default)" "$ACTIVE_MEMORY_MODEL"
    prompt_input ACTIVE_MEMORY_FALLBACK "ActiveMemory Fallback-Modell (leer = keiner)" "$ACTIVE_MEMORY_FALLBACK"

    AGENTS_JSON_ARR=$(printf '"%s",' "${AGENT_LIST[@]}" | sed 's/,$//')
    ACTIVE_MEMORY_CONFIG=$(jq -n \
      --argjson agents "[$AGENTS_JSON_ARR]" \
      --arg model "$ACTIVE_MEMORY_MODEL" \
      --arg fallback "$ACTIVE_MEMORY_FALLBACK" \
      '{
        "enabled": true,
        "config": {
          "enabled": true,
          "agents": $agents,
          "allowedChatTypes": ["direct"],
          "queryMode": "recent",
          "promptStyle": "balanced",
          "timeoutMs": 20000,
          "maxSummaryChars": 220,
          "persistTranscripts": false,
          "logging": true
        }
      }
      | if $model != "" then .config.model = $model else . end
      | if $fallback != "" then .config.modelFallback = $fallback else . end')
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ "$KEEP_EXISTING_ACTIVE_MEMORY_CONFIG" == "1" ]]; then
      dryrun "Würde bestehende active-memory Config unverändert übernehmen"
    else
      dryrun "Würde active-memory aus User-Auswahl konfigurieren"
    fi
  else
    if [[ "$IS_REMOTE" == "1" ]]; then
      ACTIVE_MEMORY_ESCAPED=$(echo "$ACTIVE_MEMORY_CONFIG" | jq -c .)
      ssh "$SSH_HOST" node --input-type=module << NODEOF2
import { readFileSync, writeFileSync } from 'fs';
const cfg = JSON.parse(readFileSync('${TARGET_CONFIG}', 'utf8'));
const am = ${ACTIVE_MEMORY_ESCAPED};
cfg.plugins = cfg.plugins || {};
cfg.plugins.allow = cfg.plugins.allow || [];
if (!cfg.plugins.allow.includes('active-memory'))
  cfg.plugins.allow.push('active-memory');
cfg.plugins.entries = cfg.plugins.entries || {};
cfg.plugins.entries['active-memory'] = am;
writeFileSync('${TARGET_CONFIG}', JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('active-memory patched');
NODEOF2
    else
      TMPFILE=$(mktemp)
      jq --argjson am "$ACTIVE_MEMORY_CONFIG" \
        '.plugins.allow = ((.plugins.allow // []) | if index("active-memory") then . else . + ["active-memory"] end)
         | .plugins.entries["active-memory"] = $am' \
        "$TARGET_CONFIG" > "$TMPFILE" && mv "$TMPFILE" "$TARGET_CONFIG"
    fi
    ok "ActiveMemory-Plugin konfiguriert (${#AGENT_LIST[@]} Agenten)"
    info "  queryMode=recent, promptStyle=balanced, timeout=20s, maxSummaryChars=220"
  fi
else
  info "ActiveMemory übersprungen (nicht aktiviert oder OpenClaw < 4.10)"
fi

# ─── Schritt 5: Speicherverzeichnisse anlegen ──────────────────────────────────

step "Schritt 5: Verzeichnisse anlegen"

if [[ "$DRY_RUN" == "0" ]]; then
  run_target "mkdir -p '$TARGET_DIR/memory/lancedb-namespaced'"
  for agent in "${AGENT_LIST[@]}"; do
    run_target "mkdir -p '$TARGET_DIR/memory/lancedb-namespaced/$agent'"
    run_target "mkdir -p '${WORKSPACE_MAP[$agent]}/memory'"
    run_target "mkdir -p '${WORKSPACE_MAP[$agent]}/.adaptive-learning'"
    ok "Verzeichnisse für Agent '$agent' angelegt"
  done
else
  dryrun "Würde Verzeichnisse anlegen für: ${AGENT_LIST[*]}"
fi

# ─── Schritt 6: memory-gc.mjs kopieren; Legacy-Cron nur explizit ─────────────

step "Schritt 6: TTL-GC-Script installieren"

TARGET_GC_SCRIPT="$TARGET_DIR/scripts/memory-gc.mjs"
MAINTAIN_SRC="$SOURCE_DIR/scripts/maintain-knowledge-md.mjs"
TARGET_MAINTAIN_SCRIPT="$TARGET_DIR/scripts/maintain-knowledge-md.mjs"

# GC-Script mit angepassten Pfaden erstellen
GC_CONTENT=$(cat << GCEOF
#!/usr/bin/env node
// memory-gc.mjs — Purges expired LanceDB memories for all agents.
// Run daily via system cron: 0 3 * * * root /usr/bin/node ${TARGET_GC_SCRIPT} >> /tmp/openclaw/memory-gc.log 2>&1

import { connect } from "${TARGET_DIR}/extensions/memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js";

const BASE = "${TARGET_DIR}/memory/lancedb-namespaced";
const AGENTS = [$(printf '"%s",' "${AGENT_LIST[@]}" | sed 's/,$//')]
const TABLE = "memories";

const now = Date.now();
let totalPurged = 0;

console.log(\`[memory-gc] \${new Date().toISOString()} — start\`);

for (const agentId of AGENTS) {
  try {
    const db = await connect(\`\${BASE}/\${agentId}\`);
    const tableNames = await db.tableNames();
    if (!tableNames.includes(TABLE)) {
      console.log(\`[memory-gc] \${agentId}: table not found, skipping\`);
      continue;
    }
    const table = await db.openTable(TABLE);
    const before = await table.countRows();
    await table.delete(\`expiresAt > 0 AND expiresAt < \${now}\`);
    const after = await table.countRows();
    const purged = before - after;
    console.log(\`[memory-gc] \${agentId}: \${purged} purged (\${after} remaining)\`);
    totalPurged += purged;
  } catch (e) {
    console.error(\`[memory-gc] \${agentId}: failed — \${e.message}\`);
  }
}

console.log(\`[memory-gc] done. total purged: \${totalPurged}\`);
GCEOF
)

if [[ "$DRY_RUN" == "0" ]]; then
  run_target "mkdir -p '$TARGET_DIR/scripts'"
  write_target_file "$TARGET_GC_SCRIPT" "$GC_CONTENT"
  run_target "chmod +x '$TARGET_GC_SCRIPT'"
  ok "memory-gc.mjs erstellt: $TARGET_GC_SCRIPT"
else
  dryrun "Würde $TARGET_GC_SCRIPT erstellen"
fi

# Cron-Eintrag — Legacy User-Crontab. Im v4-Normalbetrieb übernehmen
# OpenClaw-managed Agent-Crons/Plugin-Services die Wartung.
CRON_LINE="0 3 * * * /usr/bin/node $TARGET_GC_SCRIPT >> /tmp/openclaw/memory-gc.log 2>&1"

if [[ "$LEGACY_HOST_CRON" != "1" ]]; then
  info "Legacy-User-Crontab wird nicht eingerichtet. OpenClaw-managed Crons/Plugin-Services bleiben Primärpfad."
  info "Bei Bedarf explizit erneut mit --legacy-host-cron ausführen."
elif [[ "$DRY_RUN" == "1" ]]; then
  dryrun "Würde zu User-Crontab hinzufügen: $CRON_LINE"
else
  CRON_CHECK=$(run_target "(crontab -l 2>/dev/null || true) | grep -q 'memory-gc' && echo found || echo missing")
  if [[ "$CRON_CHECK" == "found" ]]; then
    warn "Cron-Eintrag 'memory-gc' in User-Crontab bereits vorhanden — übersprungen."
  else
    if run_target "(crontab -l 2>/dev/null || true; echo '$CRON_LINE') | crontab -" 2>/dev/null; then
      ok "Cron-Eintrag in User-Crontab eingetragen (täglich 03:00)"
    else
      warn "Konnte User-Crontab nicht schreiben."
      warn "Manuell eintragen: $CRON_LINE"
    fi
  fi
fi

# ─── Schritt 6b: KNOWLEDGE.md-Maintainer kopieren ────────────────────────────

step "Schritt 6b: KNOWLEDGE.md-Maintainer installieren"

if [[ -f "$MAINTAIN_SRC" ]]; then
  if [[ "$DRY_RUN" == "0" ]]; then
    run_target "mkdir -p '$TARGET_DIR/scripts'"
    copy_to_target "$MAINTAIN_SRC" "$TARGET_DIR/scripts/"
    run_target "chmod +x '$TARGET_MAINTAIN_SCRIPT'"
    ok "maintain-knowledge-md.mjs installiert: $TARGET_MAINTAIN_SCRIPT"
  else
    dryrun "Würde $MAINTAIN_SRC nach $TARGET_MAINTAIN_SCRIPT kopieren"
  fi
else
  warn "maintain-knowledge-md.mjs nicht gefunden in $SOURCE_DIR/scripts — übersprungen"
fi

# ─── Schritt 7: Dokumentation kopieren ────────────────────────────────────────

step "Schritt 7: Dokumentation kopieren"

for doc in "${DOC_FILES[@]}"; do
  src_doc="$SOURCE_DIR/$doc"
  if [[ -f "$src_doc" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      dryrun "Würde kopieren: $doc → $TARGET_DIR/$doc"
    else
      if [[ "$IS_REMOTE" == "1" ]]; then
        scp "$src_doc" "${SSH_HOST}:${TARGET_DIR}/$doc"
      else
        cp "$src_doc" "$TARGET_DIR/$doc"
      fi
      ok "Kopiert: $doc → $TARGET_DIR/$doc"
    fi
  else
    warn "$doc nicht gefunden in $SOURCE_DIR — übersprungen"
  fi
done

# ─── Schritt 8: SOUL.md — Conflict-Log-Sektion ────────────────────────────────

step "Schritt 8: SOUL.md Conflict-Log-Sektion"

SOUL_SECTION=$(cat << 'SOULEOF'

## 🔍 Conflict-Log — Decision-Konflikte

`.adaptive-learning/conflict-log.jsonl` ist ein Audit-Trail für widersprüchliche decision-Memories.
Prüfe in jeder Unterhaltung: wenn du im Kontext eine `<conflict-review-reminder>`-Notiz siehst,
sprich den Nutzer aktiv an: "Ich habe X unaufgelöste Konflikte im Log — willst du die durchgehen?"

**Wichtig:** Rotieren oder löschen ERST nach expliziter Bestätigung.
Unreviewed Konflikte sind nicht abgelaufen — sie warten auf Auflösung.
SOULEOF
)

for agent in "${AGENT_LIST[@]}"; do
  ws="${WORKSPACE_MAP[$agent]}"
  soul_path="$ws/SOUL.md"
  soul_exists=$(run_target "test -f '$soul_path' && echo yes || echo no" 2>/dev/null)

  if [[ "$soul_exists" == "yes" ]]; then
    already=$(run_target "grep -q 'conflict-log' '$soul_path' && echo yes || echo no" 2>/dev/null)
    if [[ "$already" == "yes" ]]; then
      info "SOUL.md von '$agent': Conflict-Log-Sektion bereits vorhanden — übersprungen"
    else
      if [[ "$DRY_RUN" == "1" ]]; then
        dryrun "Würde SOUL.md von '$agent' um Conflict-Log-Sektion ergänzen"
      else
        run_target "echo '$SOUL_SECTION' >> '$soul_path'"
        ok "SOUL.md von '$agent': Conflict-Log-Sektion hinzugefügt"
      fi
    fi
  else
    warn "SOUL.md für Agent '$agent' nicht gefunden ($soul_path) — übersprungen"
  fi
done

# ─── Schritt 8b: AGENTS.md Memory-Tool-Instruktionen ──────────────────────────

step "Schritt 8b: AGENTS.md Memory-Tool-Instruktionen"

for agent in "${AGENT_LIST[@]}"; do
  ws="${WORKSPACE_MAP[$agent]}"
  agents_path="$ws/AGENTS.md"
  agents_exists=$(run_target "test -f '$agents_path' && echo yes || echo no" 2>/dev/null)

  if [[ "$agents_exists" == "yes" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      dryrun "Würde AGENTS.md von '$agent' auf echte Memory-Tool-Nutzung patchen"
      continue
    fi
    before_agents=$(read_target_file "$agents_path")
    after_agents=$(printf '%s' "$before_agents" | node "$AGENTS_PATCHER_HELPER" --stdin)
    if [[ "$after_agents" == "$before_agents" ]]; then
      info "AGENTS.md von '$agent': Memory-Tool-Instruktionen bereits aktuell — übersprungen"
    else
      write_target_file "$agents_path" "$after_agents"
      ok "AGENTS.md von '$agent': Legacy-Pseudo-Tool-Beispiel ersetzt"
    fi
  else
    warn "AGENTS.md für Agent '$agent' nicht gefunden ($agents_path) — übersprungen"
  fi
done

# ─── Schritt 9: Native OpenClaw-Integration ──────────────────────────────────
# Seit 7.5.0 nutzt PLUR1BUS ausschließlich öffentliche Plugin-, Gateway- und
# CLI-Capabilities. Der Installer verändert weder OpenClaw-Dist-Dateien noch
# node_modules. Fehlende Capabilities werden beim Pluginstart fail-closed
# gemeldet; nur die betroffenen Feature-Crons bleiben dann deaktiviert.

step "Schritt 9: Native OpenClaw-Integration"
info "Keine OpenClaw-Host-Patches erforderlich oder zulässig."

# ─── Schritt 9b: KNOWLEDGE.md Bootstrap ──────────────────────────────────────

step "Schritt 9b: KNOWLEDGE.md Bootstrap"

if [[ "$DRY_RUN" == "1" ]]; then
  dryrun "Würde prüfen: node '$TARGET_MAINTAIN_SCRIPT' --check"
  if confirm "  Historischen KNOWLEDGE.md-Backfill starten? (optional; empfohlen erst nach --dry-run Review)" "n"; then
    dryrun "Würde ausführen: node '$TARGET_MAINTAIN_SCRIPT' --backfill --max 100 --batch-size 10"
  else
    info "Historischer Backfill übersprungen. Erst prüfen: node $TARGET_MAINTAIN_SCRIPT --backfill --max 100 --batch-size 10 --dry-run"
    info "Manuell starten: node $TARGET_MAINTAIN_SCRIPT --backfill --max 100 --batch-size 10"
  fi
elif ! run_target "test -f '$TARGET_MAINTAIN_SCRIPT' && echo yes || echo no" 2>/dev/null | grep -q yes; then
  warn "maintain-knowledge-md.mjs nicht gefunden — Bootstrap übersprungen"
else
  PENDING_OUTPUT=$(run_target "node '$TARGET_MAINTAIN_SCRIPT' --check 2>&1" || true)
  HAS_PENDING=$(printf '%s\n' "$PENDING_OUTPUT" | grep -cE "fresh pending: [1-9][0-9]*|historical pending: [1-9][0-9]*" || true)

  if [[ "$HAS_PENDING" -gt 0 ]]; then
    printf '%s\n\n' "$PENDING_OUTPUT"
    warn "Historischer Backfill kann bestehende KNOWLEDGE.md-Inhalte per LLM ergänzen/verdichten."
    warn "Empfohlen: zuerst prüfen mit node $TARGET_MAINTAIN_SCRIPT --backfill --max 100 --batch-size 10 --dry-run"
    if confirm "  Historischen KNOWLEDGE.md-Backfill jetzt starten?" "n"; then
      run_target "node '$TARGET_MAINTAIN_SCRIPT' --backfill --max 100 --batch-size 10"
      ok "KNOWLEDGE.md Bootstrap abgeschlossen"
    else
      info "Historischer Backfill übersprungen."
      info "Manuell starten: node $TARGET_MAINTAIN_SCRIPT --backfill --max 100 --batch-size 10"
    fi
  else
    ok "KNOWLEDGE.md aktuell — kein Backfill nötig"
  fi
fi

# ─── Schritt 9c: KNOWLEDGE.md Fresh-Cron ─────────────────────────────────────

step "Schritt 9c: KNOWLEDGE.md Fresh-Cron"

BACKFILL_CRON="30 4 * * * /usr/bin/node $TARGET_MAINTAIN_SCRIPT --fresh --max 10 >> $TARGET_DIR/logs/knowledge-backfill.log 2>&1"
CRON_MARKER="maintain-knowledge-md"

if [[ "$LEGACY_HOST_CRON" != "1" ]]; then
  info "KNOWLEDGE.md Legacy-User-Crontab wird nicht eingerichtet. Nutze OpenClaw-managed Cron/Service-Jobs oder manuelle Doctor/Backfill-Läufe."
  info "Bei Bedarf explizit erneut mit --legacy-host-cron ausführen."
elif [[ "$DRY_RUN" == "1" ]]; then
  dryrun "Würde Cron einrichten: $BACKFILL_CRON"
else
  run_target "mkdir -p '$TARGET_DIR/logs'"
  CRON_EXISTS=$(run_target "crontab -l 2>/dev/null | grep -c '$CRON_MARKER' || true")
  if [[ "$CRON_EXISTS" -gt 0 ]]; then
    ok "KNOWLEDGE.md Fresh-Cron bereits eingerichtet"
  elif run_target "(crontab -l 2>/dev/null || true; echo '$BACKFILL_CRON') | crontab -" 2>/dev/null; then
    ok "KNOWLEDGE.md Fresh-Cron eingerichtet (täglich 04:30, --fresh --max 10)"
  else
    warn "Cron konnte nicht gesetzt werden. Manuell einrichten: $BACKFILL_CRON"
  fi
fi

# ─── Schritt 9d/9e Helfer: OpenClaw-managed Cron-Jobs in der State-DB ───────
# Zwei Schreibpfade, abhängig von der OpenClaw-Version des Ziels:
#   legacy (<= 2026.7.1): historisches Spalten-Subset, minimales job_json
#   v2     (>= 2026.7.2, auch Betas): STRICT-Schema — kanonisches job_json
#          plus schedule_identity, wie sie der neue Loader/Codec selbst schreibt
# Maßgeblich ist das tatsächliche Schema der Ziel-DB (eine frisch aktualisierte
# CLI kann auf eine noch nicht migrierte DB treffen — die Migration läuft erst
# beim nächsten Gateway-Boot); die CLI-Version dient als Kreuzcheck.

detect_cron_schema() {
  # schedule_identity gab es via ensureColumn schon in 2026.7.1 — das
  # verlässliche v2-Merkmal ist das STRICT-Typing der migrierten Tabelle
  # (plus neue Spalten wie declaration_key).
  local is_strict
  is_strict=$(run_target "sqlite3 '$SQLITE_DB' \"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='cron_jobs' AND sql LIKE '%STRICT%';\" 2>/dev/null" || echo 0)
  if [[ "${is_strict:-0}" -gt 0 ]]; then echo "v2"; else echo "legacy"; fi
}

ensure_openclaw_cron_job() {
  local job_id="$1" job_name="$2" cron_expr="$3" message="$4" timeout_s="$5" sort_order="$6" ok_note="$7"
  local store_key="$TARGET_DIR/cron/jobs.json"

  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "Würde OpenClaw-Cron-Job '$job_name' ($cron_expr, Europe/Berlin) in $SQLITE_DB eintragen"
    return 0
  fi
  if ! run_target "test -f '$SQLITE_DB'" 2>/dev/null; then
    warn "openclaw.sqlite nicht gefunden — nach erstem Gateway-Start erneut ausführen"
    return 0
  fi

  local existing
  existing=$(run_target "sqlite3 '$SQLITE_DB' \"SELECT COUNT(*) FROM cron_jobs WHERE job_id='$job_id';\" 2>/dev/null || echo 0")
  if [[ "${existing:-0}" -gt 0 ]]; then
    ok "Cron-Job '$job_name' bereits vorhanden"
    return 0
  fi

  local schema
  schema=$(detect_cron_schema)
  if [[ "$schema" == "legacy" && -n "$OPENCLAW_VERSION" ]] && version_ge "$OPENCLAW_VERSION" "$STATE_SCHEMA_V2_MIN_VERSION"; then
    warn "OpenClaw $OPENCLAW_VERSION erkannt, aber die State-DB hat noch das Legacy-Schema (Migration ausstehend)."
    warn "Gateway einmal starten (Auto-Migration beim Boot), dann Installer erneut ausführen — '$job_name' wird übersprungen."
    return 0
  fi

  local now_ms now_s next_run
  now_ms=$(python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null || node -e "console.log(Date.now())")
  now_s=$(date +%s)
  next_run=$(python3 -c "
from datetime import datetime, timezone, timedelta
now = datetime.now(timezone.utc)
target = now.replace(hour=0, minute=0, second=0, microsecond=0)
if target <= now: target += timedelta(days=1)
print(int(target.timestamp() * 1000))
" 2>/dev/null || echo "$now_ms")

  local insert_sql
  insert_sql=$(STORE_KEY="$store_key" JOB_ID="$job_id" JOB_NAME="$job_name" CRON_EXPR="$cron_expr" \
    MESSAGE="$message" TIMEOUT_S="$timeout_s" SORT_ORDER="$sort_order" \
    NOW_MS="$now_ms" NOW_S="$now_s" NEXT_RUN="$next_run" SCHEMA="$schema" python3 - <<'PY'
import json, os

env = os.environ
schema = env["SCHEMA"]
schedule = {"kind": "cron", "expr": env["CRON_EXPR"], "tz": "Europe/Berlin"}

def sq(value):
    return "'" + str(value).replace("'", "''") + "'"

columns = [
    ("store_key", sq(env["STORE_KEY"])),
    ("job_id", sq(env["JOB_ID"])),
    ("name", sq(env["JOB_NAME"])),
    ("enabled", "1"),
    ("created_at_ms", env["NOW_MS"]),
    ("schedule_kind", "'cron'"),
    ("schedule_expr", sq(env["CRON_EXPR"])),
    ("schedule_tz", "'Europe/Berlin'"),
    ("agent_id", "'main'"),
    ("session_target", "'isolated'"),
    ("wake_mode", "'now'"),
    ("payload_kind", "'agentTurn'"),
    ("payload_message", sq(env["MESSAGE"])),
    ("payload_model", "NULL"),
    ("payload_thinking", "NULL"),
    ("payload_timeout_seconds", env["TIMEOUT_S"]),
    ("delivery_mode", "'none'"),
    ("failure_alert_disabled", "0"),
    ("next_run_at_ms", env["NEXT_RUN"]),
    ("consecutive_errors", "0"),
    ("consecutive_skipped", "0"),
    ("state_json", "'{}'"),
    ("updated_at", env["NOW_S"]),
    ("sort_order", env["SORT_ORDER"]),
]

if schema == "v2":
    # Kanonisches job_json in der Form, die der 2026.7.2-Codec beim Persistieren
    # selbst erzeugt; schedule_identity im JSON.stringify-Format (kompakt,
    # Key-Reihenfolge version/enabled/schedule), damit gespeicherter Timer-State
    # als gültig erkannt wird statt als Schedule-Änderung.
    job_json = {
        "id": env["JOB_ID"],
        "name": env["JOB_NAME"],
        "enabled": True,
        "createdAtMs": int(env["NOW_MS"]),
        "agentId": "main",
        "schedule": schedule,
        "sessionTarget": "isolated",
        "wakeMode": "now",
        "payload": {"kind": "agentTurn", "message": env["MESSAGE"], "timeoutSeconds": int(env["TIMEOUT_S"])},
        "delivery": {"mode": "none"},
        "state": {},
    }
    identity = {"version": 1, "enabled": True, "schedule": schedule}
    columns.append(("job_json", sq(json.dumps(job_json, separators=(",", ":")))))
    columns.append(("schedule_identity", sq(json.dumps(identity, separators=(",", ":")))))
else:
    job_json = {"name": env["JOB_NAME"], "agentId": "main"}
    columns.append(("job_json", sq(json.dumps(job_json, separators=(",", ":")))))

names = ", ".join(name for name, _ in columns)
values = ", ".join(value for _, value in columns)
print(f"INSERT OR IGNORE INTO cron_jobs ({names}) VALUES ({values});")
PY
)
  if [[ -z "$insert_sql" ]]; then
    warn "Cron-Job '$job_name': SQL konnte nicht erzeugt werden (python3 fehlt?) — übersprungen"
    return 0
  fi

  # Base64 statt Inline-Quoting: das JSON in job_json übersteht so lokale
  # bash -c UND remote ssh-Ausführung unverändert.
  local insert_b64
  insert_b64=$(printf '%s' "$insert_sql" | base64 | tr -d '\n')
  if run_target "printf '%s' '$insert_b64' | base64 -d | sqlite3 '$SQLITE_DB'" 2>/dev/null; then
    ok "Cron-Job '$job_name' eingerichtet ($ok_note; Schema: $schema)"
  else
    warn "Cron-Job '$job_name' konnte nicht angelegt werden — Gateway neu starten und Installer wiederholen"
  fi
}

# ─── Schritt 9d: Semantic-Discovery Cron-Job (OpenClaw-managed, kein Modell) ─

step "Schritt 9d: Semantic-Discovery Cron-Job"

SQLITE_DB="$TARGET_DIR/state/openclaw.sqlite"
ensure_openclaw_cron_job \
  "a1b2c3d4-e5f6-7890-abcd-ef1234567890" "plur1bus-semantic-discover-daily" \
  "0 2 * * *" "/plur1bus internal discover-semantic-links" 300 100 \
  "täglich 02:00 CET, kein Modell-Override"

# ─── Schritt 9e: REM-Dream Cron-Job (OpenClaw-managed) ──────────────────────
# rem-dream schreibt Trend-Reports nach memory/dream-diary/rem/. Ohne diesen
# Job wird der Handler nie aufgerufen — er existiert nur als /plur1bus
# internal Subcommand, ohne Scheduler bleibt dream-diary/rem/ für immer leer.

step "Schritt 9e: REM-Dream Cron-Job"

ensure_openclaw_cron_job \
  "b2c3d4e5-f6a7-4901-bcde-f23456789012" "plur1bus-rem-dream-daily" \
  "15 1 * * *" "/plur1bus internal rem-dream" 600 101 \
  "täglich 01:15 CET, kein Modell-Override"

# ─── Schritt 10: OpenClaw Plugin-Registry aktualisieren ──────────────────────

step "Schritt 10: OpenClaw Plugin-Registry aktualisieren"
refresh_plugin_registry

# ─── Schritt 11: Abschluss ────────────────────────────────────────────────────

echo
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Installation abgeschlossen                              ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo

if [[ "$DRY_RUN" == "1" ]]; then
  warn "DRY-RUN: Keine Änderungen vorgenommen. Erneut ohne --dry-run ausführen."
  exit 0
fi

if [[ "$NON_INTERACTIVE" == "1" ]]; then
  NOTICE_PATH="$TARGET_DIR/state/plur1bus-pending-notice.json"
  NOTICE_TEXT=$'+++ PLUR1BUS — Make your agent yours! +++\n\nPlease complete the installation by running:\n\n/plur1bus start'
  NOTICE_JSON=$(NOTICE_TEXT="$NOTICE_TEXT" node -e 'console.log(JSON.stringify({ kind: "plur1bus_start_notice", text: process.env.NOTICE_TEXT, createdAt: new Date().toISOString(), ttlMs: 604800000 }, null, 2))')
  run_target "mkdir -p '$TARGET_DIR/state'"
  write_target_file "$NOTICE_PATH" "$NOTICE_JSON"
  ok "PLUR1BUS Start Notice bereitgestellt: $NOTICE_PATH"
fi

PACKAGE_VERSION=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('$SOURCE_DIR/package.json', 'utf8')).version || '') } catch { console.log('') }")
INSTALL_MODE="install"
[[ "$FEATURE_UPDATE_IS_UPDATE" == "true" ]] && INSTALL_MODE="update"
EXISTING_PLUGIN_CONFIG_JSON=$(jq -cn --argjson existing "$EXISTING_PLUGIN_ENTRY" 'if $existing == null then {} else ($existing.config // {}) end')
INSTALL_EVENT_INPUT=$(jq -n \
  --arg packageVersion "$PACKAGE_VERSION" \
  --arg installMode "$INSTALL_MODE" \
  --arg featureMode "$FEATURE_POLICY_MODE" \
  --argjson pluginConfig "$PLUGIN_CONFIG" \
  --argjson featurePlan "$FEATURE_UPDATE_PLAN" \
  --argjson beforeConfig "$EXISTING_PLUGIN_CONFIG_JSON" \
  '{
    packageVersion: $packageVersion,
    installMode: $installMode,
    featureMode: $featureMode,
    detectedBy: $featurePlan.detectedBy,
    beforeConfig: $beforeConfig,
    afterConfig: ($pluginConfig.config // {})
  }')
INSTALL_EVENT=$(PLUR1BUS_INSTALLER_INPUT="$INSTALL_EVENT_INPUT" node "$INSTALLER_CONFIG_HELPER" install-event | jq -c .)
run_target "mkdir -p '$TARGET_DIR/state'"
append_target_file "$INSTALL_LOG_PATH" "$INSTALL_EVENT"
ok "PLUR1BUS Install-Log aktualisiert: $INSTALL_LOG_PATH"

echo -e "${BOLD}Nächste Schritte:${RESET}"
echo
echo "  1. Gateway neu starten:"
if [[ "$IS_REMOTE" == "1" ]]; then
  echo "     ssh $SSH_HOST 'systemctl --user restart openclaw-gateway.service'"
else
  echo "     systemctl --user restart openclaw-gateway.service"
fi
echo
echo "  2. Plugin-Status prüfen:"
if [[ "$IS_REMOTE" == "1" ]]; then
  echo "     ssh $SSH_HOST 'journalctl --user -u openclaw-gateway -n 30 | grep memory-lancedb'"
else
  echo "     journalctl --user -u openclaw-gateway -n 30 | grep memory-lancedb"
fi
echo
echo "  3. GC-Script testen:"
echo "     node $TARGET_GC_SCRIPT"
echo
echo "  3b. KNOWLEDGE.md-Status prüfen:"
echo "     node $TARGET_MAINTAIN_SCRIPT --check"
  echo
  echo "  4. Erster Memory-Store und Recall testen (via Agent-Chat):"
  echo "     Nutze das echte Tool memory_store mit: {\"text\":\"Testfakt\",\"category\":\"fact\",\"importance\":0.5}"
  echo "     Nutze das echte Tool memory_recall mit: {\"query\":\"Testfakt\"}"
echo
if [[ "$FINAL_MERGING_ENABLED" != "true" ]]; then
  echo -e "${YELLOW}  Hinweis: LLM-Merging wurde nicht aktiviert. Für bessere Memory-Qualität${RESET}"
  echo -e "${YELLOW}  merging.enabled manuell oder über ein explizites Profil aktivieren; ohne Route nutzt es das effektive OpenClaw-Agentenmodell.${RESET}"
  echo -e "${YELLOW}  Pfad: plugins.entries.memory-lancedb-namespaced.config.merging${RESET}"
  echo
fi
if [[ "$USE_ACTIVE_MEMORY" == "n" ]]; then
  echo -e "${YELLOW}  Hinweis: ActiveMemory wurde nicht aktiviert (erfordert OpenClaw ≥ 4.10).${RESET}"
  echo -e "${YELLOW}  Manuell aktivieren: plugins.allow += \"active-memory\", plugins.entries[\"active-memory\"] = {...}${RESET}"
  echo -e "${YELLOW}  Doku: how-to-memory-perfect.md §ActiveMemory${RESET}"
  echo
fi

echo -e "  Daten erhalten: ${TARGET_DIR}/memory/lancedb-namespaced"
echo -e "  Doku: ${TARGET_DIR}/how-to-memory.md"
echo -e "        ${TARGET_DIR}/HOW-TO-OBSIDIAN.md"
echo -e "        ${TARGET_DIR}/how-to-memory-perfect.md"
echo
echo -e "  Rollback (falls nötig):"
echo -e "    $0 --rollback $TARGET"
echo
