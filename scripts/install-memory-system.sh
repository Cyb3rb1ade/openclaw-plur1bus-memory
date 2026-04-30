#!/usr/bin/env bash
# install-memory-system.sh — Installiert/aktualisiert das memory-lancedb-namespaced-System
# in eine OpenClaw-Instanz (lokal oder remote via SSH).
#
# Stand: 2026-05-01
#
# Verwendung:
#   ./install-memory-system.sh                          # Auto-Erkennung lokaler Installationen
#   ./install-memory-system.sh <ziel>                   # lokal: /home/user/.openclaw
#   ./install-memory-system.sh user@host:/path          # remote via SSH
#   ./install-memory-system.sh --dry-run <ziel>         # Vorschau ohne Änderungen
#   ./install-memory-system.sh --update-plugin-only <ziel>  # Nur Plugin aktualisieren (kein Config-Overhead)
#   ./install-memory-system.sh --rollback <ziel>        # Letzten Snapshot wiederherstellen
#
# Ohne Ziel-Argument: sucht automatisch nach lokalen OpenClaw-Installationen
# (prüft ~/.openclaw, /root/.openclaw, /home/*/.openclaw, /opt/, /srv/ etc.)
# und zeigt ein Auswahlmenü wenn mehrere gefunden werden.
#
# Snapshot-Verhalten: Vor jeder Installation wird ein LanceDB-Snapshot erstellt
# unter {ziel}/memory/.snapshots/. Max. 5 Snapshots, ältere werden gelöscht.
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
DOC_FILES=("how-to-memory.md" "how-to-memory-perfect.md")
GC_SCRIPT="$SOURCE_DIR/scripts/memory-gc.mjs"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
BOLD='\033[1m'

# ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

info()    { echo -e "${CYAN}[info]${RESET} $*"; }
ok()      { echo -e "${GREEN}[ok]${RESET}   $*"; }
warn()    { echo -e "${YELLOW}[warn]${RESET} $*"; }
error()   { echo -e "${RED}[error]${RESET} $*" >&2; }
step()    { echo -e "\n${BOLD}▶ $*${RESET}"; }
dryrun()  { echo -e "${YELLOW}[dry-run]${RESET} $*"; }

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
    dryrun "Würde fragen: $prompt (default=$default)"
    [[ "$default" =~ ^[Yy]$ ]]
    return $?
  fi
  read -rp "$prompt [y/n, default=$default]: " yn
  yn="${yn:-$default}"
  [[ "$yn" =~ ^[Yy]$ ]]
}

prompt_secret() {
  local var_name="$1" prompt_text="$2" default_hint="${3:-}"
  local val
  if [[ -n "$default_hint" ]]; then
    echo -e "  ${CYAN}$prompt_text${RESET} [${default_hint}]:"
  else
    echo -e "  ${CYAN}$prompt_text${RESET}:"
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "Würde Secret abfragen: $prompt_text"
    printf -v "$var_name" '%s' "$default_hint"
    return 0
  fi
  read -rs val
  echo
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
  read -rp "  $prompt_text [${default_val}]: " val
  val="${val:-$default_val}"
  printf -v "$var_name" '%s' "$val"
}

# ─── Remote/Lokal-Abstraktion ─────────────────────────────────────────────────

# Führt einen Befehl auf dem Ziel aus (lokal oder remote)
run_target() {
  if [[ "$IS_REMOTE" == "1" ]]; then
    ssh "$SSH_HOST" "$@"
  else
    bash -c "$*"
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
    ssh "$SSH_HOST" "cat > '$path'" <<< "$content"
  else
    echo "$content" > "$path"
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

# ─── Argument-Parsing ─────────────────────────────────────────────────────────

DRY_RUN=0
UPDATE_ONLY=0
ROLLBACK=0
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)            DRY_RUN=1 ;;
    --update-plugin-only) UPDATE_ONLY=1 ;;
    --rollback)           ROLLBACK=1 ;;
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
    echo "Verwendung: $0 [--dry-run] [--update-plugin-only] [--rollback] <ziel>"
    echo "  Lokal:              $0 /home/user/.openclaw"
    echo "  Remote:             $0 user@host:/home/user/.openclaw"
    echo "  Nur Plugin-Update:  $0 --update-plugin-only /home/user/.openclaw"
    echo "  Rollback:           $0 --rollback /home/user/.openclaw"
    echo ""
    echo "  --update-plugin-only  Kopiert nur das Plugin (index.js etc.) und startet"
    echo "                        den Gateway neu. Keine API-Key-Abfragen, keine Config-"
    echo "                        Änderungen, keine Datenverluste."
    echo "  --rollback            Stellt openclaw.json und LanceDB-Daten aus dem letzten"
    echo "                        Snapshot wieder her."
    echo ""
    warn "Keine lokale OpenClaw-Installation gefunden. Bitte Pfad manuell angeben."
    exit 1

  elif [[ ${#FOUND_INSTALLS[@]} -eq 1 ]]; then
    echo -e "${BOLD}Gefundene OpenClaw-Installation:${RESET}"
    echo "  ${FOUND_INSTALLS[0]}"
    echo
    read -rp "Diese Installation verwenden? [Y/n]: " yn
    yn="${yn:-y}"
    if [[ ! "$yn" =~ ^[Yy]$ ]]; then
      read -rp "Pfad manuell eingeben: " TARGET
    else
      TARGET="${FOUND_INSTALLS[0]}"
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

# ─── Schritt 1: API-Keys abfragen ─────────────────────────────────────────────

step "Schritt 1: API-Keys"
echo "  Diese Keys werden in die Ziel-openclaw.json eingetragen."
echo "  Leer lassen = Umgebungsvariablen-Syntax verwenden (\${VAR})."
echo

OPENAI_KEY=""
COHERE_KEY=""
USE_MERGING="n"
MERGING_KEY=""
MERGING_BASEURL=""
MERGING_MODEL=""
MERGING_DISABLE_THINKING="false"
MERGING_USER_AGENT=""
USE_EMBEDDING_FALLBACK="n"
EMBEDDING_FALLBACK_KEY=""
EMBEDDING_FALLBACK_BASEURL=""
EMBEDDING_FALLBACK_MODEL=""
USE_ACTIVE_MEMORY="n"

# Bestehende Config als Default verwenden. Full-Install darf bei Updates nicht
# versehentlich Keys, Pfade oder moderne 4.x-Konfigurationen überschreiben.
EXISTING_EMBEDDING_KEY=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.embedding.apiKey // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_EMBEDDING_MODEL=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.embedding.model // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_EMBEDDING_BASE_URL=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.embedding.baseUrl // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_EMBEDDING_DIMS=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.embedding.dimensions // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_BASE_DB_PATH=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.baseDbPath // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_COHERE_KEY=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.reranker.apiKey // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
EXISTING_MEMORY_SLOT=$(run_target "jq -r '.plugins.slots.memory // empty' '$TARGET_CONFIG' 2>/dev/null" || true)

echo ""
info "Embedding-Provider-Auswahl:"
info "  → OpenAI (Standard, default n) — text-embedding-3-large/small, ada-002"
info "  → OpenRouter (v2.1+, opt-in) — 20+ Embedding-Modelle (BAAI/BGE, Mistral, Gemini, Qwen, NVIDIA-free, …)"
info "Hinweis: Reranker (Cohere) wird unten separat gefragt — nicht von dieser Auswahl betroffen."
USE_OPENROUTER="n"
EMBEDDING_BASE_URL=""
EMBEDDING_DIMENSIONS=""

if confirm "OpenRouter statt OpenAI für Embeddings nutzen?" "n"; then
  USE_OPENROUTER="y"
  prompt_input OPENAI_KEY "OpenRouter API Key" "\${OPENROUTER_API_KEY}"
  EMBEDDING_BASE_URL="https://openrouter.ai/api/v1"

  echo ""
  info "Lade verfügbare Embedding-Modelle von OpenRouter…"
  OR_MODELS_JSON=$(curl -sf --max-time 15 "https://openrouter.ai/api/v1/embeddings/models" 2>/dev/null || echo "")
  if [[ -z "$OR_MODELS_JSON" ]]; then
    warn "OpenRouter-API nicht erreichbar — falle auf manuelle Modell-Eingabe zurück."
    EMBEDDING_MODEL="openai/text-embedding-3-large"
    prompt_input EMBEDDING_MODEL "OpenRouter Embedding-Modell" "$EMBEDDING_MODEL"
  else
    # Parse + zeige als Tabelle
    echo "$OR_MODELS_JSON" | jq -r '
      .data[] |
      [.id, (.context_length // 0 | tostring), (.pricing.prompt // "0"), (.description // "" | .[0:70])] |
      @tsv
    ' | nl -w3 -s'. ' | awk -F'\t' '{ printf "  %s%-50s %8s ctx  $%-12s %s\n", $1, $2, $3, $4, $5 }' | head -40
    echo ""
    info "Tipp: openai/text-embedding-3-large (3072d, multi-lingual, beste Qualität) ist Standard."
    EMBEDDING_MODEL="openai/text-embedding-3-large"
    prompt_input EMBEDDING_MODEL "OpenRouter-Modell-ID (z.B. baai/bge-m3, mistralai/mistral-embed-2312)" "$EMBEDDING_MODEL"
  fi

  # Test-Embedding-Call → Dimension automatisch ermitteln
  echo ""
  info "Test-Embedding-Call → ermittle echte Vektor-Dimension…"
  RESOLVED_KEY="$OPENAI_KEY"
  [[ "$RESOLVED_KEY" == *'${'* ]] && RESOLVED_KEY=$(eval echo "$RESOLVED_KEY")
  TEST_RESP=$(curl -sf --max-time 30 -X POST "https://openrouter.ai/api/v1/embeddings" \
    -H "Authorization: Bearer $RESOLVED_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$EMBEDDING_MODEL\",\"input\":\"dimension test\",\"encoding_format\":\"float\"}" 2>/dev/null || echo "")
  if [[ -n "$TEST_RESP" ]]; then
    EMBEDDING_DIMENSIONS=$(echo "$TEST_RESP" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  if 'data' in d and d['data']:
    print(len(d['data'][0]['embedding']))
  else:
    sys.exit(1)
except:
  sys.exit(1)
" 2>/dev/null || echo "")
  fi

  if [[ -z "$EMBEDDING_DIMENSIONS" ]]; then
    warn "Test-Call fehlgeschlagen — bitte Dimension manuell angeben (z.B. 1024 für BGE/Mistral, 3072 für OpenAI-large, 1536 für OpenAI-small)."
    prompt_input EMBEDDING_DIMENSIONS "Embedding-Dimension" "1024"
  else
    info "  ✓ Modell '$EMBEDDING_MODEL' liefert $EMBEDDING_DIMENSIONS-dimensionale Vektoren."
  fi
else
  prompt_input OPENAI_KEY "OpenAI API Key (für Embeddings)" "${EXISTING_EMBEDDING_KEY:-\${OPENAI_API_KEY}}"
fi

prompt_input COHERE_KEY "Cohere API Key (für Re-Ranker, leer = Re-Ranker deaktiviert)" "${EXISTING_COHERE_KEY:-}"

# Embedding-Fallback
echo ""
info "Embedding-Fallback: zweiter Endpunkt falls Primary nicht erreichbar (z.B. zweiter OpenAI-Key oder Azure)."
warn "  ⚠️  Fallback MUSS dasselbe Modell / dieselbe Dimension verwenden — LanceDB hat fixes Schema."
if confirm "Embedding-Fallback konfigurieren?" "n"; then
  USE_EMBEDDING_FALLBACK="y"
  prompt_input EMBEDDING_FALLBACK_KEY     "Fallback API Key" "\${OPENAI_API_KEY_FALLBACK}"
  prompt_input EMBEDDING_FALLBACK_BASEURL "Fallback Base-URL (leer = Standard OpenAI)" ""
  prompt_input EMBEDDING_FALLBACK_MODEL   "Fallback Modell (leer = wie Primary)" ""
fi

if confirm "LLM-Merging aktivieren? (dedupliziert ähnliche Memories via LLM — funktioniert mit beliebigem OpenAI-kompatiblen Anbieter)" "n"; then
  USE_MERGING="y"
  # Vorhandene Merging-Config als Defaults auslesen (bei Update-Installationen)
  _EXISTING_MERGING_MODEL=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.merging.model // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
  _EXISTING_MERGING_URL=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.merging.baseUrl // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
  _EXISTING_MERGING_KEY=$(run_target "jq -r '.plugins.entries[\"memory-lancedb-namespaced\"].config.merging.apiKey // empty' '$TARGET_CONFIG' 2>/dev/null" || true)
  prompt_input MERGING_BASEURL "Merging LLM Base-URL (leer = Standard-OpenAI)" "${_EXISTING_MERGING_URL:-}"
  prompt_input MERGING_MODEL   "Merging LLM Modell" "${_EXISTING_MERGING_MODEL:-}"
  prompt_input MERGING_KEY     "Merging LLM API Key" "${_EXISTING_MERGING_KEY:-\${OPENAI_API_KEY}}"
  echo ""
  info "Kimi k2p5-spezifische Optionen (NUR für Kimi-Nutzer):"
  info "  disableThinking=true unterdrückt das Reasoning-Budget, User-Agent ist Kimi-Pflichtfeld."
  if confirm "  Kimi-spezifische Optionen aktivieren?" "n"; then
    MERGING_DISABLE_THINKING="true"
    MERGING_USER_AGENT="claude-code/1.0"
  fi
fi

# ActiveMemory (ab OpenClaw 4.10)
echo ""
info "ActiveMemory: Dedizierter Sub-Agent, der vor jeder Antwort Memories synthetisiert (OpenClaw ≥ 4.10)."
info "  → Blocking, max. 15s Timeout, per-Agent isoliert, ergänzt Auto-Recall."
if confirm "ActiveMemory-Plugin aktivieren? (nur OpenClaw ≥ 4.10)" "n"; then
  USE_ACTIVE_MEMORY="y"
fi

# Embedding-Modell (nur fragen wenn nicht via OpenRouter schon gesetzt)
if [[ "$USE_OPENROUTER" != "y" ]]; then
  EMBEDDING_BASE_URL="${EXISTING_EMBEDDING_BASE_URL:-}"
  EMBEDDING_MODEL="${EXISTING_EMBEDDING_MODEL:-text-embedding-3-large}"
  prompt_input EMBEDDING_MODEL "Embedding-Modell" "$EMBEDDING_MODEL"
  EMBEDDING_DIMENSIONS="${EXISTING_EMBEDDING_DIMS:-3072}"  # OpenAI text-embedding-3-large default
  if [[ -z "$EXISTING_EMBEDDING_DIMS" && ( "$EMBEDDING_MODEL" == *"small"* || "$EMBEDDING_MODEL" == *"ada"* ) ]]; then
    EMBEDDING_DIMENSIONS=1536
  fi
fi

# v2.1.1: Pre-Flight-Check — vergleiche neue Dim mit bestehenden LanceDBs.
# Verhindert silent Datenkorruption bei Provider-Wechsel.
echo ""
info "Pre-Flight: prüfe bestehende LanceDB-Dimensionen vs. neue Config ($EMBEDDING_DIMENSIONS)…"
TARGET_DB_PATH="$TARGET_DIR/memory/lancedb-namespaced"
EXISTING_DBS=$(run_target "ls -d '$TARGET_DB_PATH'/*/ 2>/dev/null | xargs -n1 basename 2>/dev/null || true" || echo "")
if [[ -n "$EXISTING_DBS" ]]; then
  MISMATCH_COUNT=0
  while IFS= read -r ag; do
    [[ -z "$ag" ]] && continue
    # Schema-Dim per Python aus LanceDB lesen — funktioniert remote nicht direkt, nur lokal
    if [[ "$IS_REMOTE" == "1" ]]; then continue; fi
    if [[ "$DRY_RUN" == "1" ]]; then
      dryrun "Würde LanceDB-Dimension für Agent '$ag' prüfen"
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

ok "Plugins kopiert nach $EXTENSIONS_DIR"

# ─── Schritt 4: openclaw.json patchen ─────────────────────────────────────────

step "Schritt 4: openclaw.json patchen"

# Reranker-Block aufbauen
if [[ -n "$COHERE_KEY" && "$COHERE_KEY" != "" ]]; then
  RERANKER_BLOCK=$(jq -n \
    --arg key "$COHERE_KEY" \
    '{"enabled": true, "apiKey": $key, "model": "rerank-v3.5", "candidates": 20}')
else
  RERANKER_BLOCK='{"enabled": false}'
fi

# Merging-Block aufbauen
if [[ "$USE_MERGING" == "y" ]]; then
  # Basis-Config (provider-agnostisch)
  MERGING_BLOCK=$(jq -n \
    --arg key "$MERGING_KEY" \
    --arg url "$MERGING_BASEURL" \
    --arg model "$MERGING_MODEL" \
    --argjson disableThinking "$MERGING_DISABLE_THINKING" \
    --arg userAgent "$MERGING_USER_AGENT" \
    '{
      "enabled": true,
      "threshold": 0.70,
      "model": $model,
      "baseUrl": (if $url == "" then null else $url end),
      "apiKey": $key,
      "disableThinking": $disableThinking
    }
    | if $userAgent != "" then . + {"headers": {"User-Agent": $userAgent}} else . end
    | with_entries(select(.value != null))')
  SCHICHT15_BLOCK=$(jq -n \
    --arg key "$MERGING_KEY" \
    --arg url "$MERGING_BASEURL" \
    --arg model "$MERGING_MODEL" \
    --argjson disableThinking "$MERGING_DISABLE_THINKING" \
    --arg userAgent "$MERGING_USER_AGENT" \
    '{
      "enabled": true,
      "model": $model,
      "baseUrl": (if $url == "" then null else $url end),
      "apiKey": $key,
      "disableThinking": $disableThinking,
      "minImportance": 0.7
    }
    | if $userAgent != "" then . + {"headers": {"User-Agent": $userAgent}} else . end
    | with_entries(select(.value != null))')
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
      "apiKey": $key,
      "baseUrl": (if $baseUrl == "" then null else $baseUrl end),
      "model":   (if $model   == "" then null else $model   end)
    } | with_entries(select(.value != null))')
else
  EMBEDDING_FALLBACK_BLOCK='null'
fi

# Plugin-Config-Objekt
PLUGIN_CONFIG=$(jq -n \
  --arg openai_key "$OPENAI_KEY" \
  --arg embedding_model "$EMBEDDING_MODEL" \
  --arg embedding_base_url "${EMBEDDING_BASE_URL:-}" \
  --argjson embedding_dims "${EMBEDDING_DIMENSIONS:-3072}" \
  --arg db_path "${EXISTING_BASE_DB_PATH:-$TARGET_DIR/memory/lancedb-namespaced}" \
  --argjson reranker "$RERANKER_BLOCK" \
  --argjson merging "$MERGING_BLOCK" \
  --argjson schicht15 "$SCHICHT15_BLOCK" \
  --argjson embedding_fallback "$EMBEDDING_FALLBACK_BLOCK" \
  '{
    "enabled": true,
    "config": {
      "embedding": (
        {
          "apiKey": $openai_key,
          "model": $embedding_model,
          "dimensions": $embedding_dims
        }
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
      "schicht15": $schicht15
    }
  }')

# jq-Patch-Script (wird remote oder lokal ausgeführt)
JQ_PATCH=$(cat <<'JQEOF'
# Plugin-Entry + Allow-Eintrag + Slots
. as $root
| .plugins.allow = ((.plugins.allow // []) | if index("memory-lancedb-namespaced") then . else . + ["memory-lancedb-namespaced"] end)
| .plugins.slots.memory = (.plugins.slots.memory // "memory-core")
| .plugins.entries["memory-lancedb-namespaced"] = (($plugin_config) + {"hooks": ((.plugins.entries["memory-lancedb-namespaced"].hooks // {}) + {"allowConversationAccess": true})})
| if .plugins.entries["memory-lancedb"] then .plugins.entries["memory-lancedb"].enabled = false else . end
JQEOF
)

if [[ "$DRY_RUN" == "1" ]]; then
  dryrun "Würde openclaw.json mit Plugin-Config patchen"
  dryrun "  - plugins.allow += memory-lancedb-namespaced"
  dryrun "  - plugins.slots.memory bleibt '${EXISTING_MEMORY_SLOT:-memory-core}'"
  dryrun "  - plugins.entries.memory-lancedb-namespaced = {embedding, autoCapture, reranker, hooks.allowConversationAccess, ...}"
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
const existing = cfg.plugins.entries['memory-lancedb-namespaced'] || {};
plugin.hooks = { ...(existing.hooks || {}), allowConversationAccess: true };
cfg.plugins.entries['memory-lancedb-namespaced'] = plugin;
if (cfg.plugins.entries['memory-lancedb']) cfg.plugins.entries['memory-lancedb'].enabled = false;
writeFileSync('${TARGET_CONFIG}', JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('patched');
NODEOF
  else
    # Lokal: via jq
    TMPFILE=$(mktemp)
    jq --argjson plugin_config "$PLUGIN_CONFIG" \
      '(. | .plugins.allow = ((.plugins.allow // []) | if index("memory-lancedb-namespaced") then . else . + ["memory-lancedb-namespaced"] end))
       | .plugins.slots.memory = (.plugins.slots.memory // "memory-core")
       | .plugins.entries["memory-lancedb-namespaced"] = (($plugin_config) + {"hooks": ((.plugins.entries["memory-lancedb-namespaced"].hooks // {}) + {"allowConversationAccess": true})})
       | if .plugins.entries["memory-lancedb"] then .plugins.entries["memory-lancedb"].enabled = false else . end
      ' \
      "$TARGET_CONFIG" > "$TMPFILE" && mv "$TMPFILE" "$TARGET_CONFIG"
  fi
  ok "openclaw.json gepatcht"
fi

# ─── Schritt 4b: ActiveMemory-Plugin konfigurieren ────────────────────────────

if [[ "$USE_ACTIVE_MEMORY" == "y" ]]; then
  step "Schritt 4b: ActiveMemory-Plugin"

  AGENTS_JSON_ARR=$(printf '"%s",' "${AGENT_LIST[@]}" | sed 's/,$//')
  ACTIVE_MEMORY_CONFIG=$(jq -n \
    --argjson agents "[$AGENTS_JSON_ARR]" \
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
        "logging": true,
        "modelFallback": "moonshot/kimi-k2.6",
        "model": "kimi-coding/kimi-for-coding",
        "thinking": "off"
      }
    }')

  if [[ "$DRY_RUN" == "1" ]]; then
    dryrun "Würde active-memory zu plugins.allow und plugins.entries hinzufügen"
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
    info "  queryMode=recent, promptStyle=balanced, timeout=15s, maxSummaryChars=220"
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

# ─── Schritt 6: memory-gc.mjs kopieren und Cron einrichten ────────────────────

step "Schritt 6: TTL-GC-Cron einrichten"

TARGET_GC_SCRIPT="$TARGET_DIR/scripts/memory-gc.mjs"

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

# Cron-Eintrag — User-Crontab (kein Root erforderlich, kein Privilege-Escalation-Risiko)
CRON_LINE="0 3 * * * /usr/bin/node $TARGET_GC_SCRIPT >> /tmp/openclaw/memory-gc.log 2>&1"

if [[ "$DRY_RUN" == "1" ]]; then
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

# ─── Schritt 7: Dokumentation kopieren ────────────────────────────────────────

step "Schritt 7: Dokumentation kopieren"

for doc in "${DOC_FILES[@]}"; do
  src_doc="$SOURCE_DIR/$doc"
  if [[ -f "$src_doc" ]]; then
    if [[ "$DRY_RUN" == "0" ]]; then
      if [[ "$IS_REMOTE" == "1" ]]; then
        scp "$src_doc" "${SSH_HOST}:${TARGET_DIR}/$doc"
      else
        cp "$src_doc" "$TARGET_DIR/$doc"
      fi
    fi
    ok "Kopiert: $doc → $TARGET_DIR/$doc"
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
      if [[ "$DRY_RUN" == "0" ]]; then
        run_target "echo '$SOUL_SECTION' >> '$soul_path'"
      fi
      ok "SOUL.md von '$agent': Conflict-Log-Sektion hinzugefügt"
    fi
  else
    warn "SOUL.md für Agent '$agent' nicht gefunden ($soul_path) — übersprungen"
  fi
done

# ─── Schritt 9: OpenClaw-Patches anwenden ─────────────────────────────────────

step "Schritt 9: OpenClaw-Patches anwenden"

PATCHES_SCRIPT="$SOURCE_DIR/patches/apply-memory-patches.sh"
if [[ -f "$PATCHES_SCRIPT" ]]; then
  if [[ "$DRY_RUN" == "0" ]]; then
    if [[ "$IS_REMOTE" == "1" ]]; then
      scp "$PATCHES_SCRIPT" "${SSH_HOST}:/tmp/apply-memory-patches.sh"
      ssh "$SSH_HOST" "bash /tmp/apply-memory-patches.sh && rm /tmp/apply-memory-patches.sh"
    else
      bash "$PATCHES_SCRIPT"
    fi
    ok "Patches angewendet"
  else
    dryrun "Würde Patches anwenden: $PATCHES_SCRIPT"
  fi
else
  warn "patches/apply-memory-patches.sh nicht gefunden — übersprungen"
fi

# ─── Schritt 10: Abschluss ────────────────────────────────────────────────────

echo
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   Installation abgeschlossen                              ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo

if [[ "$DRY_RUN" == "1" ]]; then
  warn "DRY-RUN: Keine Änderungen vorgenommen. Erneut ohne --dry-run ausführen."
  exit 0
fi

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
echo "  4. Erster Memory-Store und Recall testen (via Agent-Chat):"
echo "     memory_store: {text: 'Testfakt', category: 'fact', importance: 0.5}"
echo "     memory_recall: {query: 'Testfakt'}"
echo
if [[ "$USE_MERGING" == "n" ]]; then
  echo -e "${YELLOW}  Hinweis: LLM-Merging wurde nicht aktiviert. Für bessere Memory-Qualität${RESET}"
  echo -e "${YELLOW}  Merging-Config manuell in openclaw.json ergänzen (funktioniert mit OpenAI, Claude, GLM, Kimi u.a.)${RESET}"
  echo -e "${YELLOW}  Pfad: plugins.entries.memory-lancedb-namespaced.config.merging${RESET}"
  echo
fi
if [[ "$USE_ACTIVE_MEMORY" == "n" ]]; then
  echo -e "${YELLOW}  Hinweis: ActiveMemory wurde nicht aktiviert (erfordert OpenClaw ≥ 4.10).${RESET}"
  echo -e "${YELLOW}  Manuell aktivieren: plugins.allow += \"active-memory\", plugins.entries[\"active-memory\"] = {...}${RESET}"
  echo -e "${YELLOW}  Doku: how-to-memory-perfect.md §ActiveMemory${RESET}"
  echo
fi

echo -e "  Doku: ${TARGET_DIR}/how-to-memory-perfect.md"
echo
echo -e "  Rollback (falls nötig):"
echo -e "    $0 --rollback $TARGET"
echo
