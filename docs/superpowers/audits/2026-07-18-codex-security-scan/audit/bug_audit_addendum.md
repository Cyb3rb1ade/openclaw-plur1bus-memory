# Ergänzung zum Bug- und Zuverlässigkeitsaudit

**Repository:** `/root/openclaw-plur1bus-memory`  
**Commit:** `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`  
**Datum:** 2026-07-18  
**Modus:** Read-only-Ableitung aus validierten File-Review-Receipts; keine Produkt- oder Testdatei verändert

## Einordnung

Dieses Addendum ergänzt [bug_audit.md](bug_audit.md), ersetzt dessen 13 Findings und deren Schweregrade aber nicht. Es bündelt zusätzliche Funktions- und Zuverlässigkeitsbeobachtungen aus den vollständig geprüften Shards 017, 018, 039 und 044 bis 047. Reine Security-Kandidaten werden hier nicht neu bewertet; aufgenommen werden nur ihre unmittelbar belegten Auswirkungen auf Datenintegrität, Betriebsverhalten oder Feature-Verfügbarkeit.

Maßgebliche Belege sind [review-017](../artifacts/02_discovery/file_reviews/review-017.json), [review-018](../artifacts/02_discovery/file_reviews/review-018.json), [review-039](../artifacts/02_discovery/file_reviews/review-039.json), [review-044](../artifacts/02_discovery/file_reviews/review-044.json), [review-045](../artifacts/02_discovery/file_reviews/review-045.json), [review-046](../artifacts/02_discovery/file_reviews/review-046.json) und [review-047](../artifacts/02_discovery/file_reviews/review-047.json).

## Ergänzende Kurzmatrix

| ID | Priorität | Kurzbeschreibung |
| --- | --- | --- |
| BUG-ADD-01 | Hoch | Auto-Capture bestätigt Offsets vor erfolgreicher Persistenz und kann Session-Einträge dauerhaft verlieren |
| BUG-ADD-02 | Hoch | `maintain-lancedb --apply --keep <negativ>` kann sämtliche Manifestversionen auswählen und löschen |
| BUG-ADD-03 | Mittel | `withTimeout()` meldet Abbruch, während schreibende Operationen weiterlaufen und sich mit Retries überlappen können |
| BUG-ADD-04 | Mittel | Neo markiert Embedding-Aufträge als frisch/erledigt, ohne ein Embedding oder einen Vektor zu erzeugen |
| BUG-ADD-05 | Mittel | Neo-Dateiupdates sind nicht serialisiert; Queue und Pending-Map des Workers sind unbeschränkt |
| BUG-ADD-06 | Mittel | Wartungsdoctor ignoriert Kindprozessfehler; Spaltenmigration verwendet den falschen Standardpfad |
| BUG-ADD-07 | Mittel | Deploy-Schutz fällt auf Nicht-Root-Systemen ohne Stub-Prüfer offen aus |
| BUG-ADD-08 | Mittel | Ein Tippfehler im erweiterten Reranker-Dialog deaktiviert Reranking stillschweigend |
| BUG-ADD-09 | Niedrig | Ungültige Zeitzonen und Stundenwerte werden still in fachlich andere Quiet-Hour-Semantik übersetzt |

## Ergänzende Befunde

### BUG-ADD-01 — Hoch — Auto-Capture kann gelesene Session-Einträge dauerhaft überspringen

**Fundstellen:** `scripts/auto-capture-lancedb.mjs:550-560`, `scripts/auto-capture-lancedb.mjs:635-746`.

`captureAgent()` verschiebt den In-Memory-Dateioffset, bevor Embedding und LanceDB-Insert erfolgreich beendet sind, und persistiert diesen Offset auch dann, wenn alle Vektor- oder Insertversuche scheitern. Dadurch gelten nicht gespeicherte JSONL-Einträge beim nächsten Lauf bereits als verarbeitet. Zusätzlich referenziert die Erfolgsrückgabe in Zeile 746 die nur innerhalb der Dateischleife deklarierte Variable `items`; nach dem Schreiben des Zustands kann der Lauf deshalb noch mit `ReferenceError` enden. Eine ersetzte oder rotierte JSONL-Datei wird nicht erkannt, wenn ihre neue Größe kleiner oder gleich dem alten Offset ist.

**Auswirkung:** Session-Inhalte können ohne Wiederholungsmöglichkeit aus der Capture-Pipeline fallen. Monitoring sieht zugleich einen Fehler nach bereits verändertem Checkpoint, was Wiederanlauf und Ursachenanalyse erschwert.

**Teststand:** `tests/auto-capture-import.test.js` und `tests/auto-capture-batch.test.js` bestanden, prüfen laut Receipt aber nur exportierte Stream-/Dedup-Helfer und nicht den vollständigen `captureAgent()`-Fehlerpfad.

**Feature-erhaltende Empfehlung:** Offset und Dateifingerabdruck erst nach erfolgreicher, idempotenter Persistenz aller zugehörigen Einträge committen. Bei Teilerfolg pro Eintrag einen durablen Checkpoint führen. Rotation über Inode/Device oder einen stabilen Dateifingerabdruck erkennen. Rückgabevariablen außerhalb der Schleife definieren und End-to-End-Tests für Embedding-, Insert- und Zustandsfehler ergänzen.

### BUG-ADD-02 — Hoch — Negatives `--keep` kann die LanceDB-Historie vollständig prunen

**Fundstellen:** `scripts/maintain-lancedb.mjs:32-40`, `scripts/maintain-lancedb.mjs:43-86`, `scripts/maintain-lancedb.mjs:105-142`.

Die Argumentprüfung akzeptiert negative Ganzzahlen, weil ein Wert wie `parseInt("-100")` truthy ist. Die nachfolgende Auswahl mit `manifests.slice(-100)` kann bei höchstens 100 vorhandenen Manifesten alle Einträge als zu löschende Menge bestimmen. Mit `--apply` werden diese nach dem Backup entfernt.

**Auswirkung:** Eine formal akzeptierte Wartungsoption kann sämtliche Manifestversionen einer Tabelle entfernen und damit Recovery beziehungsweise Tabellenlesbarkeit gefährden. Der vorhandene Backup-Schritt reduziert, beseitigt aber nicht das Betriebsrisiko.

**Teststand:** Die Repair-Suite bestand und prüft positive Werte wie `--keep 50`, Backup-Erzeugung und den Erhalt von `.lance`-Dateien. Ein negativer, nullwertiger oder übergroßer Grenzfall fehlt.

**Feature-erhaltende Empfehlung:** `--keep` strikt als endliche Ganzzahl `>= 1` validieren, sinnvolle Obergrenze dokumentieren und bei ungültigem Wert vor jeder Enumeration/Mutation mit Fehler abbrechen. Einen Test mit negativer Zahl hinzufügen, der unveränderte Manifeste und einen Nicht-null-Exitcode verlangt.

### BUG-ADD-03 — Mittel — Timeout beendet den Aufrufer, nicht die zugrunde liegende Mutation

**Fundstellen:** `lib/with-timeout.js:1-45`; schreibende Aufrufer unter anderem `index.js:653-657` und `lib/db-adapter.js:150-151`.

`withTimeout()` raced eine bereits gestartete Promise gegen einen Timer. Nach Ablauf wird nur die Wrapper-Promise abgelehnt; die eigentliche Arbeit erhält kein Abort-Signal und läuft weiter. Ein isolierter Probe-Lauf aus review-039 beobachtete den Seiteneffekt nach der bereits gemeldeten Timeout-Ablehnung.

**Auswirkung:** Ein Aufrufer kann nach Timeout erneut versuchen, während der erste Write noch aktiv ist. Das erzeugt mehrdeutige Completion, doppelte Mutationen oder Reihenfolgefehler. Der Befund ergänzt BUG-03 des Hauptaudits: Dort wird der Scheduler-Slot zu früh freigegeben; hier fehlt die Abbruch-/Settlement-Garantie im allgemeinen Timeout-Primitive selbst.

**Teststand:** `tests/with-timeout.test.js` bestand, enthält aber keine Assertion, dass verspätete Seiteneffekte verhindert oder bis zum Settlement serialisiert werden.

**Feature-erhaltende Empfehlung:** Für schreibende Pfade eine abortbare Factory (`signal => promise`) oder eine explizite „Antwort früh, Slot erst nach Settlement frei“-Semantik verwenden. Retries erst nach bekanntem Abschluss starten und Writes zusätzlich idempotent machen. Read-only-Pfade können den bisherigen schnellen Fallback behalten.

### BUG-ADD-04 — Mittel — Neo meldet Embeddings als frisch, ohne Vektoren zu erzeugen

**Fundstellen:** `lib/neo-arch.js:1647-1758`.

Der Embedding-Drain schreibt Status-/Metadatenübergänge bis `fresh` beziehungsweise `done`, ruft aber keinen Embedder auf und persistiert keinen Vektor. `routeNeoRecall()` bleibt dadurch bei lexikalischem Jaccard-/Metadaten-Scoring, obwohl der Zustand erfolgreiche Embedding-Verarbeitung signalisiert.

**Auswirkung:** Qualitätsmetriken und Betriebsdiagnose melden einen Zustand, den die Daten nicht erfüllen. Semantisch ähnliche, lexikalisch abweichende Inhalte werden schlechter gefunden; ein späterer echter Embedder kann erledigt markierte Einträge überspringen.

**Teststand:** Die acht gezielten Neo-/Namespace-/Metrics-Tests aus review-017 bestanden. Sie prüfen laut Receipt nicht, dass ein `fresh` markierter Datensatz tatsächlich einen Vektor besitzt.

**Feature-erhaltende Empfehlung:** Status erst zusammen mit dem durablen Vektor committen. Fehlt ein konfigurierter Embedder, den Auftrag sichtbar als `deferred`/`unavailable` belassen. Ein Integrationstest muss bei `fresh` einen dimensionsrichtigen Vektor und einen semantisch beobachtbaren Recall-Effekt verlangen.

### BUG-ADD-05 — Mittel — Neo-Dateischreiber können Updates verlieren und unbegrenzt Arbeit anstauen

**Fundstellen:** `lib/neo-arch.js:1416-1524`, `lib/neo-worker-runtime.js:1-218`.

JSONL-, Index- und Cap-Aktualisierungen verwenden mehrere ungesperrte Read-Modify-Write-Sequenzen zwischen Main-Thread-/Command- und Worker-Schreibern. Der best-effort Cap kann einen parallel erfolgten Append überschreiben. Der Worker serialisiert zwar seine eigene Ausführung, begrenzt aber weder Queue noch Pending-Map und besitzt keine eingebaute Deadline.

**Auswirkung:** Bei überlappenden Schreibern können Index-/Dedup-Zustand oder angehängte Records verloren gehen. Bei anhaltender Last wächst der ausstehende Workerzustand ohne feste Grenze und kann Speicher sowie Antwortlatenz erhöhen.

**Feature-erhaltende Empfehlung:** Alle Neo-Dateimutationen pro Workspace über denselben atomaren Queue-/Lock-Pfad führen, Append und Cap nicht als getrennte ungeschützte Operationen behandeln und Queue-Länge, Alter sowie Deadline konfigurieren. Backpressure soll neue Arbeit ablehnen/verschieben, nicht bestehende Records verwerfen.

### BUG-ADD-06 — Mittel — Wartungserfolg und Migrationsziel werden falsch bestimmt

**Fundstellen:** `scripts/repair-installed-plugin.mjs:195-221`, `scripts/migrate-missing-columns.mjs:24`, `scripts/migrate-missing-columns.mjs:80-96`.

Der Repair-Doctor startet die optionale LanceDB-Wartung in Zeile 199, wertet Status/Fehler des Kindprozesses aber nicht aus und diagnostiziert anschließend nicht erneut. Ein fehlgeschlagener Prune kann dadurch wie ein abgeschlossener Reparaturlauf erscheinen. Die Spaltenmigration verwendet standardmäßig den Namespace-Basispfad, obwohl die dokumentierte Architektur die `memories`-Tabelle je Agent in einem Kindverzeichnis speichert; ohne manuell angegebenen Agent-Pfad findet die Migration die Tabelle nicht.

**Auswirkung:** Automatisierung erhält keinen verlässlichen Reparaturstatus, und die Standardmigration greift auf normalen Installationen nicht auf die betroffenen Tabellen zu.

**Teststand:** `tests/repair-scripts.test.js` bestand, prüft aber nicht Kindprozessfehler beziehungsweise eine per-Agent-Standardmigration.

**Feature-erhaltende Empfehlung:** Kindprozessstatus, Signal und Timeout explizit auswerten, danach denselben Check erneut durchführen und den Exitcode aus dem verifizierten Endzustand ableiten. Migrationen sollen sichere Agent-Verzeichnisse enumerieren, jede Tabelle separat berichten und weiterhin einen expliziten Einzelpfad unterstützen.

### BUG-ADD-07 — Mittel — Deploy-Schutz überspringt die Stub-Prüfung außerhalb der Root-Installation

**Fundstellen:** `scripts/protect-plur1bus-deploy.sh:111-132`.

Der Stub-Checker ist auf `/root/scripts/lib/deploy-integrity.mjs` fest verdrahtet. Fehlt diese Datei, liefert `source_file_is_broken_stub` einen Fehlerstatus, den der aufrufende `if`-Zweig wie „Quelle ist nicht kaputt“ behandelt und anschließend kopiert. Damit fällt die Schutzlogik genau dann offen aus, wenn ihre Prüfinstallation nicht dem hart kodierten Root-Pfad entspricht.

**Auswirkung:** Nicht-Root- oder abweichende Deployments können eine ungeprüfte Re-Export-Stub-Quelle in die produktive Extension übernehmen. Die getrackte Vorlage weist zudem darauf hin, dass ihre Produktionskopie nicht automatisch synchronisiert wird.

**Feature-erhaltende Empfehlung:** Checker relativ zum Skript beziehungsweise zur validierten Repository-Quelle auflösen. „Prüfer fehlt/fehlerhaft“ muss ein eigener fail-closed Zustand sein; nur ein erfolgreiches „kein kaputter Stub“ darf die Kopie erlauben. Vor dem Kopieren weiterhin Backup und Hashvergleich beibehalten.

### BUG-ADD-08 — Mittel — Ungültige Reranker-Auswahl deaktiviert das Feature still

**Fundstellen:** `scripts/provider-wizard.mjs:128-138`.

Im erweiterten Reranker-Dialog führt jede Eingabe außerhalb der vorgesehenen Auswahl `a/b/c` direkt zu `provider: "disabled"`, statt erneut zu fragen oder einen Fehler auszugeben.

**Auswirkung:** Ein Tippfehler wird als bewusste Funktionsabschaltung persistiert. Das widerspricht dem Ziel, bestehende Features zu erhalten, und ist besonders schwer zu erkennen, wenn die restliche Provider-Konfiguration erfolgreich aussieht.

**Teststand:** Provider-Wizard- und Config-Tests bestanden, decken laut review-046 aber weder einen echten TTY-Dialog noch den ungültigen Auswahlzweig ab.

**Feature-erhaltende Empfehlung:** Ungültige Eingaben mit klarer Meldung erneut abfragen; Deaktivierung nur über eine explizite, bestätigte Option zulassen. Den finalen Plan vor Ausgabe zusammenfassen und `disabled` als bewusste Entscheidung kennzeichnen.

### BUG-ADD-09 — Niedrig — Quiet-Hour-Konfiguration fällt still auf andere Semantik zurück

**Fundstellen:** `lib/time-window.js:39-46`, `lib/time-window.js:60-66`.

Eine ungültige Zeitzone fällt ohne sichtbare Diagnose auf die lokale Serverzeit zurück. Ganzzahlige Start-/Endstunden werden nicht auf `0..23` begrenzt. Zusätzlich wächst der pro Prozess gehaltene Formatter-Cache ohne Maximalzahl, falls viele unterschiedliche Zeitzonen konfiguriert werden.

**Auswirkung:** Afterthought-/Ruhefenster können zu anderen Zeiten als konfiguriert aktiv sein. Das ist bei operatorseitiger Konfiguration kein eigenständiger Security-Befund, aber ein nachvollziehbarer Vertrags- und Observability-Fehler.

**Feature-erhaltende Empfehlung:** Zeitzone und Stunden beim Konfigurationsladen validieren, ungültige Werte sichtbar ablehnen und den Formatter-Cache begrenzen. Kein Fallback darf eine andere Zeitzone vortäuschen; ein explizit dokumentierter Default bleibt möglich.

## Empfohlene Regressionstests

1. Auto-Capture: Offset bleibt bei vollständigem Embed-/Insert-Fehler unverändert; Teilerfolg wird idempotent wiederaufgenommen; Rotation trotz kleinerer Datei wird erkannt; erfolgreicher Lauf wirft keinen Scope-Fehler.
2. LanceDB-Wartung: `--keep -1`, `0`, Float, `NaN` und fehlender Wert brechen vor Backup/Delete mit unverändertem Verzeichnis ab.
3. Timeout: verspätete schreibende Promise plus Retry erzeugt genau eine Mutation und nie zwei gleichzeitig aktive Writes.
4. Neo: `fresh` impliziert einen durablen Vektor; paralleler Append/Cap verliert keine Row; Queue-Limit und Deadline liefern strukturiertes Backpressure.
5. Repair/Migration: fehlschlagender Kindprozess propagiert einen Fehler; erfolgreiche Wartung wird erneut verifiziert; Standardmigration findet zwei sichere Agent-Tabellen.
6. Provider/Zeitraum: ungültige Auswahl deaktiviert nichts; ungültige Zeitzone/Stunde wird mit präzisem Konfigurationsfehler abgewiesen.

## Priorisierung

1. BUG-ADD-01 und BUG-ADD-02 vor weiteren Capture-/Wartungsläufen wegen möglichem dauerhaftem Datenverlust.
2. BUG-ADD-03 bis BUG-ADD-06 wegen konkurrierender Writes, falscher Erfolgszustände und ausbleibender Migration.
3. BUG-ADD-07 und BUG-ADD-08 vor breiterer nicht-root Installation beziehungsweise Provider-Onboarding.
4. BUG-ADD-09 als Konfigurations- und Diagnosehärtung, ohne Afterthought oder Quiet Hours abzuschalten.

