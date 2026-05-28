# PLUR1BUS Rewrite — Design

**Datum:** 2026-05-28
**Status:** Design (vor Implementierungs-Plan)
**Auslöser:** User-Frustration über Review-Workflow (`/plur1bus_review` mit kryptischen Bundle-IDs, "Bridge disabled"-Meldungen ohne Erklärung, 267 pending Items davon ~95 % Self-Hash-Echo)

---

## 1. Ziel

Das Approval-Konzept aus PLUR1BUS für den User komplett entfernen. Bot lernt autonom in LanceDB. Drei minimale User-Touchpoints ersetzen den bestehenden Review-Flow: **Nachschauen**, **Korrigieren/Löschen**, **Bestätigen bei kritischen Memories**.

Strukturelle Vorgaben des Users:
- **Beratungsfrei, auf Logik und Intuition basierend** — keine Erklär-Jargon, keine Fachbegriffe in der User-Sicht
- **Keine langen Buchstaben-IDs** als Eingabe
- **Hybrid-Interaktion**: Default Stapel-Aktionen, Detail-Liste auf Anfrage
- **Status nur mit Handlungshinweis**: kein passives "X is disabled" — sondern "warum aus" + "so schaltest du's ein"
- **Vermischung zwischen Bernd / Bernhardine / Heisenberg ausgeschlossen** (bereits gegeben, Verifikation siehe Abschnitt 9)

## 2. Architektur

### 2.1 Was unverändert bleibt
- **LanceDB** als autoritativer Memory-Storage (`/root/.openclaw/memory/lancedb-namespaced/<agent>/`)
- **Per-Agent-Namespace-Isolation** in LanceDB (bestehend, korrekt)
- **Obsidian-Vault** als Spiegelung — aber neu strukturiert (siehe 2.4)
- **Adversarial-Check, Semantic-Conflicts, Duplicate-Scan** laufen weiter — aber **als interne Qualitätssicherung**, nicht als User-Anfragen
- **Syncthing-Folder-Topologie** (Bernd → 3 Devices, Bernhardine → vmd190201, Heisenberg → server-only). Heisenberg bleibt bewusst server-only.

### 2.2 Was entfernt wird
- Commands: `/plur1bus_review`, `approve`, `reject`, `apply`, `show`, `explain`, `quickapply`
- User-Konzepte: **Review-Bundle**, **Bundle-ID** (`rb-...`), **pending Items**, **Approval-Flow**
- Telegram-Push am Abend mit Review-Aufforderung
- Cron-Jobs: `evening_deep_review`, `prepare_review_bundle`
- Vault-Output: `evening-deep-review-*.md` Files im Vault-Root (Archiv-Move, siehe 7.2)

### 2.3 Was neu kommt — drei Touchpoints

**A) `/memory <Frage>` — Inspektion**

Zwei Modi:
- *Zeitbasiert:* `/memory diese Woche` / `/memory heute` / `/memory Mai`
- *Topic-basiert:* `/memory über Eva` / `/memory was weißt du über X`

Ausgabe: kompakter Markdown-Block in Telegram, je Memory eine Bullet-Zeile mit Quelle und Datum. Footer mit `[ Mehr ]` und `[ Was korrigieren? ]` Buttons.

**B) `/vergiss <Freitext>` und `/korrigier <alt> zu <neu>` — Direkteingriff**

- Bot interpretiert Freitext via `kimi-coding/kimi-for-coding` gegen den Memory-Index (gleicher Model-Slot wie active-memory, kein Extra-API-Aufruf nötig)
- Bei eindeutigem Treffer: führt aus, antwortet `✅ Weg` bzw. `✅ Geändert`
- Bei mehrdeutigen Treffern (≥2 Kandidaten): listet max. 3 Treffer mit nummerierten Buttons, User wählt
- Gelöschte/geänderte Memories werden archiviert (`/root/.openclaw/memory/_archive/<agent>/` mit Zeitstempel)

**C) Selbstauslösende Kritisch-Bestätigung**

- Auslöser: Bot klassifiziert beim Schreiben einer Memory die Entity-Typen. Schwelle: `person`, `beziehung`, `geburtstag`, `geld_konto`, `gesundheit`, `zugang_passwort`
- Push: einzelne Telegram-Karte mit Inline-Buttons `[✅ Stimmt] [❌ Falsch] [✏️ Anders formulieren]`
- Max **3 Pushes pro Tag** pro Agent (Rate-Limit gegen Spam)
- Reaktion `❌` → Memory wird gar nicht in LanceDB geschrieben
- Reaktion `✏️` → Bot fragt nach Formulierung, User-Antwort wird Memory-Inhalt
- Keine Reaktion in 24 h → Memory wird ohne Bestätigung übernommen (sonst Backlog-Risiko)

### 2.4 Vault-Layout neu

```
workspace/                                # Bernd, analog für -bernhardine, -heisenberg
├── memory/
│   ├── cards/                            # NEU — Memory-Cards, mobil sichtbar
│   │   ├── 2026/
│   │   │   ├── 05/
│   │   │   │   ├── 2026-05-28-eva-geburtstag.md
│   │   │   │   └── ...
│   │   └── _index.md                     # Auto-generiert, Topic-Map
│   ├── 2026-MM-DD.md                     # Konversations-Compacts (bleibt)
│   └── _archive/                         # Gelöschte/korrigierte Memories
├── sys/                                  # NEU — Bot-internes State, nicht synct
│   ├── MEMORY.md                         # verschoben aus Root
│   ├── SOUL.md                           # verschoben aus Root
│   ├── DREAMS.md                         # verschoben aus Root
│   ├── HEARTBEAT.md                      # verschoben aus Root
│   ├── IDENTITY.md                       # verschoben aus Root
│   └── AGENTS.md                         # verschoben aus Root
├── plur1bus/                             # Backend-internas, nicht User-facing
│   ├── _archive/                         # alte evening-deep-reviews
│   ├── dashboards/                       # Internes Health-Monitoring
│   ├── conflicts/, duplicate-candidates/ # Adversarial-Output (Log-only)
│   └── records/                          # Spiegelung — bleibt für Backend
├── .obsidian/                            # mit neuer .stignore-Regel (Abschnitt 8.1)
└── [User-eigene Notizen weiter im Root]
```

**Memory-Card-Template** (`workspace/_templates/memory-card.md`):

```markdown
---
id: <uuid>
type: <person|beziehung|geburtstag|geld_konto|gesundheit|fakt|...>
created: <ISO8601>
source: <konversation-id|user-edit|extraction>
related: [[andere-card-id]]
---

# <Titel als ganzer Satz>

**Was:** <Eine Klartext-Aussage. LLM-geglättet beim Schreiben, kein Stichwort-Salat>

**Warum gemerkt:** <Kontext aus der Quell-Konversation>

**Wann gelernt:** <Datum + Konversationsverweis>
```

LLM-Glättung beim Schreiben: Bot generiert das `Was`-Feld als grammatikalisch vollständigen Satz, bevor die Card geschrieben wird. Kein "riva env-token fix" — sondern "Die Riva-STT-Bridge braucht Vorrang für den Umgebungs-Token (Bug behoben am 9. Mai)".

## 3. `/status` — Einzige Quelle für System-Health

Ersetzt versteckte "Bridge is disabled"-Meldungen. Format **immer**: Ampel-Emoji + max. 3 Zeilen pro Hinweis, jeder Hinweis enthält Grund + Anleitung.

**Beispiel „alles OK":**
```
🟢 Alles läuft normal.
• Memory: 4218 Karten, letzte Aktualisierung vor 12 Min
• Vault-Sync: aktiv auf 3 Geräten (iPhone, MacBook, Server)
• Plausibilitätsprüfung: läuft alle 6h, letzter Lauf gestern 20:30
```

**Beispiel mit Hinweis:**
```
🟡 1 Hinweis

  Vault-Sync ist aus.
  ↳ Grund: in /root/.openclaw/openclaw.json steht "obsidianBridge.enabled: false"
  ↳ So schaltest du es ein: /einschalten vaultSync
     (oder manuell in openclaw.json den Wert auf true setzen)
  
  Was es macht: spiegelt deine Erinnerungen in den Obsidian-Vault.
  Was du ohne es verlierst: du siehst Erinnerungen nur über /memory, nicht im Vault.
```

**Neue Helper-Commands:**
- `/einschalten <name>` und `/ausschalten <name>` — funktionieren für jedes Feature aus einer kuratierten Whitelist
- Whitelist initial: `vaultSync`, `kritischPush`, `dailyConsolidation`

## 4. Sprache (User-facing Glossar)

| Alt (EN/Tech) | Neu (DE, User-facing) |
|---|---|
| Review Bundle / `rb-...` | — (entfernt) |
| Approve / Apply / Reject | — (entfernt) |
| Risk: low/medium/high | — (entfernt) |
| Adversarial Check | "Plausibilitätsprüfung" *(nur `/status`)* |
| Vault Hygiene | — (Backend-Log, User-unsichtbar) |
| Memory Card | "Erinnerung" / "Karte" |
| Bridge / Obsidian Bridge | "Vault-Sync" |
| disabled | "ausgeschaltet" + Anleitung |
| Hash Mismatch | — (Backend-Log) |
| Duplicate Scan | "Dubletten-Check" *(nur `/status`)* |
| Semantic Conflict | "Widerspruch" *(nur `/status`)* |
| Pending Items | — (gibt es nicht mehr) |
| `rejected`, `approved`, `pending` | — (interne States, User-unsichtbar) |

Code, Logs und Dateinamen bleiben Englisch.

## 5. Cron-Anpassungen

`/root/.openclaw/cron/jobs.json`:

**Raus:**
- `evening_deep_review` (alle Agenten)
- `prepare_review_bundle` (alle Agenten)

**Neu:**
- `daily_memory_consolidation` (00:30 pro Agent): läuft Adversarial + Duplicate + Semantic-Conflict-Check still, schreibt nur ins Log. Keine Telegram-Nachricht.
- `critical_memory_classifier` (alle 30 min pro Agent): scant neu geschriebene Memories der letzten 30 Min, prüft Entity-Type-Schwelle, triggert Kritisch-Push wenn nötig (mit Rate-Limit).

Bestehende gestaffelte Schedule-Slots wiederverwenden (Bernd: `5,35`, Bernhardine: `2,32`, Heisenberg: `8,38`).

## 6. Plugin-Config (`openclaw.json`)

**Entfernen:**
- `plugins.entries.plur1bus.autoApplyLowRisk`
- `plugins.entries.plur1bus.reviewProfiles` (6 Profile entfallen)
- `plugins.entries.plur1bus.bundleCooldownMs`
- `plugins.entries.plur1bus.review.*` Block
- `channels.telegram.commands.plur1bus_review.*` (3 Aliase: `/plur1bus_review`, `/review`, `/ultrareview` — letzteres bleibt bestehen als getrennter `/code-review`-Alias)

**Neu:**
- `plugins.entries.plur1bus.criticalPush.maxPerDay: 3`
- `plugins.entries.plur1bus.criticalPush.entityTypes: ["person","beziehung","geburtstag","geld_konto","gesundheit","zugang_passwort"]`
- `plugins.entries.plur1bus.criticalPush.autoAcceptAfterHours: 24`
- `plugins.entries.plur1bus.vaultLayout.cardsDir: "memory/cards"`
- `plugins.entries.plur1bus.vaultLayout.sysDir: "sys"`
- `plugins.entries.plur1bus.cardPolish.enabled: true`
- `plugins.entries.plur1bus.cardPolish.model: "kimi-coding/kimi-for-coding"`

## 7. Migration der Bestandsdaten

### 7.1 Pending Items — Frischer Start
- Alle 11 Bundles in allen Agenten als `rejected` markieren (Status-Update in LanceDB-State-Tables, kein Memory-Verlust, da Bot-Memories sowieso schon in LanceDB sind)
- Bundle-State-Files (`workspace/plur1bus/review-bundles/*.json`) in `workspace/plur1bus/_archive/bundles-2026-05-28/` verschieben (Archiv im Vault, nicht synct)
- Migrations-Log nach `/root/.openclaw/logs/plur1bus-migration-2026-05-28.log`

### 7.2 Evening-Deep-Review-Files
- Alle `workspace*/plur1bus/evening-deep-review-*.md` (15+ Files allein bei Bernd) nach `workspace*/plur1bus/_archive/evening-reviews-pre-rewrite/` verschieben
- Falls Files im Vault-Root liegen (Bug P1): nach `_archive/` ziehen

### 7.3 Bot-System-Files in `/sys/` verschieben
- Bernd: `workspace/MEMORY.md`, `SOUL.md`, `DREAMS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `AGENTS.md` → `workspace/sys/`
- Analog Bernhardine und Heisenberg
- Path-Referenzen im Code suchen (`grep -rn "workspace/MEMORY.md\|workspace/SOUL.md" /root/.openclaw/extensions/`) und auf `workspace/sys/` umstellen
- `.bak-*` Files mit-verschieben (oder direkt löschen — User-Entscheidung beim Plan)

### 7.4 Sync-Konflikte aufräumen
- Alle `workspace/.obsidian/*.sync-conflict-*` Files **löschen** (sind alle vom 22./25.05., aktuell nicht mehr relevant)
- `.stignore` ergänzen um Mobile/Desktop-Split:
  ```
  !/.obsidian/plugins/plur1bus-bridge.json
  !/.obsidian/workspace-mobile.json
  // Rest von .obsidian/ wird device-lokal, nicht synct
  ```

### 7.5 Workspaces-Cleanup (defensiv)
- `workspace-main`, `workspace-cron` — vor Aktion mit `grep -r "workspace-main\|workspace-cron" /root/.openclaw/ --include="*.json" --include="*.js"` prüfen ob noch Code drauf zugreift
- Falls keine Referenzen: in `/root/.openclaw/backups/legacy-workspaces-2026-05-28/` verschieben (kein direktes Löschen)

## 8. Syncthing-Anpassungen

### 8.1 Erweiterte `.stignore` (Bernd + Bernhardine identisch)

```
// OpenClaw Obsidian curated vault allowlist
!/.obsidian/plugins/plur1bus-bridge.json
!/.obsidian/workspace-mobile.json
!/memory
!/decisions
!/people
!/projects
(?d)*
```

**Was sich gegenüber heute ändert:**
- `.obsidian/` wird **nicht mehr komplett** synct, sondern nur die zwei expliziten Files → eliminiert die Sync-Konflikte (Problem 1 aus der Prüfung)
- `/plur1bus` bleibt weiter ignoriert (Backend-Inhalt)
- `/memory` bleibt allowlisted → neue `/memory/cards/` werden automatisch mobil sichtbar (kein Filter-Eingriff nötig)
- `/sys` (neu in 2.4) wird **nicht** allowlisted → Bot-State bleibt server-lokal

### 8.2 Heisenberg
Bleibt server-only (kein Syncthing-Folder hinzufügen). Beibehaltung wie aktuell.

## 9. Verifikation: Isolation zwischen Agenten

Folgende Checks gehören in den Implementierungs-Plan als Pre-Flight:

1. **LanceDB-Namespaces:** `ls /root/.openclaw/memory/lancedb-namespaced/` zeigt strikte Trennung (`bernhardine`, `heisenberg`, `architect` für Bernd-Subagents). Schon korrekt — Test: keine Cross-Namespace-Reads via Plugin-Config.
2. **Syncthing-Devices:** `grep "<device id" config.xml` pro Folder — Bernd-Folder darf KEINE Bernhardine-Devices enthalten und umgekehrt. Schon korrekt.
3. **Filesystem-Separation:** Workspace-Pfade per Plugin-Config pro Agent gepinnt (`agents/<name>/agent/`). Schon korrekt.
4. **Telegram-Bot-Tokens:** Jeder Agent hat eigenen Bot-Token (`accounts.<agent>.botToken`). Schon korrekt.
5. **Neuer Code muss respektieren:** Pull der Memory-Cards aus LanceDB darf NUR mit Agent-Namespace passieren (kein Default auf `defaults`-Namespace).

## 10. Out-of-Scope

Bewusst nicht in diesem Rewrite:
- Bridge-Philosophie ändern (LanceDB bleibt autoritativ)
- 5 Memory-Kategorien ändern (bestehende Klassifikation bleibt)
- LanceDB durch was anderes ersetzen
- Heisenberg-Workspace in Syncthing einbinden (Erik kann separat entscheiden)
- WordPress-Integration / andere User-Stories
- Multi-User-Approval-Flows (es gibt nur 1 User pro Agent)

## 11. Erfolgs-Kriterien

Nach Implementierung muss gelten:
1. `/plur1bus_review` existiert nicht mehr in Telegram (kein Befehl, keine Hilfe-Anzeige)
2. `/memory diese Woche` liefert in unter 3 Sekunden eine lesbare Liste
3. `/vergiss <Freitext>` löscht nachweisbar aus LanceDB + archiviert
4. Kritisch-Push erscheint höchstens 3× pro Tag pro Agent
5. `/status` zeigt jeden ausgeschalteten Service mit Grund + Einschalt-Anleitung
6. iPhone-Obsidian zeigt nach Migration die neuen `/memory/cards/` Files, KEINE `/plur1bus/` Internas, KEINE `MEMORY.md` aus dem Root
7. Keine neuen `*.sync-conflict-*` Files in `.obsidian/` über 7 Tage
8. Cron-Job `evening_deep_review` ist entfernt; `daily_memory_consolidation` läuft täglich 00:30 ohne Telegram-Aktivität

## 12. Risiken

| Risiko | Mitigation |
|---|---|
| Code-Pfade greifen noch auf `workspace/MEMORY.md` zu, brechen nach Move | `grep -rn` vor Move, Pfade umstellen, Symlink als Übergangs-Hack möglich |
| User-Vault-Plugins (Obsidian) erwarten alten `/plur1bus/` Pfad | Plugin-Config prüfen, `plur1bus-bridge.json` migrieren |
| Kritisch-Push false-positives (klassifiziert was Belangloses als kritisch) | Initial konservative Entity-Type-Liste, Logging mit User-Reaktion (`❌`-Rate) als Tuning-Signal |
| Daily-Konsolidierung läuft in Cooldown (laut Memory-Notiz: kimi-coding Cooldown) | Eigener Agent für Klassifikator-Job oder Retry mit Backoff |
| User vermisst die alten Bundles ("was war da drin?") | Archiv in `workspace/plur1bus/_archive/` bleibt im Vault einsehbar |
| **Bridge-Disabled-Quelle (Diagnose 2026-05-28, Task 0.1)** — Telegram zeigt "Obsidian Bridge is disabled" obwohl in `openclaw.json` `enabled: true` steht. Quelle: `lib/obsidian-control-room.js:1004` `runMaintenanceLight` prüft `cfg.enabled` aus `normalizeObsidianControlRoomConfig(raw)` mit `cfg = raw?.obsidianBridge \|\| raw`. Echter Pfad ist `plugins.entries.memory-lancedb-namespaced.config.obsidianBridge.enabled` (mit `.config.` Subbaum). Caller, die die ganze openclaw.json reichen statt nur den Plugin-Subbaum, lesen `enabled: undefined`. Bridge selbst läuft korrekt (Log: `plur1bus-obsidian-bridge: watch ready`). | Status-Data-Collector mit korrekt qualifiziertem Pfad implementieren (Task 5.4). Konstanten `OBSIDIAN_BRIDGE_CONFIG_PATH` zentralisieren. |

---

## Anhang A — Betroffene Dateien

```
Code:
  /root/.openclaw/extensions/memory-lancedb-namespaced/
    ├── lib/obsidian-bridge.js                (DEFAULT_IGNORE_GLOBS, writeTextAtomic)
    ├── lib/obsidian-control-room.js          (Review-Pipeline → Streichung)
    ├── lib/obsidian/link-suggestions.js      (undefined-Fix)
    ├── lib/obsidian/impact-analysis.js       (undefined-Fix)
    ├── lib/obsidian/dashboard-generator.js   (Freshness-Stempel)
    ├── lib/telegram-commands/                (/memory, /vergiss, /korrigier, /status, /einschalten neu)
    └── openclaw.plugin.json                  (siehe Abschnitt 6)

Konfig:
  /root/.openclaw/openclaw.json               (Abschnitt 6)
  /root/.openclaw/cron/jobs.json              (Abschnitt 5)
  /root/.openclaw/workspace/.stignore         (Abschnitt 8.1)
  /root/.openclaw/workspace-bernhardine/.stignore  (Abschnitt 8.1)

Migration:
  /root/.openclaw/workspace*/plur1bus/review-bundles/   (Archiv-Move)
  /root/.openclaw/workspace*/plur1bus/evening-deep-review-*.md  (Archiv-Move)
  /root/.openclaw/workspace*/MEMORY.md, SOUL.md, …      (Move nach /sys)
  /root/.openclaw/workspace/.obsidian/*.sync-conflict-* (Löschen)
```

## Anhang B — Referenzen

- `[[project_plur1bus_obsidian_bridge_analysis]]` — vorhergehende Bug+UX-Analyse (27.05.)
- `[[project_perplexica_kimi]]` — Kimi-Config (für `cardPolish.model`)
- `[[user_agent_ownership]]` — Bernd → Christian, Bernhardine → Eva, Heisenberg → Erik

[[project_plur1bus_obsidian_bridge_analysis]]
