## PLUR1BUS Memory v6.9.8 — Neo-Recall-Dedupe-Fix

### Problem

Neo-Recall konnte dieselbe Memory-Record-ID mehrfach in einem Recall-Block rendern, wenn der gleiche Record mehrfach in den Kandidaten auftauchte und in mehreren Lanes über dem Score-Threshold lag.

Ein gemeldetes Live-Beispiel war `mem_c1831bfc268bcb3ae451`: derselbe Inhalt erschien insgesamt 8-mal, je 2-mal in `recent_turns`, `workspace_facts`, `architecture_decisions` und `technical_constraints`.

### Fix

`routeNeoRecall()` dedupliziert jetzt zuerst identische Input-IDs und sortiert danach alle Lane-Kandidaten global nach Score. Jede Record-ID wird nur einmal ausgegeben und landet in der bestbewerteten verfügbaren Lane.

### Impact

- Kein Setup- oder `/plur1bus start`-Schritt nötig.
- Keine Datenmigration.
- Keine Schemaänderung.
- Bestehende Memories bleiben unverändert; betroffen ist nur die Recall-Block-Formatierung.

### Verification

```bash
node tests/smoke-neo.test.js
node --test tests/smoke-neo.test.js tests/relevant-memory-context-trace.test.js tests/recall-e2e.test.js
node --test tests/*.test.js
```

Zusätzlich wurde der Fix in der installierten Extension verifiziert: die gemeldete Record-ID wird in der Repro nur noch 1-mal gerendert.
