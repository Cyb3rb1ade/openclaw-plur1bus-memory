# Final Review Fix Report (feat/llm-result-cache)

> Hinweis: Die frühere Version dieser Datei beschrieb fälschlich Fixes an
> `lib/afterthought.js` aus einem anderen Repository-Zyklus und dokumentierte
> die Fixes dieses Branches nicht. Sie wurde am 2026-07-18 durch diesen
> korrekten Report ersetzt.

## Scope

Behebt die vier Important-Findings aus `final-review-findings.md` auf Basis
`7084476` (main). Geänderte Dateien:

- `lib/llm-result-cache.js`
- `tests/llm-result-cache.test.js`

## Fixes

### Finding 1 — invalide Ergebnisse wurden gecacht (Commit `d2e380c`)

`getOrCompute` cached jetzt nur noch Ergebnisse mit nicht-leerem `text`;
bei `jsonMode: true` muss der Text zusätzlich `JSON.parse` bestehen.
`null`, leere/Whitespace-Strings und malformed JSON werden unverändert an den
Caller zurückgegeben, landen aber weder im Memory-Cache noch in SQLite.
Regressionen decken Memory- und Persistenz-Pfad je Kategorie ab, inklusive
Reopen-Verifikation und dem Positivfall (valides JSON bleibt cachebar).

### Finding 2 — Coalesced Waiter zählten vermiedene Tokens nicht (Commit `d2e380c`)

Der `inFlight`-Zweig ruft für jeden erfolgreichen Waiter einmal
`recordHitUsage` auf; abgelehnte geteilte Computes zählen nichts.
`coalesced` bleibt eine eigene Request-Kategorie, `hits` wurde nicht
verbreitert. Tests: mehrere konkurrente Waiter addieren die vermiedenen
Input-/Output-Tokens je einmal; partielle Usage inkrementiert
`hitsMissingUsage` pro Waiter; Rejections zählen keine Usage.

### Finding 3 — SQLite-Size-Cleanup konnte Platz nicht zuverlässig freigeben (Commit `d2e380c`)

`trimToSize` checkpointet/truncatet die WAL vor der Neuvermessung
(`compactAndMeasure`), evictet gebunden die ältesten Zeilen Richtung
90%-Soft-Target und versucht am Hard-Limit erst Cleanup, bevor ein Write
übersprungen wird. Passt der physische Overhead trotzdem nicht, wird nur der
Persist-Write geskippt; der Memory-Cache bleibt intakt. Tests mit echtem
`node:sqlite`: Multi-Row-Soft-Limit-Eviction, WAL-lastiges Cleanup, Recovery
nach Hard-Limit.

### Finding 4 — frische Persistenz-Basis konnte nicht initialisieren (Commit `c6cdf30`)

`openDb` legt die konfigurierte Basis jetzt mit
`mkdirSync(baseDbPath, { recursive: true, mode: 0o700 })` an, **bevor**
`resolveInside(baseDbPath)` realpatht. `safeAgentId()` und `resolveInside()`
bleiben für die per-Agent-Subpfade erhalten (Traversal-/Symlink-Schutz
unverändert). Tests: absente Cache-Basis unter existierendem Parent →
Persist-Write gelingt, DB-Mode `0600`, Close/Reopen-Persistent-Hit,
Isolation zwischen Agent-Scopes.

## Nacharbeit Audit 2026-07-18 (uncommitted zum Report-Zeitpunkt)

- Clamps für `llmResultCacheMaxEntries` (≤ 10.000) und
  `llmResultCacheMaxBytes` (≤ 1 GiB) mit Warn-Log; Doku nachgezogen.
- Expired-Row-Sweep bei Open und Close (max. 16×256 Zeilen, bounded);
  `close()` drained zusätzlich in-flight Computes.
- Die zwischenzeitlich ergänzten `"maximum"`-Constraints im
  `openclaw.plugin.json`-Schema wurden wieder entfernt: Der OpenClaw-Loader
  validiert das Schema hart (TypeBox) und überspringt das Plugin bei
  Verstoß komplett (`invalid config` → `continue`), was der
  Clamp+Warn-Semantik und der Fail-open-Philosophie widerspricht.

## Verifikation

`node --test tests/llm-result-cache.test.js tests/config-audit.test.js`

```text
ℹ tests 163
ℹ pass 163
ℹ fail 0
```

(Node v24.15.0, echtes `node:sqlite`; Lauf vom 2026-07-18 inkl. der
Audit-Nacharbeit.)
