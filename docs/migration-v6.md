# Migration v5 → v6 — PLUR1BUS Full Experience Defaults

**Version:** 6.7.0 (PLUR1BUS Full Experience Defaults)
**Datum:** 2026-06-19

---

## Zusammenfassung

Version v6.7.0 führt das **PLUR1BUS Full Experience Policy**- und **Temporal Continuity**-System ein.
Bei der Migration von v5.x auf v6.7.0 wird das LanceDB-Datenbankschema automatisch beim ersten Start (`init()`) erweitert. Es ist **keine manuelle DDL-Schema-Migration** oder Datenkonvertierung notwendig.

---

## Was sich ändert

### Automatische Schema-Migration (nicht-destruktiv)
Die LanceDB-Tabellen werden beim ersten Start automatisch um folgende Spalten erweitert:
`status`, `versionNumber`, `previousVersion`, `supersededBy`, `updateSource`, `updateEvidence`, `reconsolidationConfidence`, `versionCreatedAt`, `updatedAt`.

### Neue Defaults (wirken automatisch bei Neuinstallationen)
Frische Installationen aktivieren standardmäßig das komplette PLUR1BUS-Erlebnis:
- **`temporalContext`**: ON (Temporal Continuity Context für Agenten-Zeitempfinden)
- **`embeddingCacheEnabled`**: ON (LRU-Cache für Vektoren)
- **`reranker`**: ON (Cohere/lokaler Reranker)
- **`emotion.t2`**: ON
- **`emotion.t3`**: ON (provider-gated/fail-soft)
- **`metaCognition` / `metaCognition.llmReport`**: ON (LLM-Reflection, budgeted/fail-soft)
- **`merging.enabled` / `merging.autoApply`**: ON (nur für Low-Risk-Änderungen)
- **`obsidianBridge` / `dashboardLayer` / `semanticGraph` / `provenanceGraph`**: ON
- **`soulPatch.enabled` / `soulPatch.createIfMissing` / `soulPatch.backup`**: ON
- **`schicht15` / `skillMiner` / `dailyConsolidation`**: ON

### Upgrade-Verhalten für bestehende v5/v6-Installationen
- **Konfigurationserhalt**: Bereits gesetzte Feature-Werte bleiben die Source of Truth (kein Überschreiben bestehender Einstellungen).
- **Missing Features**: Neue Features, die in der alten Config fehlen, werden als **enabled by default** (opt-out) ergänzt.
- **Keine History**: Es wird kein separates Feature-Selection-History-Ledger geschrieben (kein `fullExperiencePromptedAt`, `explicitOptOuts` oder `featuresConfirmedAt`).
- **Non-interactive Updates**: Upgrades via `--non-interactive` / `--accept-defaults` blockieren nicht; sie aktivieren fehlende Core-Features und hinterlegen eine Start-Notice.

### Installations-Abschluss: `/plur1bus start`
Der Wizard/Start-Command zeigt den aktuellen Status der Features, Safety-Gates und Obsidian/Reviews/Dashboard-Pfade an und konsumiert eine eventuell vorhandene Start-Notice. Er schreibt keine History und erzeugt keine Memories.

---

## Sicherheitsrichtlinien & Safety Gates
- **`soulPatch.force`**: Standardmäßig OFF.
- **`soulPatch.migrateLegacy`**: Standardmäßig OFF. Legacy-Migrationen verlangen Bestätigung und Backup.
- **Merge-Risiko**: `merging.autoApplyRisk` ist auf `"low-only"` gesetzt. High-Risk Merges verbleiben als Proposals.
- **`semanticGraph.mutateMemory`**: Standardmäßig `false` (keine automatische Textänderung von Memories).
- **Obsidian Bridge**: Schreibt nicht unbefugt in `.obsidian` (`allowDotObsidianWrite: false`). Wenn kein gültiger Vault-/Workspace-Pfad konfiguriert ist, bleiben alle Bridge-Features aktiv aber inert (kein Erfinden willkürlicher Pfade).

---

## Rollback

Falls Probleme auftreten, kann jederzeit auf den vor-v6 Commit oder die alte Version zurückgesetzt werden:
1. Plugin-Verzeichnis aus dem Backup wiederherstellen oder per Git auf den gewünschten Stand zurücksetzen.
2. In `openclaw.json` ggf. neue Config-Keys entfernen.
3. Die LanceDB-Tabellen sind abwärtskompatibel; neu hinzugefügte Spalten werden von der alten Version ignoriert.
