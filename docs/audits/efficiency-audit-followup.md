# Efficiency Audit Follow-up

## Status

Die Hauptarbeit des Efficiency Audits wurde in PLUR1BUS v6.6.0 umgesetzt. Die folgenden Punkte wurden **bewusst zurückgestellt** und sind für ein Folgerelease vorgesehen.

## Nicht umgesetzte Audit-Punkte

### 1. Store-Helper-Refactor

**Beschreibung:** Vereinheitlichung der verschiedenen Memory-Store-Helper (LanceDB, Neo-Arch, Obsidian-Bridge) auf gemeinsame Schreib-/Lese-Pfade.

**Grund für Rückstellung:** Hohes Refactoring-Risiko kurz vor Release; die bestehenden Pfade sind stabil und ausreichend getestet. Eine Vereinheitlichung erfordert tiefere Änderungen an `lib/memory-store.js`, `lib/neo-arch.js` und der Obsidian-Bridge-Schicht.

**Folgeaufgaben:**
- Gemeinsame Interface-Definition für Store-Operationen erstellen.
- Bestehende Adapter schrittweise migrieren.
- Regressionstests für alle Store-Pfade erweitern.

### 2. Semantic Conflict Graph Cap

**Beschreibung:** Obergrenze für die Größe des semantischen Konflikt-Graphen, um Speicher- und Laufzeitkosten bei großen Workspaces zu begrenzen.

**Grund für Rückstellung:** Konflikterkennung funktioniert aktuell korrekt; ein Hard-Cap benötigt eine klare Evictions-Strategie, um keine kritischen Konflikte zu verlieren.

**Folgeaufgaben:**
- Cap konfigurierbar machen (z. B. `semanticConflictGraph.maxNodes`).
- Eviction-Strategie festlegen (z. B. nach Alter oder Relevanz).
- Tests für Grenzfälle ergänzen.

### 3. KNOWLEDGE.md Cache-Key Provider/Dim

**Beschreibung:** Cache-Schlüssel für `KNOWLEDGE.md` sollen Provider und Embedding-Dimension berücksichtigen, damit unterschiedliche Konfigurationen nicht auf denselben gecachten Stand zugreifen.

**Grund für Rückstellung:** Derzeitige Cache-Invalidierung ist ausreichend für den Standard-Anwendungsfall; Mehrfachkonfigurationen sind noch selten.

**Folgeaufgaben:**
- Cache-Key-Schema erweitern um `provider`, `dimensions` und ggf. `model`.
- Bestehende Cache-Einträge invalidieren oder versionieren.
- `lib/knowledge-cache.js` oder entsprechendes Modul anpassen.

### 4. KNOWLEDGE Update Chunking

**Beschreibung:** Große `KNOWLEDGE.md`-Updates sollen in kleinere Chunks aufgeteilt werden, statt den gesamten Inhalt auf einmal zu verarbeiten.

**Grund für Rückstellung:** Verbessert zwar Speicherverbrauch und Stabilität bei großen Dateien, erfordert aber eine neue Chunking- und Zusammenführungslogik inklusive Fehlerbehandlung für partielle Updates.

**Folgeaufgaben:**
- Chunking-Strategie definieren (z. B. nach Abschnitten oder Token-Grenzen).
- Inkrementelles Anwenden von Updates implementieren.
- Tests für partielle und vollständige Updates ergänzen.

### 5. Neo Hook-State Debounce

**Beschreibung:** Entprellen von Hook-Aufrufen im Neo-Arch-Bereich, um wiederholte Speicher-/Rechenoperationen innerhalb kurzer Zeitfenster zu vermeiden.

**Grund für Rückstellung:** Debounce-Logik kann in bestimmten Szenarien zu verzögerten Updates führen; genaues Verhalten muss vor Einführung validiert werden.

**Folgeaufgaben:**
- Debounce-Parameter konfigurierbar machen.
- Relevante Hooks identifizieren (`agent_end`, `before_prompt_build`, ggf. Cron).
- Tests für sequentielle und parallele Hook-Aufrufe ergänzen.

### 6. Inkrementeller Obsidian Scanner

**Beschreibung:** Der Obsidian-Vault-Scanner soll nur geänderte Dateien neu einlesen, statt bei jedem Lauf den gesamten Vault zu traversieren.

**Grund für Rückstellung:** Vault-Scan ist aktuell noch ausreichend schnell für typische Vault-Größen; inkrementelles Scannen erfordert einen zuverlässigen Zustandsspeicher und Konsistenzprüfungen.

**Folgeaufgaben:**
- Scan-State (z. B. MTIME-Index oder Hash-Index) persistieren.
- Initial-Scan vs. inkrementeller Scan unterscheiden.
- Tests für Dateiänderungen, Löschungen und Umbenennungen ergänzen.

## Empfehlung

Diese Punkte sollten in einem separaten Post-v6.6.0-Release-Plan priorisiert und je nach Nutzungsgrad und Messbarkeit des Nutzens umgesetzt werden. Bis dahin bleibt die aktuelle Implementierung unverändert, um keine Stabilität zu riskieren.
