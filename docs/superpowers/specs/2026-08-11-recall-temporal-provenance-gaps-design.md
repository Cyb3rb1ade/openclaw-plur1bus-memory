# Recall Temporal Provenance — Lückenschluss (Design)

Datum: 2026-08-11
Status: genehmigt (Canonical-Semantik + Rollout durch User bestätigt)

## Kontext

Agent Bernd (main) berichtete auf die Frage nach Time-Awareness, dass automatisch
eingeblendete Memory-Treffer teils mit `age="unknown"` und `freshness="unknown"`
markiert sind — konkret „die OpenClaw-Erinnerung". Die PLUR1BUS-Vorgabe ist, dass
der Agent das aktuelle Datum kennt und Memories Zeitstempel tragen.

### Was gemessen wurde

**Der Schreibpfad ist gesund.** Read-only-Probe über alle LanceDB-Namespaces:

```
TOTAL rows=25550 missingCreatedAt=0
```

(main 9347, bernhardine 13683, heisenberg 671 — jeweils 0 Zeilen ohne `createdAt`.)
Es fehlen also keine Zeitstempel in der Datenbank. **Kein Backfill, keine
Schema-Migration nötig.**

**Die Datums-Awareness ist ebenfalls intakt.** OpenClaw-Core injiziert in
`dist/system-prompt-params-*.js:361-371` eine `## Temporal Context`-Sektion mit
`Current date: YYYY-MM-DD`, `Time zone: …` und dem Hinweis, für die exakte Uhrzeit
`session_status` zu nutzen. `agents.defaults.userTimezone` ist auf `Europe/Berlin`
gesetzt, die Sektion wird also gerendert. Granularität ist tagesgenau — by design.
Hier ist nichts kaputt.

**Der Defekt sitzt ausschließlich in der Mapping-Schicht des Lesepfads.** Zwischen
DB-Zeile und Prompt-Renderer gibt es drei Produzenten von Prompt-Items; zwei davon
lassen die Zeitstempel-Felder fallen, einer rendert die Attribute gar nicht.

`computeMemoryAge()` (`lib/temporal-provenance.js:120-140`) liest ausschließlich
`memory.updatedAt` und `memory.createdAt`. Fehlen beide, ist das Ergebnis
`ageLabel: "unknown"` → `freshness: "unknown"` → bei operativen Inhalten
`requiresLiveVerification: true`. Genau das hat Bernd beschrieben.

### Die drei Lücken

| # | Pfad | Ort | Symptom |
|---|------|-----|---------|
| A | Canonical-Hits (`KNOWLEDGE.md`) | `index.js:8533-8540` | Item ist `{id, category, source, display}` — **nie** ein Zeitstempel. Immer `age="unknown"`. |
| B | Semantic-Lens-Hits | `index.js:8584-8597` | `r.entry` **trägt** `createdAt`, das Mapping kopiert es nicht. Immer `age="unknown"`. |
| C | Reactivation-Block | `lib/conversation-reactivation-recall.js:648` | Baut eigenes `<memory-record>`-XML, ruft `buildTemporalProvenance` nie auf — `age`/`freshness` fehlen komplett. |

Der reguläre Vektor-/Graph-Pfad (`index.js:8542-8575`) reicht `createdAt`,
`updatedAt`, `lastRetrievedAt` korrekt durch und funktioniert.

### Warum A Bernds konkreter Fall ist

`/root/.openclaw/workspace/memory/KNOWLEDGE.md` (mtime 2026-07-01) enthält genau
eine Sektion `## OpenClaw` mit 9 Operational-Keyword-Treffern (cron, gateway,
deploy, …). Die Live-Config setzt `canonicalFirst: true`, `canonicalMinScore: 0.3`,
`canonicalMaxItems: 5` — Canonical-Treffer werden also bevorzugt eingeblendet.

Ein solcher Treffer rendert als `id="canonical:OpenClaw"` ohne Zeitstempel →
`age="unknown" freshness="unknown"`, wird per Keyword als operational erkannt →
`requiresLiveVerification: true`. Das erklärt Bernds Aussage vollständig, inklusive
seines Schlusses „deshalb prüfe ich den Live-Zustand".

Semantic-Lens ist in der Live-Config **nicht** aktiviert — Lücke B ist latent, nicht
Bernds Fall, wird aber mitgefixt, damit sie beim Aktivieren nicht zuschlägt.

Der Guard selbst ist korrekt und wird **nicht** angefasst: `docs/runbooks/operational-live-verification.md`
benennt `freshness="unknown"` ausdrücklich als Auslöser. Der Fehler liegt davor.

## Entscheidungen

**Canonical-Alter = Datei-mtime + autoritativ.** Canonical-Sections sind keine
DB-Zeilen und haben kein `createdAt`. Als Alter wird die mtime von `KNOWLEDGE.md`
verwendet — sie liegt in `getKnowledgeChunks()` (`lib/recall-pipeline.js:713`)
ohnehin schon vor, da der Chunk-Cache mtime-basiert invalidiert. Zusätzlich werden
Canonical-Treffer als autoritativ markiert und vom Operational-Guard ausgenommen:
kanonische Docs sind das, *wogegen* verifiziert wird (`protect-canonical-docs.sh`
läuft alle 15 Minuten) — sie selbst der Live-Verifikation zu unterwerfen ist
verkehrt herum.

**Rollout als Release 7.2.4** über die bestehende Pipeline (main → Tag →
`plur1bus-release` → Deploy), kein lokaler Hotfix, der beim nächsten
`update-openclaw.sh` überschrieben würde.

## Architektur

Vier kleine, klar abgegrenzte Änderungen. Keine neue Abstraktion, kein neues Modul.

### 1. `lib/recall-pipeline.js` — mtime bis zum Treffer durchreichen

Neuer exportierter Helper `knowledgeMtimeMs(workspaceDir)`, der die mtime von
`memory/KNOWLEDGE.md` liefert (oder `0`, wenn die Datei fehlt). `searchCanonical()`
ruft ihn einmal pro Suche auf und hängt `mtimeMs` an jedes Ergebnis.

Bewusst **nicht** über den Chunk-Cache gelöst: der Cache speichert bereits
persistierte Chunk-Objekte, ein neues Feld dort würde eine Cache-Formatmigration
erzwingen. Ein separater `statSync` pro Recall ist vernachlässigbar.

### 2. `index.js` — die beiden Mappings vervollständigen

Canonical-Item (`:8533-8540`) erhält `createdAt: c.mtimeMs ?? 0` und
`authoritative: true`. Semantic-Lens-Mapping (`:8584-8597`) erhält die drei
Zeitfelder analog zum funktionierenden Vektor-Pfad.

### 3. `lib/temporal-provenance.js` — Autoritäts-Ausnahme

`buildTemporalProvenance()` übernimmt ein `authoritative`-Flag vom Memory-Objekt in
die Provenance. `shouldRequireLiveVerification()` gibt für autoritative Quellen
`false` zurück — die Freshness-Klassifikation selbst bleibt unverändert, das Alter
wird weiterhin ehrlich als `stale` ausgewiesen.

### 4. `lib/relevant-memory-context.js` — Attribut rendern

`buildTemporalAttributes()` gibt `authoritative="true"` aus, wenn gesetzt. Damit
sieht der Agent im Prompt, dass der Eintrag zwar alt, aber die Referenzquelle ist.

### Ergebnis im Prompt

```xml
<memory-record source="knowledge" id="canonical:OpenClaw"
  created-at="2026-07-01T16:49:00Z" age="41d ago" freshness="stale"
  authoritative="true">
```

Statt `age="unknown" freshness="unknown" requires-live-verification="true"`.

## Fehlerbehandlung

- Fehlende/unlesbare `KNOWLEDGE.md` → `knowledgeMtimeMs` liefert `0`;
  `parseMemoryTimestamp(0)` gibt `undefined` → Verhalten fällt exakt auf den
  heutigen Stand zurück (`age="unknown"`). Kein Absturz, keine Regression.
- Semantic-Lens-Entries ohne `createdAt` → `?? 0`, gleiches Fallback wie im
  Vektor-Pfad.
- `authoritative` fehlt → `undefined` → Attribut wird weggelassen, Guard verhält
  sich wie bisher.

## Tests

Ergänzung der bestehenden Suiten, keine neue Testinfrastruktur:

- `tests/temporal-provenance.test.js`: `authoritative: true` unterdrückt
  `requiresLiveVerification` auch bei `freshness: "stale"`/`"unknown"`; ohne das
  Flag bleibt das Verhalten unverändert.
- `tests/relevant-memory-context-temporal.test.js`: Canonical-artiges Item mit
  `createdAt` rendert `age`/`created-at`/`authoritative` statt `unknown`;
  Semantic-Lens-Item mit `createdAt` rendert echtes Alter.
- `searchCanonical` liefert `mtimeMs` auf jedem Treffer (sichert den Feldnamen-
  Vertrag zum Mapping in `index.js` ab); `knowledgeMtimeMs` gibt `0` bei
  fehlender Datei.
- Entartete Zeitstempel (`1e18`, `NaN`, Objekte, Strings) lassen
  `buildTemporalProvenance` nicht werfen und halten `ageLabel` im sicheren Format.

Verifikation end-to-end: nach dem Deploy Bernd erneut nach der Herkunft eines
OpenClaw-Recalls fragen — erwartet wird ein konkretes Alter statt „unknown".

### 5. Härtung — `parseMemoryTimestamp` beschränkt auf den Date-Bereich

Beim Absichern der Attribut-Escapes fiel ein **vorbestehender Crash** auf:
`buildTemporalProvenance()` rief `new Date(ms).toISOString()` ohne Bereichsprüfung
auf. Ein `createdAt` außerhalb ±8.64e15 ms (etwa ein als Nanosekunden
fehlinterpretierter Stempel) wirft `RangeError` und reißt das gesamte
Recall-Rendering ab. In den Live-Daten kommt das nicht vor, aber Lücke B und C
hängen neue, weniger kontrollierte Quellen an diese Funktion.

`parseMemoryTimestamp()` verwirft solche Werte jetzt wie einen fehlenden
Zeitstempel. Damit ist zugleich belegt, dass `ageLabel` immer dem Muster
`/^(unknown|\d+[mhd] ago)$/` genügt — relevant, weil der Reactivation-Block
`untrusted="true"` trägt und das `age`-Attribut dort mit `escapeMemoryText`
(statt des zeichenklassen-verengenden `sanitizeMemoryContextAttribute`) gerendert
wird, um das Leerzeichen in „41d ago" zu erhalten.

### 6. `normalizeEntryForTable` — Default für `createdAt`

`createdAt` war als einziges von rund 50 Feldern ohne Default in der zentralen
Insert-Normalisierung. Ein Writer, der es vergisst, erzeugt eine Zeile, die im
Recall dauerhaft als `age="unknown"` erscheint. **Defense-in-depth ohne
beobachteten Fall** — alle heutigen Writer setzen das Feld explizit.

## Bewusst ausgeklammert

- **Recall-Timeouts** (`recall worker timed out after 12000ms`, bernhardine) — im
  Log gesehen, real, aber ein anderer Bug mit eigener Historie.
- **Kein Backfill / keine Schema-Migration** — durch die Probe widerlegt.
- **`memory_recall`-Textausgabe** (`index.js`, manuelle Tool-Antwort) rendert
  ohnehin keine `age`/`freshness`-Attribute und bleibt unverändert.
