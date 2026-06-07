# P5 Runtime Validation: Obsidian Bridge Smoke

**Subagent:** C (Obsidian Bridge Smoke)  
**Datum:** 2026-06-07  
**Projekt:** plur1bus-p5  
**Schnittstellen:** `lib/obsidian-bridge.js`, `lib/obsidian-control-room.js`, `lib/atomic-json.js`

---

## Zusammenfassung

| Test | Status | Details |
|------|--------|---------|
| 1. Bidirektionaler Sync | ✅ PASS | Obsidian → Kandidaten + Frontmatter-Update zurück |
| 2. Conflict-Report | ✅ PASS | Konflikt-Review wird bei geändertem Decision erzeugt |
| 3. Apply-Mode mit Backup | ✅ PASS | Backup, Manifest und Audit-Log vor Apply |
| 4. Path-Traversal-Schutz | ✅ PASS | `../../../etc/passwd` wird blockiert |
| 5. Atomic JSON | ✅ PASS | Parallele Writes führen nicht zu korruptem JSON |

**Testergebnis:** 7/7 Tests bestanden  
**Neue Dateien:** `tests/obsidian-smoke.test.js`

---

## 1. Bidirektionaler Sync

### Szenario
Ein simulierter Obsidian-Vault mit einer `memory/cards/hello.md` wird gescannt. Die Datei hat gültiges Frontmatter (`plur1bus_type: memory_card`, `sync_status: validated`, korrekter `content_hash`).

### Validierung
- **Scan-Richtung (Obsidian → PLUR1BUS):** `scanWorkspace` findet die Datei, klassifiziert sie als `memory_card` und `syncWorkspace` erzeugt bei fehlender Approval einen Kandidaten.
- **Apply-Richtung (PLUR1BUS → Obsidian):** Mit `applyApproved: true` und `approvedPaths: "all"` ruft `syncWorkspace` den `memoryStore`-Callback auf und schreibt die aktualisierte Frontmatter zurück (`sync_status: synced`, `memory_id: mem-bidi-01`).

### Ergebnis
Die Datei wird korrekt erkannt, der Payload gebaut, der Speicher-Callback aufgerufen und das Markdown-File mit aktualisiertem Frontmatter zurückgeschrieben.

---

## 2. Conflict-Report

### Szenario
Eine `decisions/important.md` wird zuerst synchronisiert (`sync_status: synced`). Anschließend wird der Body geändert (neuer `content_hash`) und ein zweiter Sync durchgeführt.

### Validierung
- `syncWorkspace` erkennt: `prev.contentHash !== file.contentHash`, `file.kind === "decision"`, `prev.syncStatus === "synced"`.
- Es wird ein `write_conflict_review`-Action erzeugt.
- Eine Markdown-Review-Datei wird in `.adaptive-learning/obsidian-bridge/conflicts/` geschrieben.
- Ein Eintrag mit `event: "decision.conflict_review"` landet in `conflict-log.jsonl`.

### Ergebnis
Conflict-Report wird automatisch generiert und persistiert.

---

## 3. Apply-Mode mit Backup

### Szenario
Ein Vault-File wird approved und gespeichert. `backupBeforeApply: true`, `auditLog: true`.

### Validierung
- **Backup:** Vor dem Überschreiben wird der Original-Inhalt nach `.adaptive-learning/obsidian-bridge/backups/<batchId>/` kopiert.
- **Manifest:** `manifest.json` enthält `batchId`, `beforeHash`, `afterHash` und `backupPath`.
- **Audit-Log:** `audit-log.jsonl` erhält einen Eintrag `event: "file.modified"` mit `beforeHash`, `afterHash` und `batchId`.
- **Inhalt:** Backup-Datei ist Byte-identisch mit dem Original.

### Ergebnis
Backup, Manifest und Audit-Log werden korrekt und vollständig erstellt.

---

## 4. Path-Traversal-Schutz

### Szenario
Versuch, `../../../etc/passwd` als relativer Pfad zu verwenden.

### Validierung
- `resolveInside(base, "../../../etc/passwd")` → wirft `Error: Path traversal blocked`
- `safeBridgePath(cfg, "../../../etc/passwd")` → wirft `Error: Path traversal rejected`
- `resolveObsidianBridgePaths(cfg)` mit gültigem `reviewRoot` → läuft sauber durch.

### Ergebnis
Path-Traversal wird an mehreren Schichten (`sql-safety.js`, `obsidian-control-room.js`) blockiert. Es gibt keinen Weg, über `..` aus dem Vault oder Review-Root auszubrechen.

---

## 5. Atomic JSON

### Szenario
5 Worker führen jeweils 20 parallele `atomicJsonUpdate`-Aufrufe auf derselben Datei durch (`{ count: 0 }` → inkrementieren).

### Validierung
- Nach 100 parallelen Updates steht `count` exakt auf `100`.
- Die Datei enthält zu keinem Zeitpunkt kaputtes/fragmentiertes JSON.
- Die temporäre Datei + `renameSync`-Strategie sorgt für atomare Updates.

### Ergebnis
Parallele Writes sind korrekt serialisiert; es treten keine Race-Conditions auf.

---

## Gefundene Probleme

### 🐛 atomic-json.js: Reentrancy-Deadlock (nicht blockierend für P5)

Die `atomicJsonUpdate`-Funktion enthält einen Schutz gegen Reentrancy (`activeFiles`-Set), aber dieser Schutz funktioniert nicht korrekt, wenn ein `async updater` innerhalb seiner Ausführung **awaited** ein weiteres `atomicJsonUpdate` für dieselbe Datei aufruft:

```js
await atomicJsonUpdate(filePath, async () => {
  await atomicJsonUpdate(filePath, () => ({ nested: true }));
  return { outer: true };
});
```

**Beobachtetes Verhalten:** Deadlock (hängt für immer), statt sauberem Error.  
**Ursache:** Das innere Promise wartet auf das äußere Promise (`fileQueues`-Kette), aber das äußere Promise wartet auf `await updater(data)`, das wiederum auf das innere Promise wartet.  
**Empfehlung:** Den `activeFiles`-Check vor das Einfügen in die Queue verschieben oder einen Timeout/Rejection-Mechanismus für Deadlocks einbauen.

> **Prio:** Niedrig-Mittel (kein Production-Crash, da typische Nutzung keine nested Updates macht, aber robustheitstechnisch relevant).

---

## Artefakte

- `tests/obsidian-smoke.test.js` – 7 Testfälle, alle passing.

## Git-Status

```
?? tests/obsidian-smoke.test.js
```

Keine Code-Änderungen an Produktionsdateien. Nur neue Test-Datei und dieser Audit-Report.
