## PLUR1BUS Memory v6.9.9 — Neo-Recall-Formatter-Dedupe

### Problem

v6.9.8 deduplizierte Neo-Recall-Record-IDs im Router. Ein Live-Recall zeigte aber weiterhin dieselbe `mem_*`-ID mehrfach across Lanes, wenn bereits vorgeroutete Lane-Daten direkt in den Formatter gelangten.

Gemeldetes Beispiel: `mem_2060048051c578719304` erschien 7-mal über `recent_turns`, `architecture_decisions`, `technical_constraints` und `tooling_constraints`.

### Fix

`formatNeoRecallContext()` dedupliziert jetzt zusätzlich global nach Record-ID. Damit ist die Render-Grenze selbst abgesichert: selbst wenn ein vorgelagerter Pfad doppelte Lane-Zeilen liefert, wird jede `mem_*`-ID nur einmal als `<memory-record>` ausgegeben.

### Impact

- Kein `/plur1bus start` nötig.
- Keine Datenmigration.
- Keine Schemaänderung.
- Bestehende Memories bleiben unverändert.

### Verification

```bash
node tests/smoke-neo.test.js
node --test tests/smoke-neo.test.js tests/relevant-memory-context-trace.test.js tests/recall-e2e.test.js
npm run lint
npm test
```

Der neue Regressionstest schlug vor dem Fix mit `7 !== 1` fehl und besteht nach dem Fix. Die vollständige Test-Suite läuft mit 234 passing, 0 failing.
