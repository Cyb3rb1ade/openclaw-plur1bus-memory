# GP5 R3: Restore-Gates vor der Umsetzung

Stand: 21.10.2026. **Nur Gate-Analyse und offene Abnahmespezifikationen. R3 ist nicht behoben und nicht als Produktfunktion umgesetzt.**

## Verbindliche Voraussetzung

Der Auftrag erlaubt die R3-Implementierung **erst nach dem Merge von Engine #259 und #268**. Vor Beginn wurden `origin/main`, offene PRs und beide PR-Heads erneut geprüft:

| Quelle | Geprüfter Stand | Gate |
|---|---|---|
| Engine `origin/main` | `98dfe2f03363f6291daa9f85e473578770fb5c55`, Merge von #253 | Basis dieses frischen Worktrees |
| [#259](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/pull/259), `fix/store-tombstones-restore` | **OPEN**, `1878af0b6b7eeaeba657f9d98f01a7bae5da26d8` | noch nicht erfüllt |
| [#268](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/pull/268), `fix/memory-tools-snapshot` | **OPEN**, `ad85a5b88a1ddba6a0f0141b69582ca39cecc07b` | noch nicht erfüllt |

Die beiden Branches wurden nur über Git-Objekte gelesen. Kein Merge, Cherry-pick, Rebase, Restore-Prototyp oder Vorgriff auf deren Produktionscode. Ein Analyse-PR gegen main kann diesen Stand dokumentieren; er öffnet das Implementierungsgate nicht. Der Controller integriert die Voraussetzungen. Bei Wiederaufnahme sind Status, Merge-Commits und der tatsächlich integrierte Code erneut zu prüfen; die hier genannten PR-Heads sind keine automatische Freigabe.

## Warum die Reihenfolge nötig ist

- **#259** ergänzt Tombstone-Reapply und das Restore-Journal. Der gelesene Branch enthält `recoverInterruptedRestoreSync`, `<baseDbPath>.pending-restore`, den abschließenden Tombstone-Schritt und die Fehlerbehandlung, wenn er scheitert. Eine vorher separat entworfene Sperre könnte nach Integration falsche Mutationsgrenzen schützen oder die Wiederaufnahme unterbrechen.
- **#268** trennt die Restore-Kernoperation von optionaler Aufbewahrung, ergänzt `purgePreRestore` und Workspace-Quellen. Der Default bleibt nur expliziter Purge; ein Pending-Journal verhindert das Löschen früherer Kopien. Die dort offenen Owner-Fragen werden von R3 nicht still entschieden.
- Beide PRs ändern `lib/snapshot/store-snapshot.js`; ihre Beschreibungen nennen einen Integrationskonflikt am Ende des Restore-Swaps. Erst den zusammengeführten Ablauf prüfen, dann Writer-Sperre, Cache-Ausnahme und CLI-Bestätigung darauf aufbauen.

## Ist-Zustand auf main

| Pfad | Tatsächlicher Ablauf | Fehlende R3-Zusicherung |
|---|---|---|
| `lib/snapshot/store-snapshot.js:721`, `restoreSnapshot` | prüft Pfade und Snapshot, kopiert in ein Staging-Verzeichnis, benennt den alten Store um, tauscht die Kopie ein und synchronisiert das Elternverzeichnis | weder Writer-Zulassung noch `force`-Option, kein R3-Dry-run-Vertrag |
| `scripts/snapshot-store.mjs:44-81` | kennt Wertoptionen und `--json`; `restore` ruft unmittelbar die Bibliotheksfunktion auf | kein Default-Dry-run, kein `--confirm`, kein `--force` |
| `scripts/restore-snapshot.sh:6-19` | `DRY_RUN=true`, erst `--confirm` setzt Live-Modus | dient nur als Vorbild der ausdrücklichen Bestätigung; ist kein Beleg für einen Writer-Schutz im Node-Pfad |
| `lib/memory-maintenance-gate.js:5-52` | pro Gate-Instanz eine Lease, optional extern gelesener aktiver Zustand | allein keine prozessübergreifende Erkennung aller laufenden Engine-Writer |
| `engine/create-engine.js:816-829` | externes Gate liest eine Reembedding-Migration im Zustand `switching` | aktive Engine und aktive Schreibarbeit sind nicht gleichbedeutend mit einem laufenden Reembedding-Switch |
| `engine/stores/adopt.js:8` | weist ausdrücklich darauf hin, dass die Engine `state/core.lock` nicht selbst nimmt | ein nur vom Harness gehaltener Lock darf nicht als universeller Engine-Writer-Nachweis vorausgesetzt werden |
| `lib/snapshot/store-snapshot.js:347-371,473-514` | der Store wird rekursiv kopiert; nur LanceDB-Tabellen bekommen die besondere Konsistenzprüfung | keine Ausnahme für den ableitbaren LLM-Ergebniscache |
| `lib/llm-result-cache.js:358-364` | persistenter Cache unter `<baseDbPath>/llm-result-cache-v1/<agentId>.db`, SQLite mit WAL | eine gewöhnliche Datei-/Verzeichniskopie ist kein konsistenter Cache-Snapshot |

Die bestehenden Sicherheits- und Wiederherstellungsmechanismen sind damit nicht pauschal wirkungslos: Der Snapshot-Code prüft beispielsweise Hashes und LanceDB-Manifeste und hält eine vorherige Store-Kopie vor. Sie ersetzen jedoch nicht die konkret angeforderten R3-Gates. Aus dieser Quellprüfung wird kein tatsächlich eingetretener Datenverlust behauptet.

## Abnahme nach beiden Merges

Die zehn neuen `test.todo`-Einträge in `tests/gp5-restore-gates-analysis.test.js` sind **offene Spezifikationen**, keine bestandenen Produktprüfungen. Nach Öffnung des Gates sind daraus echte Regressionen gegen temporäre Stores und getrennte Prozesse zu machen:

1. **Laufender Writer:** Restore ohne Force ablehnen, bevor Ziel, Cache, Journal, vorherige Kopien, Snapshot oder Staging verändert werden. Inhalt, relevante Dateimetadaten und Verzeichnisliste davor/danach vergleichen. Der aktive Writer läuft weiter und kann seine eigenen Daten weiterhin lesen.
2. **Prozessgrenze und Rennen:** Ein Writer startet zwischen Vorprüfung und Swap; die spätere Prüfung muss den Konflikt ebenfalls verhindern. Die Zulassung muss über die ganze kritische Phase exklusiv bleiben. Keine nur prozesslokale Variable oder bloße zeitlich vorgelagerte Lockdatei-Abfrage als Beweis verwenden. Owner-/Lease-Identität sowie veraltete Locks gezielt prüfen.
3. **Node-CLI:** Ohne `--confirm` nur einen Plan liefern und nichts schreiben; ausdrücklich bestätigter Restore bei gestoppter Engine funktioniert. `--json` folgt demselben Gate. Fehler-/Usage-Ausgaben und Exitcodes gegen reale CLI-Aufrufe prüfen. Dry-run ist keine Zusicherung, dass eine spätere Ausführung noch dieselbe Writer-Lage vorfindet.
4. **Force:** Gegen eine aktive Engine nur mit ausdrücklicher Force-Anforderung und klarer Warnung über laufende Writer und möglichen Datenverlust fortfahren. `--force` ersetzt nicht `--confirm`. Force beweist weder Snapshot-Konsistenz noch verlustfreies Weiterlaufen eines alten Writers; keine entsprechende Zusage machen. Die genaue Force-Zulassung nach Prüfung des integrierten Locks festlegen, nicht aus Routing- oder PID-Defaults erraten.
5. **Neue Snapshots:** Den exakten Unterbaum `llm-result-cache-v1` einschließlich DB-, WAL- und SHM-Dateien aus Kopie und Manifest ausnehmen. Keine breite Ausnahme für andere SQLite-Dateien oder ähnlich benannte authoritative Daten. Verbleibende Dateien weiter vollständig verifizieren.
6. **Alte Snapshots:** Ein noch Cache-Dateien enthaltender Snapshot bleibt anhand seines unveränderten Manifests verifizierbar. Beim Restore werden keine alten Cache-Antworten aktiviert. Wie alte Manifest-Einträge bei der Prüfung der bereinigten Restore-Kopie behandelt werden, muss ausdrücklich getestet werden; das Originalmanifest nicht still umschreiben.
7. **Ablehnung und Fehler:** Die Cache-Leerung darf erst Teil des zugelassenen Restore-Ergebnisses sein. Eine verweigerte Zulassung leert keinen laufenden Cache und ändert keine fremde Writer-Lease. Auch zu wenig Speicherplatz und ungültige Snapshot-Hashes müssen vor dem Swap sicher scheitern.
8. **#259 erhalten:** Crash-Schnitte vor/nach jedem Rename, Wiederaufnahme eines Pending-Journals, committed Tombstones und Fehler beim Reapply prüfen. Ein fehlgeschlagener Reapply darf keinen falschen Erfolg melden. Die rücknehmbare vorherige Kopie erhalten.
9. **#268 erhalten:** Workspace-Quellen, explizite und Standardpfade, alte Snapshot-Layouts sowie opt-in Aufbewahrung/Purge prüfen. Bei Pending-Journal nicht purgen; den bisherigen Default nicht nebenbei verändern.
10. **Frischer Cache:** Nach erfolgreichem Restore keine persistierten alten Cache-Antworten verwenden; leerer Cache beziehungsweise neue leere Cache-Datei beim ersten Zugriff, mit den bestehenden privaten Verzeichnis-/Dateirechten. Keine DB-/WAL-Rohkopie wieder einschleusen.

Zusätzlich gelten die vorhandenen `AGENTS.md`-Vorgaben für destruktive Vorgänge, Pfadprüfung, Fehlerbehandlung und Audit. Neue Runtime-Exports benötigen JSDoc. Die spätere Umsetzung führt die bestehenden Snapshot-/Tombstone-/Crash- und Maintenance-Tests der integrierten Basis weiter aus; keine vorhandenen Tests streichen oder lockern.

## Prüfung dieser Analyse

- `AGENTS.md`, die genannten Produktionspfade und beide offenen PR-Versionen gelesen.
- Node 24.21: Syntaxprüfung der neuen TODO-Datei; `tests/memory-maintenance-gate.test.js` zusammen mit den neuen TODO-Spezifikationen ausgeführt. Die drei vorhandenen Gate-Tests prüfen nur den bestehenden Reembedding-Gate, keine R3-Restore-Sperre.
- Die zehn neuen Fälle bleiben TODO. Ein erfolgreicher Prozess-Exit ist keine R3-Abnahme. Keine Fake-Engine, kein Netzwerkmodell, keine Live-Nutzerdaten und kein echter Restore für diese Analyse verwendet.
- Kein vollständiger Snapshot-/LanceDB-Testlauf oder plattformübergreifender Restore-Nachweis behauptet. Keine Produktionsdatei, Abhängigkeit oder Lockdatei geändert; Contract bleibt `1.16.0`.

## Fortsetzung für den Controller

Wenn beide PRs gemergt sind, deren tatsächliche Integration einschließlich Konfliktauflösung prüfen und den Stand hier ersetzen. Danach Implementierung mit zunächst roten Regressionen für Writer-Ablehnung und Node-CLI-Dry-run beginnen; Cache-/Altformatfälle und Crash-Schnitte anschließen. R3 bleibt bis zu diesen bestandenen Abnahmen offen. Dieser Analyse-PR erlaubt ausdrücklich keinen Restore-Code vor Erfüllung der Merge-Voraussetzungen und ändert keine laufende Installation.
