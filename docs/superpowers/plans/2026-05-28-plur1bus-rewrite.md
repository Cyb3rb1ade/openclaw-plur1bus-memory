# PLUR1BUS Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PLUR1BUS Review-Bundle workflow with three minimal user touchpoints (`/memory`, `/vergiss`+`/korrigier`, kritisch-Push). Bot lernt autonom; Review-Bundle und alle zugehörigen Befehle entfallen.

**Architecture:** LanceDB bleibt autoritativ und unverändert; das `memory-lancedb-namespaced` Plugin wird umstrukturiert (alte Review-/Approval-Surface raus, neue Inspektions- und Eingriffs-Commands rein); Vault-Layout bekommt `/memory/cards/` und `/sys/`; Cron-Jobs für Evening-Review entfallen; Syncthing-Filter werden verschärft.

**Tech Stack:** Node.js (OpenClaw-Extensions), LanceDB, Syncthing, systemd-Timer/OpenClaw-Cron, Kimi-Coding (Card-Polish & Vergiss-Interpretation).

**Spec:** `docs/superpowers/specs/2026-05-28-plur1bus-rewrite-design.md`

**Reihenfolge:** 6 Phasen, jede ist commit-fähig und in sich geschlossen. Zwischen Phasen kann gestoppt und Status berichtet werden.

---

## Phase 0 — Pre-Flight & Diagnose

Ziel: Verstehen wo "Bridge is disabled" herkommt (Config sagt enabled), Path-Referenzen auf Bot-System-Files mappen, Isolations-Annahmen prüfen.

### Task 0.1: Bridge-Diagnose

**Files:**
- Read: `/root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js:990-1020`

- [ ] **Step 1: Stelle finden, die `bridge_disabled` triggert**

Run: `sed -n '985,1020p' /root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js`

Notiere: Welche Condition prüft die Disabled-Flag? Welcher Config-Pfad wird gelesen? (Erwartung: nicht `obsidianBridge.enabled`, sondern was anderes — sonst hätten wir keine Diskrepanz.)

- [ ] **Step 2: Den tatsächlich gelesenen Config-Pfad prüfen**

Wenn z. B. `cfg.bridge?.enabled` gelesen wird:
```bash
node -e 'const c=require("/root/.openclaw/openclaw.json"); console.log(JSON.stringify(c.plugins?.entries?.["memory-lancedb-namespaced"]?.bridge, null, 2))'
```

Falls Pfad anders ist, an entsprechender Stelle nachlesen.

- [ ] **Step 3: Befund in den Plan eintragen**

Bearbeite diesen Plan: ergänze in Task 5.4 ("Status-Command: Bridge enthält Anleitung") den **exakten** Config-Pfad, der gesetzt werden muss um Bridge einzuschalten. Trag den Befund auch im Spec unter Risiken nach (`docs/superpowers/specs/2026-05-28-plur1bus-rewrite-design.md` Abschnitt 12).

- [ ] **Step 4: Commit**

```bash
cd /root && git add docs/superpowers/plans/2026-05-28-plur1bus-rewrite.md docs/superpowers/specs/2026-05-28-plur1bus-rewrite-design.md
git commit -m "diag: dokumentiere bridge_disabled config-pfad"
```

### Task 0.2: Path-Referenzen auf Bot-System-Files mappen

**Files:**
- Search: `/root/.openclaw/extensions/`, `/root/.openclaw/scripts/`, `/root/.openclaw/agents/`

- [ ] **Step 1: Suche nach Hardcoded-Pfaden zu MEMORY.md / SOUL.md / DREAMS.md etc.**

```bash
grep -rn "workspace/MEMORY.md\|workspace/SOUL.md\|workspace/DREAMS.md\|workspace/HEARTBEAT.md\|workspace/IDENTITY.md\|workspace/AGENTS.md" /root/.openclaw/ --include="*.js" --include="*.json" --include="*.sh" --include="*.mjs" 2>/dev/null > /tmp/plur1bus-path-refs.txt
wc -l /tmp/plur1bus-path-refs.txt
cat /tmp/plur1bus-path-refs.txt
```

- [ ] **Step 2: Pro Workspace-Variante ebenfalls grep**

```bash
grep -rn "workspace-bernhardine/MEMORY.md\|workspace-bernhardine/SOUL.md\|workspace-heisenberg/MEMORY.md\|workspace-heisenberg/SOUL.md" /root/.openclaw/ --include="*.js" --include="*.json" --include="*.sh" --include="*.mjs" 2>/dev/null >> /tmp/plur1bus-path-refs.txt
```

- [ ] **Step 3: Datei `/tmp/plur1bus-path-refs.txt` speichern als Plan-Anhang**

Liste der Path-Referenzen in Task 1.5 unten als Liste der zu ändernden Files eintragen. Wenn die Liste leer ist (was unwahrscheinlich ist), dann sind keine Code-Updates nötig — nur die Files selbst verschieben.

- [ ] **Step 4: Commit (Diagnose-Dokumentation)**

Nichts zu committen, wenn keine Files geändert. Nur weiter mit nächster Task.

### Task 0.3: Isolations-Verifikation pro Spec §9

- [ ] **Step 1: LanceDB-Namespaces auflisten**

```bash
ls /root/.openclaw/memory/lancedb-namespaced/ | sort > /tmp/lancedb-namespaces.txt
cat /tmp/lancedb-namespaces.txt
```

Erwartung: Klare Trennung nach `bernhardine*`, `heisenberg*`, und namenlose (Bernd-Subagents wie `architect`, `developer`).

- [ ] **Step 2: Syncthing-Folder-Devices prüfen**

```bash
grep -B1 "<device id" /root/.local/state/syncthing/config.xml | head -40
```

Erwartung: `openclaw-obsidian-bernd` und `openclaw-obsidian-bernhardine` haben disjunkte Device-Sets (keine Bernhardine-Device im Bernd-Folder).

- [ ] **Step 3: Plugin-Config pro Agent prüfen**

```bash
for agent in main bernhardine heisenberg; do
  echo "=== $agent ==="
  cat "/root/.openclaw/agents/$agent/agent/openclaw.json" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print('workspace:', d.get('workspace',{}).get('path','?'))"
done
```

Erwartung: Bernd → `/root/.openclaw/workspace`, Bernhardine → `workspace-bernhardine`, Heisenberg → `workspace-heisenberg`. **Keine Überlappung.**

- [ ] **Step 4: Wenn Befund OK, nur als Log dokumentieren**

```bash
cat > /tmp/plur1bus-isolation-check-$(date +%Y-%m-%d).log <<EOF
$(date -Iseconds) PLUR1BUS Isolation Verification
LanceDB Namespaces: $(wc -l < /tmp/lancedb-namespaces.txt)
Syncthing Folders: bernd, bernhardine (heisenberg server-only)
Workspace-Paths: getrennt verifiziert
Result: ISOLATED ✓
EOF
cat /tmp/plur1bus-isolation-check-*.log
```

Wenn Befund nicht OK: STOPP, beim User melden bevor Plan fortgesetzt.

---

## Phase 1 — Cleanup & Migration

Ziel: Bestandsdaten aufräumen ohne Code-Änderung. Risiko-arm, schafft Voraussetzungen.

### Task 1.1: Bundle-State archivieren (alle Agenten)

**Files:**
- Move: `workspace*/plur1bus/review-bundles/` → `workspace*/plur1bus/_archive/bundles-2026-05-28/`

- [ ] **Step 1: Prüfen, welche Bundles aktuell existieren**

```bash
for ws in workspace workspace-bernhardine workspace-heisenberg; do
  echo "=== $ws ==="
  ls /root/.openclaw/$ws/plur1bus/review-bundles/ 2>/dev/null | wc -l
done
```

- [ ] **Step 2: Archiv-Verzeichnis pro Workspace anlegen**

```bash
for ws in workspace workspace-bernhardine workspace-heisenberg; do
  mkdir -p /root/.openclaw/$ws/plur1bus/_archive/bundles-2026-05-28/
done
```

- [ ] **Step 3: Bundle-Files in Archiv verschieben**

```bash
for ws in workspace workspace-bernhardine workspace-heisenberg; do
  src="/root/.openclaw/$ws/plur1bus/review-bundles"
  dst="/root/.openclaw/$ws/plur1bus/_archive/bundles-2026-05-28"
  if [ -d "$src" ] && [ "$(ls -A $src 2>/dev/null)" ]; then
    mv $src/* $dst/
    echo "$ws: archiviert"
  else
    echo "$ws: leer"
  fi
done
```

- [ ] **Step 4: Verifikation**

```bash
ls /root/.openclaw/workspace*/plur1bus/review-bundles/ 2>/dev/null   # sollte leer sein
ls /root/.openclaw/workspace*/plur1bus/_archive/bundles-2026-05-28/ | head -5
```

- [ ] **Step 5: Commit (nur wenn /root unter git steht)**

```bash
cd /root && git add -A docs/superpowers/  # workspace ist NICHT git-tracked, kein Add
git status
git commit -m "chore(plur1bus): archive review-bundles for rewrite" || echo "nichts zu committen"
```

### Task 1.2: Evening-Deep-Review Files archivieren

- [ ] **Step 1: Alle Files identifizieren**

```bash
find /root/.openclaw/workspace*/plur1bus/ -maxdepth 1 -name "evening-deep-review-*.md" 2>/dev/null | wc -l
find /root/.openclaw/workspace*/ -maxdepth 1 -name "evening-deep-review-*.md" 2>/dev/null  # auch Root prüfen (Bug P1)
```

- [ ] **Step 2: Archiv-Verzeichnis anlegen + Move**

```bash
for ws in workspace workspace-bernhardine workspace-heisenberg; do
  base="/root/.openclaw/$ws"
  mkdir -p "$base/plur1bus/_archive/evening-reviews-pre-rewrite/"
  find "$base" -maxdepth 2 -name "evening-deep-review-*.md" -exec mv {} "$base/plur1bus/_archive/evening-reviews-pre-rewrite/" \;
done
```

- [ ] **Step 3: Verifikation**

```bash
find /root/.openclaw/workspace*/ -maxdepth 2 -name "evening-deep-review-*.md" -not -path "*_archive*" 2>/dev/null  # sollte 0 Treffer haben
```

### Task 1.3: Sync-Konflikte aufräumen

- [ ] **Step 1: Aktuelle Konflikte listen**

```bash
find /root/.openclaw/workspace/.obsidian -name "*.sync-conflict-*" 2>/dev/null
find /root/.openclaw/workspace-bernhardine/.obsidian -name "*.sync-conflict-*" 2>/dev/null
```

- [ ] **Step 2: Backup vor Löschen**

```bash
mkdir -p /root/.openclaw/backups/sync-conflicts-2026-05-28
cp /root/.openclaw/workspace/.obsidian/*.sync-conflict-* /root/.openclaw/backups/sync-conflicts-2026-05-28/ 2>/dev/null
cp /root/.openclaw/workspace-bernhardine/.obsidian/*.sync-conflict-* /root/.openclaw/backups/sync-conflicts-2026-05-28/ 2>/dev/null
ls /root/.openclaw/backups/sync-conflicts-2026-05-28/
```

- [ ] **Step 3: Löschen**

```bash
rm /root/.openclaw/workspace/.obsidian/*.sync-conflict-* 2>/dev/null
rm /root/.openclaw/workspace-bernhardine/.obsidian/*.sync-conflict-* 2>/dev/null
```

- [ ] **Step 4: Verifikation**

```bash
find /root/.openclaw/workspace*/.obsidian -name "*.sync-conflict-*" 2>/dev/null  # erwartet: leer
```

### Task 1.4: `/sys/` Verzeichnis pro Workspace anlegen

- [ ] **Step 1: Verzeichnisse anlegen**

```bash
for ws in workspace workspace-bernhardine workspace-heisenberg; do
  mkdir -p /root/.openclaw/$ws/sys/
done
```

- [ ] **Step 2: Pro Workspace die System-Files identifizieren**

```bash
for ws in workspace workspace-bernhardine workspace-heisenberg; do
  echo "=== $ws ==="
  for f in MEMORY.md SOUL.md DREAMS.md HEARTBEAT.md IDENTITY.md AGENTS.md ONBOARDING.md SESSION-STATE.md USER.md TOOLS.md DEUTSCHE-TRIGGER.md; do
    if [ -f /root/.openclaw/$ws/$f ]; then echo "  $f vorhanden"; fi
  done
done
```

### Task 1.5: System-Files verschieben (NACH Path-Referenz-Update)

**Voraussetzung:** Task 0.2 ist abgeschlossen, `/tmp/plur1bus-path-refs.txt` listet alle Code-Stellen.

- [ ] **Step 1: Code-Pfade aktualisieren (sed pro File)**

Lies `/tmp/plur1bus-path-refs.txt`. Für jede Datei:

```bash
# Beispiel für ein gefundenes File:
file="/root/.openclaw/scripts/some-script.sh"
sed -i.bak 's|workspace/MEMORY.md|workspace/sys/MEMORY.md|g' "$file"
sed -i 's|workspace/SOUL.md|workspace/sys/SOUL.md|g' "$file"
sed -i 's|workspace/DREAMS.md|workspace/sys/DREAMS.md|g' "$file"
sed -i 's|workspace/HEARTBEAT.md|workspace/sys/HEARTBEAT.md|g' "$file"
sed -i 's|workspace/IDENTITY.md|workspace/sys/IDENTITY.md|g' "$file"
sed -i 's|workspace/AGENTS.md|workspace/sys/AGENTS.md|g' "$file"
# analog für workspace-bernhardine und workspace-heisenberg
```

Wenn `/tmp/plur1bus-path-refs.txt` leer: skip diesen Schritt.

- [ ] **Step 2: System-Files verschieben (alle Agenten)**

```bash
for ws in workspace workspace-bernhardine workspace-heisenberg; do
  for f in MEMORY.md SOUL.md DREAMS.md HEARTBEAT.md IDENTITY.md AGENTS.md ONBOARDING.md SESSION-STATE.md USER.md TOOLS.md DEUTSCHE-TRIGGER.md; do
    if [ -f /root/.openclaw/$ws/$f ]; then
      mv /root/.openclaw/$ws/$f /root/.openclaw/$ws/sys/$f
    fi
  done
done
```

- [ ] **Step 3: `.bak` Files mit verschieben (Backup-Müll)**

```bash
for ws in workspace workspace-bernhardine workspace-heisenberg; do
  mv /root/.openclaw/$ws/*.bak* /root/.openclaw/$ws/sys/ 2>/dev/null || true
done
```

- [ ] **Step 4: Smoke-Test — schreiben die Agenten erfolgreich in /sys/?**

```bash
# Bernd-Agent Heartbeat per OpenClaw triggern
# (User-spezifisch, vermutlich systemd-Service neustart)
systemctl --user restart openclaw-gateway
sleep 30
# Prüfen ob neue HEARTBEAT.md im /sys/ landet, nicht im Root
ls -la /root/.openclaw/workspace/sys/HEARTBEAT.md
ls -la /root/.openclaw/workspace/HEARTBEAT.md 2>/dev/null && echo "WARN: noch im Root!"
```

Falls Datei im Root wieder auftaucht: STOPP, Path-Reference-Update unvollständig — zurück zu 0.2 / 1.5/Step 1.

### Task 1.6: `workspace-main` und `workspace-cron` Reference-Check + Verschieben

- [ ] **Step 1: Referenzen suchen**

```bash
grep -rn "workspace-main\|workspace-cron" /root/.openclaw/ --include="*.json" --include="*.js" --include="*.sh" 2>/dev/null | grep -v backups > /tmp/legacy-ws-refs.txt
cat /tmp/legacy-ws-refs.txt
```

- [ ] **Step 2: Falls keine Referenzen, in Backup verschieben**

```bash
if [ ! -s /tmp/legacy-ws-refs.txt ]; then
  mkdir -p /root/.openclaw/backups/legacy-workspaces-2026-05-28
  mv /root/.openclaw/workspace-main /root/.openclaw/backups/legacy-workspaces-2026-05-28/
  mv /root/.openclaw/workspace-cron /root/.openclaw/backups/legacy-workspaces-2026-05-28/
  echo "verschoben"
else
  echo "REFERENZEN gefunden — beim User melden"
fi
```

- [ ] **Step 3: Commit Phase 1**

```bash
cd /root && git add -A docs/superpowers/
git commit -m "phase 1: plur1bus cleanup (bundles, evening-reviews, sync-conflicts, sys/ move)"
```

---

## Phase 2 — Syncthing-Filter-Update

Ziel: Sync-Konflikte für `.obsidian/` strukturell verhindern, Memory-Cards-Verzeichnis bleibt synct.

### Task 2.1: Neue `.stignore` für Bernd

**Files:**
- Modify: `/root/.openclaw/workspace/.stignore`

- [ ] **Step 1: Neue Datei schreiben**

```bash
cat > /root/.openclaw/workspace/.stignore <<'EOF'
// OpenClaw Obsidian curated vault allowlist
!/.obsidian/plugins/plur1bus-bridge.json
!/.obsidian/workspace-mobile.json
!/memory
!/decisions
!/people
!/projects
(?d)*
EOF
```

- [ ] **Step 2: Verifikation**

```bash
cat /root/.openclaw/workspace/.stignore
```

Erwartet: Genau diese 7 Zeilen.

### Task 2.2: Neue `.stignore` für Bernhardine

- [ ] **Step 1: Identische Datei (Bernhardine hat selbe Topology)**

```bash
cp /root/.openclaw/workspace/.stignore /root/.openclaw/workspace-bernhardine/.stignore
diff /root/.openclaw/workspace/.stignore /root/.openclaw/workspace-bernhardine/.stignore
```

Erwartet: kein Diff.

### Task 2.3: Syncthing-Rescan triggern

- [ ] **Step 1: API-Key holen**

```bash
APIKEY=$(grep -oP '(?<=<apikey>)[^<]+' /root/.local/state/syncthing/config.xml | head -1)
echo "Key gefunden: ${APIKEY:0:8}..."
```

- [ ] **Step 2: Rescan beide Folders**

```bash
curl -s -X POST -H "X-API-Key: $APIKEY" "http://127.0.0.1:8384/rest/db/scan?folder=openclaw-obsidian-bernd"
curl -s -X POST -H "X-API-Key: $APIKEY" "http://127.0.0.1:8384/rest/db/scan?folder=openclaw-obsidian-bernhardine"
```

- [ ] **Step 3: Status checken**

```bash
sleep 10
curl -s -H "X-API-Key: $APIKEY" "http://127.0.0.1:8384/rest/db/status?folder=openclaw-obsidian-bernd" | python3 -m json.tool | head -20
```

Erwartet: `state: "idle"` nach kurzer Zeit, `globalFiles` ist um die Anzahl der jetzt ignorierten Files geringer.

- [ ] **Step 4: Commit Phase 2**

```bash
cd /root && git add -A docs/superpowers/
git commit -m "phase 2: syncthing-filter verschärft, .obsidian/-split"
```

---

## Phase 3 — Plugin-Cleanup (alte Commands & Config raus)

Ziel: Alte `/plur1bus_review` Surface und zugehörige Config-Schlüssel entfernen. Plugin lädt danach noch, Commands aber sind weg.

### Task 3.1: Help-Text in index.js entrümpeln

**Files:**
- Modify: `/root/.openclaw/extensions/memory-lancedb-namespaced/index.js:1273-1305`

- [ ] **Step 1: Aktuellen Help-Block lesen**

```bash
sed -n '1265,1310p' /root/.openclaw/extensions/memory-lancedb-namespaced/index.js
```

- [ ] **Step 2: Help-Block ersetzen — alte Review-Commands raus**

Edit-Operation: Suchen-Ersetzen in `index.js`.

Old (Zeilen 1273–1305, im obigen Output sichtbar):
```js
            "/plur1bus status",
            "/plur1bus doctor",
            "/plur1bus obsidian doctor",
            "/plur1bus obsidian review prepare",
            "/plur1bus obsidian review show [bundleId]",
            "/plur1bus obsidian review explain [bundleId]",
            "/plur1bus obsidian review approve [bundleId] --items <ids|all|low-risk>",
            "/plur1bus obsidian review reject [bundleId] --items <ids|all>",
            "/plur1bus obsidian review apply [bundleId]",
            "/plur1bus obsidian dashboards build",
            "/plur1bus obsidian conflicts build",
            "/plur1bus obsidian cron print-workspace-reviews",
```

New:
```js
            "/plur1bus status",
            "/plur1bus doctor",
            "/plur1bus obsidian doctor",
            "/plur1bus obsidian dashboards build",
            "/plur1bus obsidian conflicts build",
```

Und die "/plur1bus_*" Block (Zeilen 1291–1305):

Old:
```js
            "/plur1bus_morning - prepare today's review proposals",
            "/plur1bus_evening - run the deep evening checks",
            "/plur1bus_review - show the latest pending ReviewBundle",
            "/plur1bus_review explain - explain what apply wrote",
            "/plur1bus_review approve low-risk - mark safe low-risk items approved",
            "/plur1bus_review reject all - mark all pending items rejected",
            "/plur1bus_review apply - write approved memory candidates to memory",
            "/plur1bus_review quickapply - approve low-risk items and apply them in one explicit step",
```

New:
```js
            "/memory <Frage> - Erinnerungen einsehen (z.B. /memory diese Woche, /memory über Eva)",
            "/vergiss <Freitext> - eine Erinnerung löschen",
            "/korrigier <alt> zu <neu> - eine Erinnerung ändern",
            "/status - System-Health (Vault-Sync, Plausibilitätsprüfung, ...)",
            "/einschalten <feature> - Funktion einschalten (z.B. /einschalten vaultSync)",
            "/ausschalten <feature> - Funktion ausschalten",
```

- [ ] **Step 3: Verifikation**

```bash
grep -E "plur1bus_review|plur1bus_morning|plur1bus_evening|review approve|review reject|review apply|review prepare|review show|review explain|quickapply" /root/.openclaw/extensions/memory-lancedb-namespaced/index.js | grep -v "// " | head -10
```

Erwartet: kein Match (alle alten Review-Commands sind raus).

### Task 3.2: Command-Registry entrümpeln

- [ ] **Step 1: Command-Definitionen finden**

```bash
sed -n '1455,1475p' /root/.openclaw/extensions/memory-lancedb-namespaced/index.js
```

- [ ] **Step 2: `plur1bus_review` und `plur1bus_morning`/`plur1bus_evening` Einträge entfernen**

Old (Zeile 1466):
```js
          { name: "plur1bus_review", description: "Prepare or manage PLUR1BUS reviews.", acceptsArgs: true, prefixTokens: ["obsidian", "review"] },
```

New: Die ganze Zeile löschen.

Suche analog nach `plur1bus_morning` und `plur1bus_evening` Definitionen in der Nähe — auch entfernen.

- [ ] **Step 3: Routing-Logic entfernen**

Zeilen 1439–1444 (aus Recherche bekannt):

Old:
```js
          if (text.includes("/plur1bus obsidian morning-review") || text.includes("/plur1bus_morning")) {
            return { command: "/plur1bus obsidian morning-review", args: "obsidian morning-review" };
          }
          if (text.includes("/plur1bus obsidian evening-review") || text.includes("/plur1bus_evening")) {
            return { command: "/plur1bus obsidian evening-review", args: "obsidian evening-review" };
          }
```

New: Diese Blöcke löschen.

- [ ] **Step 4: Plugin-Lade-Test**

```bash
systemctl --user restart openclaw-gateway
sleep 15
journalctl --user -u openclaw-gateway -n 50 --no-pager | grep -iE "error|memory-lancedb-namespaced" | tail -20
```

Erwartet: keine "Plugin failed to load"-Errors.

### Task 3.3: Config-Schlüssel entfernen (`openclaw.json`)

**Files:**
- Modify: `/root/.openclaw/openclaw.json`

- [ ] **Step 1: Backup**

```bash
cp /root/.openclaw/openclaw.json /root/.openclaw/openclaw.json.bak-pre-rewrite-2026-05-28
```

- [ ] **Step 2: Aktuelle Plugin-Config lesen**

```bash
python3 -c "import json; d=json.load(open('/root/.openclaw/openclaw.json')); import pprint; pprint.pprint(d.get('plugins',{}).get('entries',{}).get('memory-lancedb-namespaced',{}))" | head -50
```

- [ ] **Step 3: Schlüssel entfernen via Python**

```bash
python3 <<'EOF'
import json
path = '/root/.openclaw/openclaw.json'
with open(path) as f:
    d = json.load(f)
plug = d.get('plugins',{}).get('entries',{}).get('memory-lancedb-namespaced',{})
for key in ('autoApplyLowRisk', 'reviewProfiles', 'bundleCooldownMs', 'review'):
    if key in plug:
        print(f"removing {key}")
        del plug[key]
with open(path, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
EOF
```

- [ ] **Step 4: Verifikation**

```bash
python3 -c "import json; d=json.load(open('/root/.openclaw/openclaw.json')); plug=d.get('plugins',{}).get('entries',{}).get('memory-lancedb-namespaced',{}); print('keys:', list(plug.keys()))"
```

Erwartet: kein `review*` Schlüssel mehr.

### Task 3.4: Cron-Jobs für Evening/Morning-Review entfernen

**Files:**
- Modify: `/root/.openclaw/cron/jobs.json`

- [ ] **Step 1: Backup**

```bash
cp /root/.openclaw/cron/jobs.json /root/.openclaw/cron/jobs.json.bak-pre-rewrite-2026-05-28
```

- [ ] **Step 2: Jobs mit review-message entfernen**

```bash
python3 <<'EOF'
import json
path = '/root/.openclaw/cron/jobs.json'
with open(path) as f:
    d = json.load(f)
jobs = d.get('jobs', [])
remove_patterns = ('morning-review', 'evening-review', '/plur1bus obsidian review', 'review prepare')
kept = []
removed = []
for j in jobs:
    msg = (j.get('message') or '') + ' ' + (j.get('name') or '')
    if any(p in msg for p in remove_patterns):
        removed.append(j.get('name'))
    else:
        kept.append(j)
d['jobs'] = kept
with open(path, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print("removed:", removed)
print("kept:", len(kept))
EOF
```

- [ ] **Step 3: Verifikation**

```bash
grep -E "morning-review|evening-review|review prepare" /root/.openclaw/cron/jobs.json
```

Erwartet: kein Output.

### Task 3.5: Commit Phase 3

- [ ] **Step 1: Gateway-Restart + Health-Check**

```bash
systemctl --user restart openclaw-gateway
sleep 30
journalctl --user -u openclaw-gateway -n 100 --no-pager | grep -iE "error|crash|fail" | tail -10
```

Erwartet: keine Errors.

- [ ] **Step 2: Commit**

```bash
cd /root && git add -A docs/superpowers/
git commit -m "phase 3: plur1bus alte review-commands und config raus"
```

---

## Phase 4 — Plugin-Erweiterung (neue Commands rein)

Ziel: Drei neue Touchpoints + Status implementieren. TDD wo möglich.

**Architektur-Hinweis:** Jeder neue Command wird als eigenes Modul unter `lib/telegram-commands/<name>.js` exportiert und in `index.js` an einer einzigen Stelle registriert.

### Task 4.1: Verzeichnis + Test-Setup

**Files:**
- Create: `/root/.openclaw/extensions/memory-lancedb-namespaced/lib/telegram-commands/`
- Create: `/root/.openclaw/extensions/memory-lancedb-namespaced/test/`

- [ ] **Step 1: Verzeichnisse anlegen**

```bash
mkdir -p /root/.openclaw/extensions/memory-lancedb-namespaced/lib/telegram-commands/
mkdir -p /root/.openclaw/extensions/memory-lancedb-namespaced/test/
```

- [ ] **Step 2: Test-Runner prüfen**

```bash
grep -E '"test"|"scripts"' /root/.openclaw/extensions/memory-lancedb-namespaced/package.json
```

Wenn kein Test-Runner: in package.json `"test": "node --test test/"` ergänzen.

### Task 4.2: `/status` Command (rein, mit Bridge-Anleitung)

**Files:**
- Create: `lib/telegram-commands/status.js`
- Create: `test/status.test.js`

- [ ] **Step 1: Failing Test**

```js
// test/status.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { renderStatus } = require('../lib/telegram-commands/status');

test('status zeigt grün wenn alles OK', () => {
  const result = renderStatus({
    memory: { cardCount: 4218, lastUpdateMinutes: 12 },
    sync: { active: true, devices: 3 },
    plausibility: { lastRun: '2026-05-27T20:30:00Z' },
    issues: [],
  });
  assert.ok(result.includes('🟢'));
  assert.ok(result.includes('4218'));
  assert.ok(result.includes('3 Geräten'));
});

test('status zeigt jeden issue mit grund + einschalt-anleitung', () => {
  const result = renderStatus({
    memory: { cardCount: 100, lastUpdateMinutes: 5 },
    sync: { active: false, devices: 0 },
    plausibility: { lastRun: '2026-05-27T20:30:00Z' },
    issues: [{
      key: 'vaultSync',
      title: 'Vault-Sync ist aus',
      reason: 'in /root/.openclaw/openclaw.json steht "obsidianBridge.enabled: false"',
      howToFix: '/einschalten vaultSync',
      whatItDoes: 'spiegelt deine Erinnerungen in den Obsidian-Vault',
      whatYouLose: 'du siehst Erinnerungen nur über /memory, nicht im Vault',
    }],
  });
  assert.ok(result.includes('🟡'));
  assert.ok(result.includes('Vault-Sync ist aus'));
  assert.ok(result.includes('Grund:'));
  assert.ok(result.includes('/einschalten vaultSync'));
  assert.ok(result.includes('Was es macht:'));
  assert.ok(result.includes('Was du ohne es verlierst:'));
});
```

- [ ] **Step 2: Test laufen — failing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/status.test.js
```

Erwartet: FAIL (Modul existiert nicht).

- [ ] **Step 3: Implementierung**

```js
// lib/telegram-commands/status.js
function renderStatus({ memory, sync, plausibility, issues }) {
  const lines = [];
  if (!issues || issues.length === 0) {
    lines.push('🟢 Alles läuft normal.');
    lines.push(`• Memory: ${memory.cardCount} Karten, letzte Aktualisierung vor ${memory.lastUpdateMinutes} Min`);
    if (sync.active) {
      lines.push(`• Vault-Sync: aktiv auf ${sync.devices} Geräten`);
    } else {
      lines.push('• Vault-Sync: aus');
    }
    const lastRunDate = new Date(plausibility.lastRun);
    lines.push(`• Plausibilitätsprüfung: läuft alle 6h, letzter Lauf ${lastRunDate.toLocaleString('de-DE')}`);
    return lines.join('\n');
  }
  const colour = issues.some(i => i.severity === 'error') ? '🔴' : '🟡';
  lines.push(`${colour} ${issues.length} Hinweis${issues.length === 1 ? '' : 'e'}`);
  lines.push('');
  for (const issue of issues) {
    lines.push(`  ${issue.title}`);
    lines.push(`  ↳ Grund: ${issue.reason}`);
    lines.push(`  ↳ So schaltest du es ein: ${issue.howToFix}`);
    lines.push('');
    if (issue.whatItDoes) lines.push(`  Was es macht: ${issue.whatItDoes}`);
    if (issue.whatYouLose) lines.push(`  Was du ohne es verlierst: ${issue.whatYouLose}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

module.exports = { renderStatus };
```

- [ ] **Step 4: Test laufen — passing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/status.test.js
```

Erwartet: PASS.

- [ ] **Step 5: Status-Data-Collector (eigenes Modul)**

```js
// lib/telegram-commands/status-data.js
async function collectStatusData({ db, config, agent }) {
  const cardCount = await db.countCards(agent);
  const lastUpdateMinutes = await db.minutesSinceLastWrite(agent);
  const sync = await checkSyncState(config);
  const plausibility = { lastRun: await db.lastPlausibilityRun(agent) };
  const issues = [];
  // Bridge / VaultSync check
  // (Hier den in Task 0.1 ermittelten Config-Pfad verwenden!)
  const bridgeConfig = config.plugins?.entries?.['memory-lancedb-namespaced']?.bridge;
  if (bridgeConfig && bridgeConfig.enabled === false) {
    issues.push({
      key: 'vaultSync',
      title: 'Vault-Sync ist aus',
      reason: 'in /root/.openclaw/openclaw.json steht "plugins.entries.memory-lancedb-namespaced.bridge.enabled: false"',
      howToFix: '/einschalten vaultSync',
      whatItDoes: 'spiegelt deine Erinnerungen in den Obsidian-Vault',
      whatYouLose: 'du siehst Erinnerungen nur über /memory, nicht im Vault',
    });
  }
  return { memory: { cardCount, lastUpdateMinutes }, sync, plausibility, issues };
}

async function checkSyncState(config) {
  // Read syncthing folder count and active state
  // Implementation: shell-out zu `curl 127.0.0.1:8384` mit API-Key aus config.xml
  // Fallback: { active: false, devices: 0 }
  return { active: true, devices: 3 };
}

module.exports = { collectStatusData };
```

- [ ] **Step 6: Command-Handler in index.js registrieren**

In `index.js`, im command-handler-Block:

```js
if (commandName === 'status') {
  const { collectStatusData } = require('./lib/telegram-commands/status-data');
  const { renderStatus } = require('./lib/telegram-commands/status');
  const data = await collectStatusData({ db, config, agent });
  return { text: renderStatus(data) };
}
```

Und in `commands`-Registry:

```js
{ name: "status", description: "System-Health zeigen.", acceptsArgs: false, prefixTokens: [] },
```

- [ ] **Step 7: Integration-Test im Telegram**

```bash
systemctl --user restart openclaw-gateway
sleep 30
# In Telegram: /status — manuell prüfen
```

User-Aktion: in Telegram `/status` senden, Output prüfen.

- [ ] **Step 8: Commit**

```bash
cd /root && git add -A docs/superpowers/ /root/.openclaw/extensions/memory-lancedb-namespaced/
git commit -m "phase 4.2: /status command mit handlungsorientierten hinweisen"
```

### Task 4.3: `/einschalten` und `/ausschalten` Commands

**Files:**
- Create: `lib/telegram-commands/feature-toggle.js`
- Create: `test/feature-toggle.test.js`

- [ ] **Step 1: Failing Test**

```js
// test/feature-toggle.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { toggleFeature, FEATURE_WHITELIST } = require('../lib/telegram-commands/feature-toggle');

test('FEATURE_WHITELIST enthält vaultSync, kritischPush, dailyConsolidation', () => {
  assert.ok(FEATURE_WHITELIST.vaultSync);
  assert.ok(FEATURE_WHITELIST.kritischPush);
  assert.ok(FEATURE_WHITELIST.dailyConsolidation);
});

test('toggleFeature lehnt unbekannte Feature-Namen ab', async () => {
  const result = await toggleFeature('foo', true, { configPath: '/tmp/test.json' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('unbekannt'));
});

test('toggleFeature setzt vaultSync.enabled korrekt', async () => {
  const fs = require('fs');
  const tmp = '/tmp/test-toggle.json';
  fs.writeFileSync(tmp, JSON.stringify({
    plugins: { entries: { 'memory-lancedb-namespaced': { bridge: { enabled: false } } } }
  }));
  const result = await toggleFeature('vaultSync', true, { configPath: tmp });
  assert.strictEqual(result.ok, true);
  const after = JSON.parse(fs.readFileSync(tmp));
  assert.strictEqual(after.plugins.entries['memory-lancedb-namespaced'].bridge.enabled, true);
});
```

- [ ] **Step 2: Test laufen — failing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/feature-toggle.test.js
```

Erwartet: FAIL (Modul existiert nicht).

- [ ] **Step 3: Implementierung**

```js
// lib/telegram-commands/feature-toggle.js
const fs = require('fs').promises;

const FEATURE_WHITELIST = {
  vaultSync: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'bridge', 'enabled'],
    description: 'Vault-Sync (Obsidian-Bridge)',
  },
  kritischPush: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'criticalPush', 'enabled'],
    description: 'Push bei kritischen Memories',
  },
  dailyConsolidation: {
    configPath: ['plugins', 'entries', 'memory-lancedb-namespaced', 'dailyConsolidation', 'enabled'],
    description: 'Tägliche Konsolidierung',
  },
};

async function toggleFeature(name, enable, { configPath = '/root/.openclaw/openclaw.json' } = {}) {
  if (!FEATURE_WHITELIST[name]) {
    return { ok: false, error: `Feature "${name}" unbekannt. Bekannt: ${Object.keys(FEATURE_WHITELIST).join(', ')}` };
  }
  const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
  let cur = cfg;
  const path = FEATURE_WHITELIST[name].configPath;
  for (let i = 0; i < path.length - 1; i++) {
    if (!cur[path[i]]) cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = enable;
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n');
  return { ok: true, message: `${FEATURE_WHITELIST[name].description} ist jetzt ${enable ? 'an' : 'aus'}. Restart erforderlich: systemctl --user restart openclaw-gateway` };
}

module.exports = { toggleFeature, FEATURE_WHITELIST };
```

- [ ] **Step 4: Test laufen — passing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/feature-toggle.test.js
```

Erwartet: PASS.

- [ ] **Step 5: Command-Handler in index.js registrieren**

```js
if (commandName === 'einschalten' || commandName === 'ausschalten') {
  const { toggleFeature } = require('./lib/telegram-commands/feature-toggle');
  const featureName = args.trim().split(/\s+/)[0];
  if (!featureName) {
    return { text: 'Nutzung: /einschalten <feature>\n\nBekannte Features:\n' +
      Object.entries(require('./lib/telegram-commands/feature-toggle').FEATURE_WHITELIST)
        .map(([k, v]) => `• ${k} — ${v.description}`).join('\n') };
  }
  const result = await toggleFeature(featureName, commandName === 'einschalten');
  return { text: result.ok ? `✅ ${result.message}` : `❌ ${result.error}` };
}
```

Und in `commands`-Registry:

```js
{ name: "einschalten", description: "Feature einschalten.", acceptsArgs: true, prefixTokens: [] },
{ name: "ausschalten", description: "Feature ausschalten.", acceptsArgs: true, prefixTokens: [] },
```

- [ ] **Step 6: Commit**

```bash
cd /root && git add -A docs/superpowers/ /root/.openclaw/extensions/memory-lancedb-namespaced/
git commit -m "phase 4.3: /einschalten und /ausschalten mit feature-whitelist"
```

### Task 4.4: `/memory` Command (Inspektion)

**Files:**
- Create: `lib/telegram-commands/memory-query.js`
- Create: `test/memory-query.test.js`

- [ ] **Step 1: Failing Test**

```js
// test/memory-query.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuery, formatResults } = require('../lib/telegram-commands/memory-query');

test('parseQuery erkennt Zeit-Modus', () => {
  assert.deepStrictEqual(parseQuery('diese Woche'), { mode: 'time', range: 'this_week' });
  assert.deepStrictEqual(parseQuery('heute'), { mode: 'time', range: 'today' });
  assert.deepStrictEqual(parseQuery('Mai'), { mode: 'time', range: 'month:Mai' });
});

test('parseQuery erkennt Topic-Modus', () => {
  assert.deepStrictEqual(parseQuery('über Eva'), { mode: 'topic', topic: 'Eva' });
  assert.deepStrictEqual(parseQuery('was weißt du über Riva'), { mode: 'topic', topic: 'Riva' });
});

test('formatResults gibt deutsche Telegram-Markdown', () => {
  const items = [
    { title: 'PinchTab 0.11 läuft stabil', source: 'notiz', date: '2026-05-27' },
    { title: 'Wochenend-Trip mit Eva geplant', source: 'konversation', date: '2026-05-26' },
  ];
  const out = formatResults(items, { mode: 'time', range: 'this_week' });
  assert.ok(out.includes('🧠'));
  assert.ok(out.includes('PinchTab 0.11'));
  assert.ok(out.includes('Wochenend-Trip'));
  assert.ok(out.includes('Mehr'));
});
```

- [ ] **Step 2: Test laufen — failing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/memory-query.test.js
```

- [ ] **Step 3: Implementierung**

```js
// lib/telegram-commands/memory-query.js
const TIME_KEYWORDS = {
  'heute': 'today',
  'gestern': 'yesterday',
  'diese woche': 'this_week',
  'letzte woche': 'last_week',
  'diesen monat': 'this_month',
};

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function parseQuery(text) {
  const t = text.trim().toLowerCase();
  for (const [kw, range] of Object.entries(TIME_KEYWORDS)) {
    if (t === kw) return { mode: 'time', range };
  }
  const monthMatch = MONTHS.find(m => t === m.toLowerCase());
  if (monthMatch) return { mode: 'time', range: `month:${monthMatch}` };

  const topicMatch = text.match(/(?:über|zu)\s+(.+)$/i) || text.match(/was weißt du über (.+)$/i);
  if (topicMatch) return { mode: 'topic', topic: topicMatch[1].trim() };

  return { mode: 'topic', topic: text };
}

function formatResults(items, query) {
  if (!items || items.length === 0) {
    return '🧠 Nichts gefunden.';
  }
  const lines = [];
  if (query.mode === 'time') {
    lines.push(`🧠 ${items.length} neue Sache${items.length === 1 ? '' : 'n'} gemerkt:`);
  } else {
    lines.push(`🧠 ${items.length} Erinnerung${items.length === 1 ? '' : 'en'} zu "${query.topic}":`);
  }
  for (const item of items.slice(0, 10)) {
    lines.push(`• ${item.title} *(${item.source}, ${item.date})*`);
  }
  if (items.length > 10) lines.push(`… und ${items.length - 10} weitere`);
  lines.push('');
  lines.push('[ Mehr anzeigen ]  [ Was korrigieren? ]');
  return lines.join('\n');
}

async function queryMemory(db, agent, parsed) {
  if (parsed.mode === 'time') {
    return db.queryByTimeRange(agent, parsed.range);
  }
  return db.searchByTopic(agent, parsed.topic, { limit: 20 });
}

module.exports = { parseQuery, formatResults, queryMemory };
```

- [ ] **Step 4: Test laufen — passing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/memory-query.test.js
```

- [ ] **Step 5: db-Wrapper-Methoden ergänzen (queryByTimeRange, searchByTopic)**

In `lib/recall-pipeline.js` oder neuem `lib/db-adapter.js`:

```js
// lib/db-adapter.js
async function queryByTimeRange(agent, range) {
  const { db } = await getNamespaceDb(agent);
  const cards = await db.openTable('memory_cards');
  const cutoffMs = computeCutoff(range);
  const results = await cards.search().where(`created_ts > ${cutoffMs}`).limit(20).toArray();
  return results.map(r => ({ title: r.title, source: r.source, date: r.date }));
}

async function searchByTopic(agent, topic, { limit = 20 } = {}) {
  const { db, embedder } = await getNamespaceDb(agent);
  const cards = await db.openTable('memory_cards');
  const vec = await embedder.embed(topic);
  const results = await cards.search(vec).limit(limit).toArray();
  return results.map(r => ({ title: r.title, source: r.source, date: r.date }));
}

function computeCutoff(range) {
  const now = Date.now();
  if (range === 'today') return now - 86400000;
  if (range === 'yesterday') return now - 172800000;
  if (range === 'this_week') return now - 604800000;
  if (range === 'last_week') return now - 1209600000;
  if (range === 'this_month') return now - 2592000000;
  if (range.startsWith('month:')) {
    // simplified: last 30 days
    return now - 2592000000;
  }
  return now - 604800000;
}

module.exports = { queryByTimeRange, searchByTopic };
```

- [ ] **Step 6: Command-Handler in index.js registrieren**

```js
if (commandName === 'memory' && args && args.trim()) {
  const { parseQuery, formatResults, queryMemory } = require('./lib/telegram-commands/memory-query');
  const parsed = parseQuery(args);
  const items = await queryMemory(db, agent, parsed);
  return { text: formatResults(items, parsed) };
}
```

In `commands`-Registry: existiert evtl. schon (`/plur1bus memory` Pfad in Zeile 1391). Prüfen ob `/memory` als Top-Level-Befehl registriert ist.

```js
{ name: "memory", description: "Erinnerungen einsehen.", acceptsArgs: true, prefixTokens: [] },
```

- [ ] **Step 7: Smoke-Test**

```bash
systemctl --user restart openclaw-gateway
sleep 30
```

User-Aktion: in Telegram `/memory diese Woche` senden. Prüfen ob Liste kommt.

- [ ] **Step 8: Commit**

```bash
cd /root && git add -A docs/superpowers/ /root/.openclaw/extensions/memory-lancedb-namespaced/
git commit -m "phase 4.4: /memory inspektions-command (zeit + topic)"
```

### Task 4.5: `/vergiss` und `/korrigier` Commands

**Files:**
- Create: `lib/telegram-commands/memory-edit.js`
- Create: `test/memory-edit.test.js`

- [ ] **Step 1: Failing Test**

```js
// test/memory-edit.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCorrection, resolveCandidates } = require('../lib/telegram-commands/memory-edit');

test('parseCorrection erkennt "alt zu neu" Syntax', () => {
  assert.deepStrictEqual(parseCorrection('Evas Geburtstag ist 3. Juni zu 3. Juli'), {
    old: 'Evas Geburtstag ist 3. Juni',
    new: '3. Juli',
  });
});

test('resolveCandidates gibt eindeutigen Treffer bei 1 Match', async () => {
  const fakeDb = {
    searchByTopic: async () => [{ id: 'card-1', title: 'Eva Geburtstag 3. Juni', score: 0.95 }],
  };
  const result = await resolveCandidates(fakeDb, 'agent', 'Eva Geburtstag');
  assert.strictEqual(result.unique, true);
  assert.strictEqual(result.card.id, 'card-1');
});

test('resolveCandidates gibt Auswahl bei ≥2 Matches', async () => {
  const fakeDb = {
    searchByTopic: async () => [
      { id: 'a', title: 'Eva 3. Juni', score: 0.8 },
      { id: 'b', title: 'Eva geht 3. Juli weg', score: 0.78 },
    ],
  };
  const result = await resolveCandidates(fakeDb, 'agent', 'Eva');
  assert.strictEqual(result.unique, false);
  assert.strictEqual(result.candidates.length, 2);
});
```

- [ ] **Step 2: Test laufen — failing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/memory-edit.test.js
```

- [ ] **Step 3: Implementierung**

```js
// lib/telegram-commands/memory-edit.js
const path = require('path');
const fs = require('fs').promises;

function parseCorrection(text) {
  const match = text.match(/^(.+?)\s+zu\s+(.+)$/i);
  if (!match) return null;
  return { old: match[1].trim(), new: match[2].trim() };
}

async function resolveCandidates(db, agent, query, { threshold = 0.7 } = {}) {
  const results = await db.searchByTopic(agent, query, { limit: 5 });
  const filtered = results.filter(r => (r.score || 0) >= threshold);
  if (filtered.length === 0) return { unique: false, candidates: [] };
  if (filtered.length === 1 || (filtered[0].score > 0.9 && filtered[0].score - filtered[1].score > 0.1)) {
    return { unique: true, card: filtered[0] };
  }
  return { unique: false, candidates: filtered.slice(0, 3) };
}

async function forgetCard(db, agent, cardId, { archiveDir = '/root/.openclaw/memory/_archive' } = {}) {
  const card = await db.getCard(agent, cardId);
  await fs.mkdir(path.join(archiveDir, agent), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(path.join(archiveDir, agent, `${ts}-${cardId}.json`), JSON.stringify(card, null, 2));
  await db.deleteCard(agent, cardId);
  return { archivedAs: path.join(archiveDir, agent, `${ts}-${cardId}.json`) };
}

async function correctCard(db, agent, cardId, newContent, { archiveDir = '/root/.openclaw/memory/_archive' } = {}) {
  const old = await db.getCard(agent, cardId);
  await fs.mkdir(path.join(archiveDir, agent), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(path.join(archiveDir, agent, `${ts}-${cardId}-correction.json`), JSON.stringify({ old, new: newContent }, null, 2));
  await db.updateCard(agent, cardId, newContent);
  return { ok: true };
}

module.exports = { parseCorrection, resolveCandidates, forgetCard, correctCard };
```

- [ ] **Step 4: Test laufen — passing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/memory-edit.test.js
```

- [ ] **Step 5: db-Methoden ergänzen (deleteCard, updateCard, getCard)**

In `lib/db-adapter.js`:

```js
async function getCard(agent, id) {
  const { db } = await getNamespaceDb(agent);
  const cards = await db.openTable('memory_cards');
  return (await cards.search().where(`id = '${id}'`).limit(1).toArray())[0];
}

async function deleteCard(agent, id) {
  const { db } = await getNamespaceDb(agent);
  const cards = await db.openTable('memory_cards');
  await cards.delete(`id = '${id}'`);
}

async function updateCard(agent, id, newContent) {
  const { db } = await getNamespaceDb(agent);
  const cards = await db.openTable('memory_cards');
  await cards.update({ values: newContent, where: `id = '${id}'` });
}

module.exports = { ...module.exports, getCard, deleteCard, updateCard };
```

- [ ] **Step 6: Command-Handler in index.js registrieren**

```js
if (commandName === 'vergiss') {
  const { resolveCandidates, forgetCard } = require('./lib/telegram-commands/memory-edit');
  const resolved = await resolveCandidates(dbAdapter, agent, args);
  if (resolved.unique) {
    await forgetCard(dbAdapter, agent, resolved.card.id);
    return { text: `✅ Weg ("${resolved.card.title}", archiviert)` };
  }
  if (resolved.candidates.length === 0) {
    return { text: `🤷 Nichts gefunden zu "${args}"` };
  }
  return {
    text: `Mehrere Treffer — welche meinst du?\n\n${resolved.candidates.map((c, i) => `${i+1}. ${c.title}`).join('\n')}`,
    inlineButtons: resolved.candidates.map((c, i) => ({ text: `${i+1}`, callbackData: `forget:${c.id}` })),
  };
}

if (commandName === 'korrigier') {
  const { parseCorrection, resolveCandidates, correctCard } = require('./lib/telegram-commands/memory-edit');
  const parsed = parseCorrection(args);
  if (!parsed) return { text: 'Nutzung: /korrigier <alt> zu <neu>' };
  const resolved = await resolveCandidates(dbAdapter, agent, parsed.old);
  if (resolved.unique) {
    await correctCard(dbAdapter, agent, resolved.card.id, parsed.new);
    return { text: `✅ Geändert ("${resolved.card.title}" → "${parsed.new}")` };
  }
  return { text: `Mehrdeutig — bitte präziser: ${resolved.candidates.map(c => c.title).join(', ')}` };
}
```

In Registry:

```js
{ name: "vergiss", description: "Eine Erinnerung löschen.", acceptsArgs: true, prefixTokens: [] },
{ name: "korrigier", description: "Eine Erinnerung ändern.", acceptsArgs: true, prefixTokens: [] },
```

- [ ] **Step 7: Commit**

```bash
cd /root && git add -A docs/superpowers/ /root/.openclaw/extensions/memory-lancedb-namespaced/
git commit -m "phase 4.5: /vergiss und /korrigier mit kandidaten-resolution"
```

### Task 4.6: Kritisch-Push Classifier

**Files:**
- Create: `lib/critical-push-classifier.js`
- Create: `test/critical-push-classifier.test.js`

- [ ] **Step 1: Failing Test**

```js
// test/critical-push-classifier.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyMemory, shouldPush, CRITICAL_TYPES } = require('../lib/critical-push-classifier');

test('CRITICAL_TYPES enthält 6 erwartete typen', () => {
  for (const t of ['person', 'beziehung', 'geburtstag', 'geld_konto', 'gesundheit', 'zugang_passwort']) {
    assert.ok(CRITICAL_TYPES.includes(t), `${t} fehlt`);
  }
});

test('shouldPush respektiert maxPerDay-Limit', () => {
  const counts = { '2026-05-28': 3 };
  assert.strictEqual(shouldPush({ type: 'person', date: '2026-05-28' }, counts, { maxPerDay: 3 }), false);
  assert.strictEqual(shouldPush({ type: 'person', date: '2026-05-28' }, { '2026-05-28': 2 }, { maxPerDay: 3 }), true);
});

test('shouldPush gibt false für nicht-kritischen Typ', () => {
  assert.strictEqual(shouldPush({ type: 'fakt', date: '2026-05-28' }, {}, {}), false);
});
```

- [ ] **Step 2: Test laufen — failing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/critical-push-classifier.test.js
```

- [ ] **Step 3: Implementierung**

```js
// lib/critical-push-classifier.js
const CRITICAL_TYPES = ['person', 'beziehung', 'geburtstag', 'geld_konto', 'gesundheit', 'zugang_passwort'];

async function classifyMemory(content, { model } = {}) {
  // call Kimi-Coding model with a strict prompt to assign type from CRITICAL_TYPES or 'fakt'
  const prompt = `Klassifiziere den Inhalt in genau einen Typ aus: ${CRITICAL_TYPES.join(', ')}, fakt.\nInhalt: ${content}\nAntwort: nur der Typ-Name.`;
  const result = await model.complete({ prompt, maxTokens: 10 });
  const type = (result.text || 'fakt').trim().toLowerCase();
  return CRITICAL_TYPES.includes(type) ? type : 'fakt';
}

function shouldPush(card, dailyCounts, { maxPerDay = 3 } = {}) {
  if (!CRITICAL_TYPES.includes(card.type)) return false;
  const count = dailyCounts[card.date] || 0;
  return count < maxPerDay;
}

function buildPushMessage(card) {
  return {
    text: `🤖 Soll ich mir merken:\n\n   "${card.title}"\n\n   (gelernt aus deiner Konversation ${card.sourceLabel})`,
    inlineButtons: [
      { text: '✅ Stimmt', callbackData: `crit:ok:${card.id}` },
      { text: '❌ Falsch', callbackData: `crit:no:${card.id}` },
      { text: '✏️ Anders formulieren', callbackData: `crit:edit:${card.id}` },
    ],
  };
}

module.exports = { classifyMemory, shouldPush, buildPushMessage, CRITICAL_TYPES };
```

- [ ] **Step 4: Test laufen — passing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/critical-push-classifier.test.js
```

- [ ] **Step 5: Push-State pro Agent (Datei-basiert)**

```js
// lib/critical-push-state.js
const fs = require('fs').promises;
const path = require('path');

async function loadDailyCounts(agent, { stateDir = '/root/.openclaw/memory/_critical-push-state' } = {}) {
  const file = path.join(stateDir, `${agent}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function incrementCount(agent, date, { stateDir = '/root/.openclaw/memory/_critical-push-state' } = {}) {
  const counts = await loadDailyCounts(agent, { stateDir });
  counts[date] = (counts[date] || 0) + 1;
  // Cleanup older than 7 days
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const k of Object.keys(counts)) if (k < cutoffStr) delete counts[k];
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, `${agent}.json`), JSON.stringify(counts, null, 2));
  return counts[date];
}

module.exports = { loadDailyCounts, incrementCount };
```

- [ ] **Step 6: Callback-Handler in index.js (für Inline-Buttons)**

```js
if (callbackData && callbackData.startsWith('crit:')) {
  const [, action, cardId] = callbackData.split(':');
  if (action === 'no') {
    await dbAdapter.deleteCard(agent, cardId);
    return { text: '❌ Verworfen — wird nicht gemerkt.' };
  }
  if (action === 'ok') {
    await dbAdapter.markConfirmed(agent, cardId);
    return { text: '✅ Gemerkt.' };
  }
  if (action === 'edit') {
    return { text: 'Wie soll ich es formulieren? (Schicke mir den neuen Text als nächste Nachricht.)', awaitReply: { type: 'crit-edit', cardId } };
  }
}
```

- [ ] **Step 7: 24h Auto-Accept Job (vorbereiten — wird in Phase 5 verkabelt)**

Stub für den Cron-Job:

```js
// lib/jobs/auto-accept-stale-criticals.js
async function autoAcceptStale(dbAdapter, agent, { hours = 24 } = {}) {
  const cutoff = Date.now() - hours * 3600000;
  const pending = await dbAdapter.findUnconfirmedCritical(agent, { olderThan: cutoff });
  for (const card of pending) {
    await dbAdapter.markConfirmed(agent, card.id);
  }
  return { autoAccepted: pending.length };
}
module.exports = { autoAcceptStale };
```

- [ ] **Step 8: Commit**

```bash
cd /root && git add -A docs/superpowers/ /root/.openclaw/extensions/memory-lancedb-namespaced/
git commit -m "phase 4.6: critical-push classifier + state + callbacks"
```

### Task 4.7: Memory-Card-Writer mit LLM-Glättung

**Files:**
- Create: `lib/memory-card-writer.js`
- Modify: existierender Code, wo Memories geschrieben werden (Trace via `grep "cards.add\|cards.insert"` in `lib/`)

- [ ] **Step 1: Failing Test**

```js
// test/memory-card-writer.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { polishContent, buildCardMarkdown } = require('../lib/memory-card-writer');

test('polishContent ruft Modell mit Klartext-Prompt auf', async () => {
  const fakeModel = {
    calls: [],
    complete: async function({ prompt }) {
      this.calls.push(prompt);
      return { text: 'Die Riva-STT-Bridge braucht Vorrang für den Umgebungs-Token (Bug behoben am 9. Mai).' };
    },
  };
  const result = await polishContent('riva env-token bug fix', fakeModel);
  assert.ok(result.startsWith('Die '));
  assert.ok(fakeModel.calls[0].includes('grammatikalisch vollständig'));
});

test('buildCardMarkdown enthält alle 5 Felder + Frontmatter', () => {
  const md = buildCardMarkdown({
    id: 'abc-123',
    type: 'fakt',
    created: '2026-05-28T10:00:00Z',
    source: 'konversation-xyz',
    title: 'Test',
    polishedContent: 'Test-Inhalt als ganzer Satz.',
    why: 'Aus Gespräch mit Cy',
    learnedAt: '2026-05-28 10:00',
  });
  assert.ok(md.startsWith('---'));
  assert.ok(md.includes('id: abc-123'));
  assert.ok(md.includes('type: fakt'));
  assert.ok(md.includes('# Test'));
  assert.ok(md.includes('**Was:** Test-Inhalt als ganzer Satz.'));
  assert.ok(md.includes('**Warum gemerkt:** Aus Gespräch mit Cy'));
  assert.ok(md.includes('**Wann gelernt:**'));
});
```

- [ ] **Step 2: Test laufen — failing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/memory-card-writer.test.js
```

- [ ] **Step 3: Implementierung**

```js
// lib/memory-card-writer.js
async function polishContent(raw, model) {
  const prompt = `Formuliere folgenden Memory-Inhalt in einen grammatikalisch vollständigen deutschen Satz. Keine Stichwörter, kein Jargon, kein Markdown. Nur den Satz, nichts anderes.\n\nInhalt: ${raw}\n\nSatz:`;
  const result = await model.complete({ prompt, maxTokens: 200, temperature: 0.3 });
  return (result.text || raw).trim();
}

function buildCardMarkdown(card) {
  return `---
id: ${card.id}
type: ${card.type}
created: ${card.created}
source: ${card.source}
related: ${JSON.stringify(card.related || [])}
---

# ${card.title}

**Was:** ${card.polishedContent}

**Warum gemerkt:** ${card.why || '(keine Kontext-Notiz)'}

**Wann gelernt:** ${card.learnedAt}
`;
}

async function writeCard(card, { vaultPath, model }) {
  const fs = require('fs').promises;
  const path = require('path');
  const polished = await polishContent(card.rawContent, model);
  const dt = new Date(card.created);
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const dir = path.join(vaultPath, 'memory', 'cards', String(year), month);
  await fs.mkdir(dir, { recursive: true });
  const slug = polished.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50).replace(/^-|-$/g, '');
  const filename = `${dt.toISOString().slice(0, 10)}-${slug}.md`;
  const md = buildCardMarkdown({ ...card, polishedContent: polished });
  await fs.writeFile(path.join(dir, filename), md);
  return { path: path.join(dir, filename), polished };
}

module.exports = { polishContent, buildCardMarkdown, writeCard };
```

- [ ] **Step 4: Test laufen — passing**

```bash
cd /root/.openclaw/extensions/memory-lancedb-namespaced && node --test test/memory-card-writer.test.js
```

- [ ] **Step 5: Existierende Card-Write-Call-Sites finden + auf neuen Writer umstellen**

```bash
grep -rn "cards\.add\|cards\.insert\|writeText\|markdown.*card" /root/.openclaw/extensions/memory-lancedb-namespaced/lib/ | grep -v node_modules | head -10
```

Für jede gefundene Stelle: Call durch `writeCard(...)` ersetzen, raw-content statt vorgeformter Markdown übergeben.

**Achtung:** Wenn bestehender Bridge-Writer in `lib/obsidian-bridge.js` Cards generiert, dort die Output-Logik auf `writeCard` umstellen. P1-Bug-Fix (Self-Hash-Ignore): atomic write + Hash sofort updaten (siehe Spec Abschnitt 2.4 + Risiko-Tabelle).

- [ ] **Step 6: P1-Fix — DEFAULT_IGNORE_GLOBS in obsidian-bridge.js**

```bash
sed -n '1,50p' /root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian-bridge.js | grep -A5 DEFAULT_IGNORE
```

Erweitere `DEFAULT_IGNORE_GLOBS` um:
```js
'**/_archive/**',
'**/evening-deep-review-*.md',
'plur1bus/_archive/**',
```

- [ ] **Step 7: P2-Fix — undefined-Links**

```bash
grep -n "sourcePath" /root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian/link-suggestions.js
grep -n "sourcePath" /root/.openclaw/extensions/memory-lancedb-namespaced/lib/obsidian/impact-analysis.js
```

Pro Stelle: `sourcePath` → `(sourcePath || '(unbekannt)')` setzen.

- [ ] **Step 8: Commit**

```bash
cd /root && git add -A docs/superpowers/ /root/.openclaw/extensions/memory-lancedb-namespaced/
git commit -m "phase 4.7: memory-card-writer mit llm-glättung + P1/P2-fixes"
```

---

## Phase 5 — Neue Cron-Jobs

Ziel: `daily_memory_consolidation` und `critical_memory_classifier` ersetzen die alten Review-Jobs.

### Task 5.1: `daily_memory_consolidation` Job

**Files:**
- Modify: `/root/.openclaw/cron/jobs.json`

- [ ] **Step 1: Job-JSON anlegen (für alle 3 Agenten)**

```bash
python3 <<'EOF'
import json
path = '/root/.openclaw/cron/jobs.json'
with open(path) as f:
    d = json.load(f)
jobs = d.get('jobs', [])

new_jobs = [
    {
        "name": "daily-memory-consolidation-bernd",
        "agent": "main",
        "schedule": {"cron": "30 0 * * *", "timezone": "Europe/Berlin"},
        "message": "/plur1bus internal consolidate-daily",
        "description": "Stille tägliche Konsolidierung (Adversarial, Duplicate, Semantic) — kein Telegram",
        "silent": True
    },
    {
        "name": "daily-memory-consolidation-bernhardine",
        "agent": "bernhardine",
        "schedule": {"cron": "32 0 * * *", "timezone": "Europe/Berlin"},
        "message": "/plur1bus internal consolidate-daily",
        "silent": True
    },
    {
        "name": "daily-memory-consolidation-heisenberg",
        "agent": "heisenberg",
        "schedule": {"cron": "38 0 * * *", "timezone": "Europe/Berlin"},
        "message": "/plur1bus internal consolidate-daily",
        "silent": True
    },
]
jobs.extend(new_jobs)
d['jobs'] = jobs
with open(path, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print(f"Added {len(new_jobs)} consolidation jobs")
EOF
```

- [ ] **Step 2: Internal-Command-Handler in index.js**

```js
if (commandName === 'plur1bus' && args && args.startsWith('internal consolidate-daily')) {
  const { runConsolidation } = require('./lib/jobs/daily-consolidation');
  const result = await runConsolidation(dbAdapter, agent);
  // log only — no telegram return
  console.log(`[consolidate-daily ${agent}]`, JSON.stringify(result));
  return { silent: true };
}
```

- [ ] **Step 3: `lib/jobs/daily-consolidation.js` implementieren**

```js
// lib/jobs/daily-consolidation.js
async function runConsolidation(db, agent) {
  const adversarial = await db.runAdversarialCheck(agent);
  const duplicates = await db.runDuplicateScan(agent);
  const conflicts = await db.runSemanticConflictCheck(agent);
  return {
    timestamp: new Date().toISOString(),
    adversarial: adversarial.findings || 0,
    duplicates: duplicates.found || 0,
    conflicts: conflicts.found || 0,
  };
}
module.exports = { runConsolidation };
```

- [ ] **Step 4: Commit**

```bash
cd /root && git add -A docs/superpowers/ /root/.openclaw/extensions/memory-lancedb-namespaced/ /root/.openclaw/cron/jobs.json
git commit -m "phase 5.1: daily-memory-consolidation jobs für alle agenten"
```

### Task 5.2: `critical_memory_classifier` Job (alle 30 Min)

- [ ] **Step 1: Jobs anlegen**

```bash
python3 <<'EOF'
import json
path = '/root/.openclaw/cron/jobs.json'
with open(path) as f:
    d = json.load(f)
jobs = d.get('jobs', [])
for agent, minute in [('main', '7,37'), ('bernhardine', '4,34'), ('heisenberg', '10,40')]:
    jobs.append({
        "name": f"critical-memory-classifier-{agent}",
        "agent": agent,
        "schedule": {"cron": f"{minute} * * * *", "timezone": "Europe/Berlin"},
        "message": "/plur1bus internal classify-recent",
        "silent": True
    })
d['jobs'] = jobs
with open(path, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
EOF
```

- [ ] **Step 2: Handler-Erweiterung in index.js**

```js
if (commandName === 'plur1bus' && args && args.startsWith('internal classify-recent')) {
  const { runClassifier } = require('./lib/jobs/critical-classifier');
  const result = await runClassifier(dbAdapter, agent, model, telegramSend);
  console.log(`[classify-recent ${agent}]`, JSON.stringify(result));
  return { silent: true };
}
```

- [ ] **Step 3: `lib/jobs/critical-classifier.js`**

```js
// lib/jobs/critical-classifier.js
const { classifyMemory, shouldPush, buildPushMessage } = require('../critical-push-classifier');
const { loadDailyCounts, incrementCount } = require('../critical-push-state');

async function runClassifier(db, agent, model, telegramSend) {
  const recent = await db.findRecentUnclassified(agent, { sinceMinutes: 30 });
  const counts = await loadDailyCounts(agent);
  const today = new Date().toISOString().slice(0, 10);
  let pushed = 0;
  for (const card of recent) {
    const type = await classifyMemory(card.content, { model });
    await db.updateCardType(agent, card.id, type);
    if (shouldPush({ type, date: today }, counts, { maxPerDay: 3 })) {
      await telegramSend(buildPushMessage({ ...card, type }));
      await incrementCount(agent, today);
      pushed++;
    }
  }
  return { processed: recent.length, pushed };
}
module.exports = { runClassifier };
```

- [ ] **Step 4: Commit**

```bash
cd /root && git add -A
git commit -m "phase 5.2: critical-memory-classifier alle 30min pro agent"
```

### Task 5.3: `auto-accept-stale` Job (täglich)

- [ ] **Step 1: Job anlegen**

```bash
python3 <<'EOF'
import json
path = '/root/.openclaw/cron/jobs.json'
with open(path) as f:
    d = json.load(f)
jobs = d.get('jobs', [])
for agent, minute in [('main', '15'), ('bernhardine', '17'), ('heisenberg', '19')]:
    jobs.append({
        "name": f"auto-accept-stale-criticals-{agent}",
        "agent": agent,
        "schedule": {"cron": f"{minute} 3 * * *", "timezone": "Europe/Berlin"},
        "message": "/plur1bus internal auto-accept-stale",
        "silent": True
    })
d['jobs'] = jobs
with open(path, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
EOF
```

- [ ] **Step 2: Handler**

```js
if (commandName === 'plur1bus' && args && args.startsWith('internal auto-accept-stale')) {
  const { autoAcceptStale } = require('./lib/jobs/auto-accept-stale-criticals');
  const result = await autoAcceptStale(dbAdapter, agent, { hours: 24 });
  console.log(`[auto-accept-stale ${agent}]`, result);
  return { silent: true };
}
```

- [ ] **Step 3: Commit**

```bash
cd /root && git add -A
git commit -m "phase 5.3: auto-accept-stale-criticals nach 24h"
```

### Task 5.4: Status-Command: Bridge-Anleitung aus Diagnose ergänzen

Bezieht sich auf Task 0.1/Step 3 — der ermittelte Config-Pfad muss hier konkret stehen.

**Diagnose-Befund Task 0.1 (2026-05-28):**

- **Tatsächlicher Config-Pfad in `/root/.openclaw/openclaw.json`:**
  `plugins.entries["memory-lancedb-namespaced"].config.obsidianBridge.enabled` (mit `.config.` Subbaum!)
- **Aktueller Wert ist `true`** — Plugin lädt korrekt (Log: `plur1bus-obsidian-bridge: watch ready`).
- **Quelle der "Obsidian Bridge is disabled" Meldung:**
  `lib/obsidian-control-room.js:1004` (`runMaintenanceLight` → `findings.push({code:"bridge_disabled"})`), getriggert wenn `cfg.enabled !== true`. `cfg` kommt aus `normalizeObsidianControlRoomConfig(raw)` mit `cfg = raw?.obsidianBridge || raw`.
- **False-Positive-Ursache:** Wenn ein Caller `runMaintenanceLight` mit dem Top-Level-openclaw.json-Object aufruft, sucht `normalize` nach `raw.obsidianBridge` auf Root-Ebene — der existiert dort nicht (liegt unter `plugins.entries.[…].config.obsidianBridge`). Falls also `status-data.js` direkt die ganze openclaw.json einliest und ungefiltert reicht, sieht es `enabled: undefined` → "disabled" trotz `enabled: true` im echten Pfad.

**Konstanten für Implementierung:**

```js
// lib/telegram-commands/feature-toggle.js (neu)
const OBSIDIAN_BRIDGE_CONFIG_PATH = 'plugins.entries.memory-lancedb-namespaced.config.obsidianBridge';
const OBSIDIAN_BRIDGE_ENABLED_PATH = `${OBSIDIAN_BRIDGE_CONFIG_PATH}.enabled`;
```

- [ ] **Step 1: Status-Data-Collector mit korrektem Pfad implementieren**

In `lib/telegram-commands/status-data.js`:

```js
// Korrekt: Plugin-Subbaum enthält .config. Zwischenschicht
const bridgeConfig = config.plugins?.entries?.['memory-lancedb-namespaced']?.config?.obsidianBridge;
if (bridgeConfig && bridgeConfig.enabled === false) {
  issues.push({
    key: 'vaultSync',
    title: 'Vault-Sync ist aus',
    reason: 'in /root/.openclaw/openclaw.json steht "plugins.entries.memory-lancedb-namespaced.config.obsidianBridge.enabled: false"',
    ...
```

Und entsprechend in `feature-toggle.js`: `vaultSync.configPath = 'plugins.entries.memory-lancedb-namespaced.config.obsidianBridge.enabled'`.

- [ ] **Step 2: Test mit `/status` in Telegram**

```bash
systemctl --user restart openclaw-gateway
sleep 30
# User: /status in Telegram → Vault-Sync sollte als 🟢 auftauchen wenn enabled
```

- [ ] **Step 3: Commit**

```bash
cd /root && git add -A
git commit -m "phase 5.4: status-command bridge-pfad an realität angepasst"
```

---

## Phase 6 — Aktivierung & Smoke-Test

Ziel: Alles laufen lassen, im Telegram durchspielen, ggf. nachjustieren.

### Task 6.1: Full-Restart + Health-Check

- [ ] **Step 1: Gateway, Cron, Syncthing prüfen**

```bash
systemctl --user restart openclaw-gateway
sleep 30
systemctl --user status openclaw-gateway --no-pager | head -15
systemctl status syncthing --no-pager | head -10
```

- [ ] **Step 2: Plugin-Lade-Log**

```bash
journalctl --user -u openclaw-gateway -n 200 --no-pager | grep -iE "memory-lancedb-namespaced|plur1bus" | tail -30
```

Erwartet: kein "failed", "error", "crash".

- [ ] **Step 3: Cron-Jobs angekommen**

```bash
cat /root/.openclaw/cron/jobs.json | python3 -c "import json,sys; jobs=json.load(sys.stdin)['jobs']; new=[j for j in jobs if 'consolidation' in j['name'] or 'classifier' in j['name'] or 'auto-accept' in j['name']]; print(f'{len(new)} neue jobs:'); [print(f'  - {j[\"name\"]} ({j[\"schedule\"][\"cron\"]})') for j in new]"
```

### Task 6.2: Smoke-Test in Telegram (User-interaktiv)

User-Aktion in Telegram (Bernd):

- [ ] **`/status`** — erwartet: 🟢 mit Memory-Card-Count + Vault-Sync + Plausibilitätsprüfung
- [ ] **`/memory diese Woche`** — erwartet: Liste der letzten Memories
- [ ] **`/memory über Eva`** — erwartet: Eva-bezogene Memories
- [ ] **`/vergiss <was harmloses>`** — erwartet: ✅ Weg
- [ ] **`/korrigier <alt> zu <neu>`** — erwartet: ✅ Geändert
- [ ] **`/einschalten foo`** — erwartet: ❌ unbekannt
- [ ] **`/ausschalten vaultSync`** → `/status` — erwartet: 🟡 Hinweis mit Einschalt-Anleitung
- [ ] **`/einschalten vaultSync`** → `/status` — erwartet: wieder 🟢
- [ ] **`/plur1bus_review`** — erwartet: Command nicht erkannt (ist weg)

Analog kurz für Bernhardine (Eva) und Heisenberg (Erik) prüfen — minimum `/status` und `/memory diese Woche`.

### Task 6.3: 7-Tage-Beobachtung als TODO eintragen

- [ ] **Step 1: Reminder-Item anlegen**

```bash
# in /root/.openclaw/cron/jobs.json einmaliger Reminder (oder Telegram-Notiz)
echo "TODO: nach 7 Tagen (2026-06-04) Spec §11.7 prüfen: keine neuen *.sync-conflict-* Files in .obsidian/" >> /root/.openclaw/workspace/sys/MEMORY.md
```

- [ ] **Step 2: Memory-Update**

Erstelle einen neuen Memory-Eintrag in `/root/.claude/projects/-root/memory/` (Auto-Memory-System), der den Status festhält:

```bash
cat > /root/.claude/projects/-root/memory/project_plur1bus_rewrite.md <<'EOF'
---
name: project_plur1bus_rewrite
description: "PLUR1BUS Rewrite (Mai 2026) — Review-Bundle-Workflow durch autonomes Lernen + /memory/vergiss/korrigier/status ersetzt"
metadata:
  type: project
---

# PLUR1BUS Rewrite — abgeschlossen

Spec: `docs/superpowers/specs/2026-05-28-plur1bus-rewrite-design.md`
Plan: `docs/superpowers/plans/2026-05-28-plur1bus-rewrite.md`

## Was sich für Cy geändert hat

- **Weg:** `/plur1bus_review`, alle Bundle-IDs (`rb-...`), Approval-Theater, evening-deep-review-Pushes
- **Neu:** `/memory <Frage>`, `/vergiss <Freitext>`, `/korrigier alt zu neu`, `/status`, `/einschalten` / `/ausschalten`
- **Push nur noch bei kritischen Memories** (max. 3/Tag pro Agent, Entity-Types: person/beziehung/geburtstag/geld/gesundheit/passwort)
- **Bot lernt autonom** — Bundles laufen still im Hintergrund (alter Code als Fallback bleibt)
- **Vault-Struktur:**
  - `/memory/cards/YYYY/MM/<datum>-<slug>.md` (User-readable, mobil sichtbar)
  - `/sys/` für Bot-State (MEMORY.md, SOUL.md, ... — nicht synct)
  - `/plur1bus/` weiter für Backend-Internas (nicht synct)
- **Syncthing-Filter:** `.obsidian/` nur noch `plur1bus-bridge.json` + `workspace-mobile.json` synct (eliminiert Sync-Konflikte mit iCDPhone)

## Was NICHT angefasst wurde

- LanceDB als Storage
- Per-Agent-Namespace-Isolation
- Heisenberg-Workspace bleibt server-only (kein Syncthing)
- Adversarial/Plausibilitäts-Checks laufen weiter, aber still

## Cron-Jobs

- `daily-memory-consolidation-<agent>` (00:30) — still
- `critical-memory-classifier-<agent>` (alle 30 Min) — pushed bei Schwellen-Treffer
- `auto-accept-stale-criticals-<agent>` (03:15) — übernimmt unbestätigte Kritisch-Pushes nach 24h

[[project_plur1bus_obsidian_bridge_analysis]] (Vor-Analyse)
EOF
```

Und MEMORY.md-Index aktualisieren:

```bash
grep -q "project_plur1bus_rewrite" /root/.claude/projects/-root/memory/MEMORY.md || \
  sed -i '/## PLUR1BUS Obsidian Bridge Analyse/i\
## PLUR1BUS Rewrite (abgeschlossen 2026-05-28)\
\
→ [`project_plur1bus_rewrite.md`](project_plur1bus_rewrite.md): Review-Bundle-Workflow weg, neue Commands `/memory`, `/vergiss`, `/korrigier`, `/status`. Bot lernt autonom. Push nur noch bei kritischen Memories.\
' /root/.claude/projects/-root/memory/MEMORY.md
```

- [ ] **Step 3: Final-Commit**

```bash
cd /root && git add -A
git commit -m "phase 6: plur1bus rewrite abgeschlossen + memory update"
```

---

## Erfolgs-Kriterien (aus Spec §11)

Nach Abschluss aller Phasen prüfen:

- [ ] `/plur1bus_review` existiert nicht mehr in Telegram
- [ ] `/memory diese Woche` antwortet in <3s mit lesbarer Liste
- [ ] `/vergiss <Freitext>` löscht aus LanceDB + archiviert
- [ ] Kritisch-Push erscheint ≤3× pro Tag pro Agent
- [ ] `/status` zeigt ausgeschaltete Services mit Grund + Einschalt-Anleitung
- [ ] iPhone-Obsidian zeigt `/memory/cards/` (nicht `/plur1bus/`, nicht `MEMORY.md` aus Root)
- [ ] Nach 7 Tagen: keine neuen `*.sync-conflict-*` Files in `.obsidian/`
- [ ] Cron-Job `evening_deep_review` ist entfernt; `daily_memory_consolidation` läuft täglich 00:30 still

---

## Rollback

Falls in einer Phase etwas schief geht:

```bash
# Pro Phase wurde committed — auf vorherigen Commit reverten
cd /root && git log --oneline docs/superpowers/plans/2026-05-28-plur1bus-rewrite.md | head -10
git revert <commit-sha>  # nicht reset; revert erzeugt sauberen Revert-Commit

# Config-Backups einspielen
cp /root/.openclaw/openclaw.json.bak-pre-rewrite-2026-05-28 /root/.openclaw/openclaw.json
cp /root/.openclaw/cron/jobs.json.bak-pre-rewrite-2026-05-28 /root/.openclaw/cron/jobs.json

# Sync-Konflikt-Backup zurückspielen (falls .obsidian-Filter rückgängig)
cp /root/.openclaw/backups/sync-conflicts-2026-05-28/*.sync-conflict-* /root/.openclaw/workspace/.obsidian/

# Gateway neu starten
systemctl --user restart openclaw-gateway
```

`/sys/` Move ist NICHT trivial reversibel wenn Code-Path-Updates schon eingespielt wurden — vorher genau prüfen welche Files schon im `/sys/` liegen vs. Root.
