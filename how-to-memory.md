# How-To: Memory-System — PLUR1BUS 6.8.11 (Stand 2026-06-30)

> **Single Source of Truth** für die tägliche Nutzung. Architektur-Details (Schicht 1/2/3, Dreaming, Adaptive Learning, Meta-Cognition) stehen in `how-to-memory-perfect.md`.

**Plugin-Version:** `memory-lancedb-namespaced` 6.8.11. Mindestversion OpenClaw `2026.5.12-beta.6`. Plugin-Quelle: `https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory`. Live unter `~/.openclaw/extensions/memory-lancedb-namespaced/`.

---

## Was ist PLUR1BUS jetzt

Eine **autonome** Gedächtnis-Schicht mit kognitiven Erweiterungen. Der Bot lernt selbst — ohne dass der User mehrmals täglich Review-Bundles anschauen muss. Fünf Bausteine:

1. **LanceDB pro Agent** — Source of Truth für jede Memory-Karte
2. **Obsidian-Vault-Mirror** — `/memory/cards/YYYY/MM/*.md`, mobil lesbar
3. **Background-Jobs** — Cron-getriebene Konsolidierung + Kritisch-Klassifier + GC
4. **Emotion & Meta-Cognition** — Stimmungsabhängiger Recall, wöchentliche Reflexion
5. **ACL & Collaborative Memory** — Agent-/Workspace-Scoped Zugriff, Sharing-Pool

**Was nicht mehr da ist (Breaking Changes vs. 4.x):**
- `/plur1bus_review` / `/plur1bus_morning` / `/plur1bus_evening` weg
- Review-Bundles (`rb-*`) komplett ersetzt durch autonome Klassifikation
- Cron-Jobs `morning-review` / `evening-review` entfernt
- Config-Keys `autoApplyLowRisk`, `reviewProfiles`, `bundleCooldownMs`, `review` entfallen

---

## Die 8 Commands

Im Telegram-DM mit dem jeweiligen Agent.

### `/state`
System-Health auf einen Blick.

```
/state
→ 1247 Karten, Sync OK, letzte Plausibilitätsprüfung 03:32, keine offenen Themen.
```

Liefert: Karten-Count, Sync-State, letzter Consolidation-Run, offene Issues mit Reason + Fix-Hint.

### `/memory <Frage>`
Inspektion der eigenen Erinnerungen — zeitbasiert oder topic-basiert.

```
/memory diese Woche         → Karten der letzten 7 Tage
/memory über Eva            → Alles was mit Eva verknüpft ist
/memory letzten Monat       → Karten Mai 2026
/memory Therapie            → Topic-Suche via Recall-Pipeline
```

Nutzt dieselbe Recall-Pipeline wie das `memory_recall`-Tool — d.h. Embedding-Suche + Reranker.

### `/forget <Freitext>`
Erinnerung löschen mit **archive-first**-Garantie. Die Karte wird vor dem Löschen als JSON in `/plur1bus/_archive/` weggesichert — kein endgültiger Verlust.

```
/forget den Pferdekauf-Plan
→ 1 Karte gefunden ("Plan Pferdekauf Q3"), archiviert und gelöscht.
```

### `/correct <alt> zu <neu>`
Erinnerung ändern. Akzeptiert ` zu `, `→`, oder `->` als Separator. Archive-first wie `/forget`. **Mit echtem Embedder-Wiring** (Phase 6.2) — das Update generiert neue Embeddings, nicht nur Textersatz.

```
/correct Eva mag keinen Kaffee zu Eva mag Espresso aber keinen Filterkaffee
/correct Pferd → Pony
/correct Termin Mittwoch -> Termin Donnerstag
```

### `/mf <ID> +|-|~`
Feedback auf ein Memory-Ergebnis geben. Persistiert pro Workspace für Recall-Qualitäts-Verbesserung.

```
/mf abc123 +
→ ✅ Feedback gespeichert: abc123 → positive

/mf abc123 -
→ ✅ Feedback gespeichert: abc123 → negative
```

### `/teile <ID>`
Memory-Karte in den Workspace-Shared-Pool kopieren. ACL-geschützt.

`scope` ist standardmäßig `agent-private`; explizit gesetzte `scope: "user"`-Einträge sind owner-bound und nur vom gleichen `userId` lesbar.

```
/teile abc123
→ Shared "Plan Pferdekauf Q3" to workspace pool (id: xyz789).
```

### `/enable <feature>` / `/disable <feature>`
Toggle für Features:

| Feature | Effekt |
| --- | --- |
| `temporalContext` | Temporal Continuity Context an/aus |
| `embeddingCache` | LRU-Cache für Embedding-Vektoren an/aus |
| `autoCapture` | Auto-Capture an/aus |
| `autoRecall` | Auto-Recall an/aus |
| `vaultSync` / `obsidianBridge` | Obsidian-Mirror an/aus |
| `kritischPush` / `criticalPush` | Telegram-Push bei kritischen Treffern an/aus |
| `dailyConsolidation` | Nächtliche Karten-Konsolidierung an/aus |
| `reranker` | Reranker-Stufe an/aus |
| `emotionTier` | Emotion Tier-3 (LLM-basiert) an/aus |
| `emotion` | Emotion Tier-2 an/aus |
| `metaCognition` | Wöchentliche Reflexions-Jobs an/aus |
| `merging` | Merging/Konsolidierung an/aus |
| `lowRiskMergeAutoApply` | Low-risk Merge Auto-Apply an/aus |
| `schicht15` | Schicht 1.5 Knowledge Promotion an/aus |
| `skillMiner` | Skill Miner an/aus |
| `morningReview` | Morning Review an/aus |
| `eveningReview` | Evening Review an/aus |
| `dashboardLayer` | Dashboard Layer im Obsidian-Bridge an/aus |
| `semanticGraph` | Semantic Graph an/aus |
| `provenanceGraph` | Provenance Graph an/aus |
| `adversarialDeep` | Adversarial Deep an/aus |
| `soulPatch` | SoulPatch an/aus |

Schreibt atomar nach `openclaw.json`. **Gateway-Restart nötig**, damit die Änderung greift.

```
/disable kritischPush
→ Toggle gesetzt. Gateway-Restart aktiv ab nächstem Neustart.
```

---

## Der Kritisch-Push-Mechanismus

Statt alles in eine Review-Queue zu schieben, klassifiziert ein 30min-Cron neue Karten auf **sensitive Entity-Typen** (Gesundheits-Marker, Sicherheit, Finanzen). Treffer landen direkt als Telegram-Nachricht beim User — mit Inline-Buttons:

```
✅ Stimmt    ❌ Falsch    ✏️ Anders formulieren
```

**Limits:**
- Max **3 Pushes pro Tag pro Agent** — kein Spam
- Keine Reaktion innerhalb 24h → **Auto-Accept** (Karte als bestätigt markiert)
- `kritischPush=off` deaktiviert die Pushes komplett, Klassifikation läuft weiter

**Was passiert hinter den Buttons:**
- `✅ Stimmt` → `markConfirmed(id)` in LanceDB
- `❌ Falsch` → `/forget`-Flow (Archive + Delete)
- `✏️ Anders formulieren` → eröffnet Mini-Dialog wie `/correct`

---

## Die 7 Cron-Jobs

Alle Jobs laufen pro Agent (`-main`, `-bernhardine`, `-heisenberg`). State in `/root/.openclaw/cron/jobs.json`.

| Job | Zeit | Was er macht |
| --- | --- | --- |
| `daily-memory-consolidation-*` | 00:30 / 00:32 / 00:38 | **Still.** Mergt Duplikate, glättet via LLM, schreibt frische Markdown-Cards in `/memory/cards/YYYY/MM/`. Kein Push. |
| `critical-memory-classifier-*` | alle 30min | **Still bis Treffer.** Scannt neue Karten auf sensitive Entity-Typen. Treffer → Telegram-Push (siehe oben). |
| `auto-accept-stale-criticals-*` | 03:15 / 03:17 / 03:19 | **Still.** Markiert nicht-beantwortete Kritisch-Pushes nach 24h als bestätigt. |
| `feedback-analyzer-*` | 01:00 | **Still.** Analysiert gesammeltes `/mf`-Feedback für Recall-Qualitäts-Verbesserung. |
| `proactive-check-*` | 02:00 | **Still.** Erkennt Muster und schlägt proaktive Erinnerungen vor. |
| `reflection-job-*` | So 04:00 | **Still.** Wöchentliche Meta-Cognition: Pattern-Dichte, Recall-Erfolgsraten, Knowledge-Gaps. |
| `gc-job-*` | 05:00 | **Still.** Entfernt expired/stale Memories nach Retention-Policy. |

Staffelung (Bernhardine → Bernd → Heisenberg) verhindert Kimi-Rate-Limit-Kollisionen.

---

## Emotionen — Wie der Bot "fühlt"

Der Bot modelliert emotionale Zustände (er fühlt nicht wirklich, sondern spiegelt und beschreibt). Drei Ebenen:

### Basisemotionen (8 Plutchik)
joy, trust, anticipation, sadness, **disgust**, anger, fear, surprise

### Nuancen (20+)
relief, pride, gratitude, nostalgia, loneliness, resentment, awe, contempt, guilt, shame, hope, envy, compassion, curiosity, boredom, excitement, love, disappointment, embarrassment, serenity

### Blends (Komplexe Emotionen)
Wenn mehrere Basisemotionen gleichzeitig stark sind, erkennt der Bot Blends:
- **bittersweet** — joy + sadness + Abschied
- **schadenfreude** — joy + anger + "jemand ist gescheitert"
- **love** — trust + joy + Herz/Vertrauen
- **contempt** — anger + disgust + Verachtung
- **relief** — joy nach fear (Transition)

Jede Nuance und jeder Blend hat Confidence, Evidence und Quelle (lexicon/transformer/llm).

### Emotion-spezifischer Decay
Emotionen klingen unterschiedlich schnell ab:
| Emotion | Halbwertszeit |
|---------|--------------|
| surprise | 2 Minuten |
| fear | 20 Minuten |
| joy/trust | 30 Minuten |
| sadness/disgust/anger | 2 Stunden |
| resentment | 6 Stunden |
| shame | 12 Stunden |

---

## Wann fragt der Bot vs. lernt er selbst?

| Situation | Verhalten |
| --- | --- |
| Cy erzählt im Chat etwas Neues (`"Eva fängt Montag den neuen Job an"`) | **Stilles Lernen.** Auto-Capture nach jedem Turn, Karte landet in LanceDB + Vault. Kein Push. |
| Klassifier markiert es als kritisch (z.B. Symptom, Passwort, Diagnose) | **Push mit Buttons.** Max 3/Tag. |
| Cy ruft explizit `/forget`, `/correct`, `/memory` | Direkte Aktion. Kein Push. |
| Nightly Consolidation merged zwei ähnliche Karten | **Stilles Merging.** Nur `/state` zeigt das im Health-Snapshot. |
| LLM-Glättung beim Card-Write scheitert | Fallback: raw text wird gespeichert. Kein Abbruch. |

---

## Wo sehe ich Erinnerungen mobil?

Im Obsidian-Vault, gemountet via Syncthing:

```
vault/
├── memory/
│   └── cards/
│       └── 2026/
│           └── 05/
│               ├── 2026-05-28-eva-job-start.md
│               └── 2026-05-27-pferd-anatomie.md
├── decisions/
├── people/
├── projects/
├── sys/         ← Bot-State (NICHT synct: MEMORY.md, SOUL.md, IDENTITY.md, …)
└── plur1bus/    ← Backend-Internas (NICHT synct: _archive/, heartbeat, …)
```

Cards sind **user-readable Markdown** mit YAML-Frontmatter (id, type, createdAt, confirmed). Mobil per Obsidian-App oder beliebigem Markdown-Reader.

**Syncthing-Filter** (`.stignore` bei Bernd + Bernhardine):
```
!/.obsidian/plugins/plur1bus-bridge.json
!/.obsidian/workspace-mobile.json
!/memory
!/decisions
!/people
!/projects
(?d)*
```
`/sys/` und `/plur1bus/` bleiben lokal pro Agent — keine Mobile-/Desktop-Konflikte mehr.

---

## Config-Pfad (für Reference)

In `openclaw.json` lebt die Bridge unter:

```
plugins.entries["memory-lancedb-namespaced"].config.obsidianBridge.enabled
                                            ^^^^^^^^^
                                            wichtig: .config. Schicht
```

Beispiel-Block:

```json
"plugins": {
  "entries": {
    "memory-lancedb-namespaced": {
      "enabled": true,
      "config": {
        "obsidianBridge": { "enabled": true, "vaultPath": "/root/.openclaw/vault" },
        "criticalPush":   { "enabled": true, "maxPerDay": 3 },
        "dailyConsolidation": { "enabled": true }
      }
    }
  }
}
```

---

## Fehler-Modi

### Capture oder Recall timed out
Symptom: `capture worker timed out after 60000ms` oder `recall timed out without cache` im Gateway-Log.
Ursache (häufigste): Kein ANN-Vektorindex auf der LanceDB-Tabelle → jede Suche = O(n)-Flat-Scan aller Vektoren.
Check:
```bash
node --input-type=module << 'EOF'
import { join } from 'path'; import { homedir } from 'os';
const lancedb = await import(join(homedir(), '.openclaw/extensions/memory-lancedb-namespaced/node_modules/@lancedb/lancedb/dist/index.js'));
for (const agent of ['bernhardine','main','heisenberg']) {
  const db = await lancedb.connect(join(homedir(), '.openclaw/memory/lancedb-namespaced', agent));
  const t = await db.openTable('memories');
  console.log(agent, 'rows:', await t.countRows(), 'indices:', JSON.stringify(await t.listIndices()));
}
EOF
```
Fix: Index erstellen (oder den auto-reindex warten — alle 500 Writes automatisch ab 5.1.x):
```bash
node --input-type=module << 'EOF'
import { join } from 'path'; import { homedir } from 'os';
const lancedb = await import(join(homedir(), '.openclaw/extensions/memory-lancedb-namespaced/node_modules/@lancedb/lancedb/dist/index.js'));
const db = await lancedb.connect(join(homedir(), '.openclaw/memory/lancedb-namespaced/bernhardine'));
const t = await db.openTable('memories');
await t.createIndex('vector', { config: lancedb.Index.hnswPq({ m: 16, efConstruction: 100, numSubVectors: 96 }), replace: true });
console.log('done');
EOF
```
Timeout-Werte in `openclaw.json` unter `plugins.entries["memory-lancedb-namespaced"].config.runtime`: `captureTimeoutMs: 60000`, `recallTimeoutMs: 45000`.

### Recall schlägt fehl mit "maximum context length is 8192 tokens"
Symptom: `recall failed: Error: 400 Invalid 'input': maximum context length is 8192 tokens` im Log.
Ursache: Der aktuelle User-Prompt überschreitet das Embedding-Limit (~32 KB / 8191 Token).
Fix (ab 5.1.x automatisch): Lange Prompts werden via LLM zu Key-Topics zusammengefasst bevor sie an die Embedding-API gehen. Kein manueller Eingriff nötig. Voraussetzung: `merging.model` ist konfiguriert (Standard: `kimi-for-coding`).

### `/correct` hängt am Embedder
Symptom: Telegram zeigt langes "thinking…", dann Timeout.
Ursache: Embedder-Call (`text-embedding-3-large`) blockiert oder Quota leer.
Check: `journalctl --user -u openclaw-gateway --since "10 min ago" | grep embedder`
Fix: OpenAI-Key prüfen (`.env`), ggf. Embedder-Fallback aktivieren.

### Kritisch-Push kommt nicht obwohl Karte sensitiv aussieht
Check 1: `/state` — ist `kritischPush` an?
Check 2: Tages-Limit (3/Tag) bereits ausgeschöpft? → State in `/plur1bus/_state/critical-push-budget.json`
Check 3: Classifier-Cron lief? → `cat /root/.openclaw/cron/jobs.json | jq '.jobs[] | select(.name | startswith("critical-memory-classifier"))'`

### `/state` meldet "sync stale"
Obsidian-Bridge schreibt nicht (mehr) ins Vault.
Check: Vault-Pfad existiert? Schreibrechte? `vaultSync` per Toggle aktiv?
Fix: `/enable vaultSync` + Gateway-Restart.

### Karten erscheinen doppelt im Vault
Self-Hash-Mismatch (P1-Bug, in 5.0.0 gefixt): Bridge erkannte eigene Outputs nicht als ignorierbar.
Wenn das wiederkehrt: prüfe `_archive/**` in `DEFAULT_IGNORE_GLOBS` der Bridge.

### `/memory <topic>` liefert nichts obwohl Karten existieren
Embedder-Provider down oder Reranker-Quota leer.
Fallback: roher LanceDB-Dump via `node /root/plur1bus/scripts/memory-doctor.mjs search "<query>"`.

---

## Migration von 4.x

Alte Review-Bundles (`rb-*`) wurden beim ersten 5.0.0-Start in `/plur1bus/_archive/` verschoben. Wenn du da noch Pending-Bundles findest, die du applien wolltest: manuell im Vault öffnen, Inhalte als `memory_store` neu einspielen.

Cron-Jobs `morning-review` / `evening-review` wurden via `update-openclaw.sh` entfernt. Falls noch Reste in `jobs.json` liegen: per Hand löschen.

---

## Tests & Distribution

Plugin: **1931/1931 Tests passing** (`npm test`).
Distribution: Source-Repo. Live deployed nach `~/.openclaw/extensions/memory-lancedb-namespaced/` (per `git pull` + Gateway-Restart).

---

*Letzter Refresh: 2026-06-30 (PLUR1BUS 6.8.11).
Vorgängerstände: siehe Git-History und `CHANGELOG.md`.*
