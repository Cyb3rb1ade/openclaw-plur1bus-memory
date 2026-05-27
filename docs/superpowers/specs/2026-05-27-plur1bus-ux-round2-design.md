# PLUR1BUS UX Round 2 — Design Spec

**Datum:** 2026-05-27  
**Branch:** `feature/ux-deutsch-telegram-output`  
**Bezug:** Fortsetzung der deutschen UX-Neugestaltung (Round 1 abgeschlossen)

---

## Ziel

Drei konkrete Verbesserungen am Telegram-Output von `/plur1bus_review` und verwandten Befehlen:

1. **A — Happy-Path kürzen:** Statuszeilen nur bei Problemen zeigen
2. **B — Notiz-Vorschau:** Echte Dateinamen + erste Zeile statt abstrakter Zählung
3. **C — quickapply-Befehl:** approve + apply in einem Schritt

### Ziel-Output (Happy Path, alles sauber)

```
🧠 Memory Review — 27. Mai 2026, 14:29
Vorschau-Modus · Noch nichts gespeichert ✋

📋 6 neue Notizen:
• brainstorming-react.md — Ideen für den neuen Auth-Flow
• heisenberg-auth-fix.md — JWT Expiry Bug behoben
• eva-meeting-2026-05-26.md — Sync mit Eva über Projekt X
• … 3 weitere, 1 Aufgabe

➡️ quickapply low-risk
```

### Ziel-Output (Probleme vorhanden)

```
🧠 Memory Review — 27. Mai 2026, 14:29
Vorschau-Modus · Noch nichts gespeichert ✋

❌ Sicherheitsprüfung: 1 blockiert
⚠️ System: 3 Hinweise — automatisch verwaltet

📋 5 neue Notizen:
• brainstorming-react.md — Ideen für den neuen Auth-Flow
• … 4 weitere

⚠️ Bitte prüfen:
• Möglicher Prompt-Injection-Versuch in heisenberg-notes.md

Systemhinweise (kein Handeln nötig):
• Interner Block wurde verändert — wird beim Anwenden korrigiert (2×)

➡️ approve low-risk → apply
```

---

## A — Happy-Path kürzen

### Verhalten

| Zustand | Jetzt | Neu |
|---|---|---|
| Adversarial: alle pass | `✅ Sicherheitsprüfung: alle 7 geprüft` | *(ausgeblendet)* |
| Adversarial: warning | `⚠️ Sicherheitsprüfung: 1 Warnung` | `⚠️ Sicherheitsprüfung: 1 Warnung` |
| Adversarial: block | `❌ Sicherheitsprüfung: 1 blockiert` | `❌ Sicherheitsprüfung: 1 blockiert` |
| Maintenance: keine Findings | `✅ System: keine Probleme` → seit Round 1 bereits `null` | *(keine Änderung nötig)* |
| Maintenance: nur system-Codes | `⚠️ System: 3 Hinweise — auto.` | `⚠️ System: 3 Hinweise — automatisch verwaltet` |
| Maintenance: non-system errors | `❌ System: 1 Fehler — auto.` | `❌ System: 1 Fehler — automatisch verwaltet` |

**Einzige Codeänderung:** In `reviewBundleSummary()` die Bedingung für `adversarialLine` anpassen:

```javascript
// Vorher: immer wenn totalUserItems > 0
// Nachher: nur wenn problems > 0
let adversarialLine = null;
if (adversarialBlocks > 0) {
  adversarialLine = `❌ Sicherheitsprüfung: ${adversarialBlocks} blockiert`;
} else if (adversarialWarnings > 0) {
  adversarialLine = `⚠️ Sicherheitsprüfung: ${adversarialWarnings} Warnung${adversarialWarnings === 1 ? "" : "en"}`;
}
// Kein else-Branch mehr — happy path bleibt still
```

---

## B — Notiz-Vorschau

### Neue Funktion: `telegramPreviewLines(userItems, maxPreview = 3)`

Ersetzt `telegramBucketLines()` in `reviewBundleSummary()`. Bleibt als separate Hilfsfunktion erhalten (wird nur von `reviewBundleSummary` aufgerufen).

**Algorithmus:**

1. Filtere auf pending items
2. Trenne `previewable` (note_import_candidate, memory_promotion) von `tasks` (task_suggestion) und `other`
3. Zeige bis zu `maxPreview` previewable items mit `• {filename} — {snippet}`
4. Restliche items als Sammelzeile: `• … 3 weitere, 1 Aufgabe`

**Datenquellen:**
- Dateiname: `(item.target || item.id || "").split("/").pop()` — nimmt letzten Pfad-Teil
- Snippet: `shortenText(reviewItemSummary(item), 55)` — nutzt bereits vorhandene Funktion
- `reviewItemSummary()` gibt `item.applyPreview?.payload?.text || item.reason || item.action` zurück

**Implementierung:**

```javascript
function telegramPreviewLines(userItems = [], maxPreview = 3) {
  const pending = (Array.isArray(userItems) ? userItems : [])
    .filter((i) => !i.status || i.status === "pending");
  const previewable = pending.filter((i) =>
    ["note_import_candidate", "memory_promotion"].includes(i.type));
  const tasks = pending.filter((i) => i.type === "task_suggestion");
  const other = pending.filter((i) =>
    !["note_import_candidate", "memory_promotion", "task_suggestion"].includes(i.type));

  const lines = [];

  for (const item of previewable.slice(0, maxPreview)) {
    const name = (item.target || item.id || "unbekannt").split("/").pop();
    const snippet = shortenText(reviewItemSummary(item), 55);
    lines.push(snippet ? `• ${name} — ${snippet}` : `• ${name}`);
  }

  const hiddenPreviewable = Math.max(0, previewable.length - maxPreview);
  const restParts = [];
  if (hiddenPreviewable > 0) {
    restParts.push(`${hiddenPreviewable} ${hiddenPreviewable === 1 ? "Notiz" : "Notizen"}`);
  }
  if (tasks.length > 0) {
    restParts.push(`${tasks.length} Aufgabe${tasks.length === 1 ? "" : "n"}`);
  }
  if (other.length > 0) {
    restParts.push(`${other.length} weitere`);
  }
  if (restParts.length > 0) {
    lines.push(`• … ${restParts.join(", ")}`);
  }

  return lines.join("\n");
}
```

**Header-Zeile:** Statt `📋 7 Vorschläge:` jetzt `📋 7 neue Notizen:` wenn alle previewable sind, sonst generisch `📋 7 Vorschläge:`. Genauer:
- Nur `note_import_candidate`/`memory_promotion` pending: `📋 N neue Notizen:`
- Gemischt: `📋 N Vorschläge:`
- Nur tasks: `📋 N Aufgaben:`

---

## C — quickapply-Befehl

### Befehlssyntax

- `quickapply` — Default: `low-risk`
- `quickapply low-risk` — explizit

Registriert als Subcommand in `handleObsidianBridgeCommand()`, analog zu `review approve`.

### Ablauf

```
quickapply low-risk
  ↓
updateReviewBundleItems(config, bundleId, "approve", "low-risk")
  ↓
applyApprovedReviewBundle(config, bundleId)
  ↓
quickapplySummary(approveResult, applyResult) → German text
```

Wenn kein pending Bundle vorhanden: freundliche Meldung `✅ Keine Vorschläge offen — nichts zu tun.`

### Neue Funktion: `quickapplySummary(applyResult)`

```javascript
// Input: Ergebnis von applyApprovedReviewBundle
// Output: Deutscher Telegram-Text
function quickapplySummary(applyResult = {}) {
  const applied = Array.isArray(applyResult.applied) ? applyResult.applied.length : 0;
  const blocked = Array.isArray(applyResult.blocked) ? applyResult.blocked.length : 0;
  const effects = reviewEffectSummary(applyResult.items || [], applyResult.hygieneItems || []);
  
  const lines = [];
  if (applied > 0) {
    lines.push(`✅ ${applied} ${applied === 1 ? "Eintrag" : "Einträge"} gespeichert`);
  }
  if (effects.pending.length > 0) {
    lines.push(`⏳ ${effects.pending.length} ${effects.pending.length === 1 ? "Vorschlag wartet" : "Vorschläge warten"} noch (mittleres/hohes Risiko)`);
    lines.push("→ show für Details");
  }
  if (blocked > 0) {
    lines.push(`⚠️ ${blocked} ${blocked === 1 ? "Eintrag" : "Einträge"} blockiert — show für Details`);
  }
  if (applied === 0 && effects.pending.length === 0) {
    lines.push("✅ Nichts zu tun — keine freigegebenen Einträge.");
  }
  return lines.join("\n");
}
```

### Command-Handler-Integration

In `handleObsidianBridgeCommand()` (aktuell ~Zeile 3062), im `review`-Block nach dem `approve`-Case:

```javascript
if (effectiveSub === "quickapply") {
  // bundleId ist bereits durch den äußeren Block aufgelöst
  // (latestReviewBundleId oder expliziter Bundle-Token — identisch zu approve/apply)
  if (!bundleId) return commandResult("✅ Keine Vorschläge offen — nichts zu tun.");
  const selector = normalizeItemSelector(positionalSelector || "low-risk");
  updateReviewBundleItems(commandConfig, bundleId, "approve", selector);
  const applyResult = await applyApprovedReviewBundle(commandConfig, bundleId, { agentId, workspaceKey });
  return commandResult(quickapplySummary(applyResult));
}
```

---

## Dateien

| Datei | Änderung |
|---|---|
| `lib/obsidian-control-room.js` | A: `adversarialLine`-Bedingung; B: neue `telegramPreviewLines()`; C: `quickapplySummary()` + `case "quickapply"` |
| `__tests__/obsidian-control-room.test.js` | Tests für A, B, C |

Keine weiteren Dateien. Alle Änderungen sind additiv oder minimale Anpassungen.

---

## Tests

### A — Happy-Path kürzen
```javascript
test("reviewBundleSummary: kein Status-Text wenn alles OK", () => {
  const out = reviewBundleSummary(makeBundle({ items: [makeUserItem()] }));
  assert.doesNotMatch(out, /Sicherheitsprüfung/); // kein OK-Status
  assert.doesNotMatch(out, /System:/);            // kein System-OK
});

test("reviewBundleSummary: Sicherheitsprüfung erscheint bei Block", () => {
  const item = makeUserItem({ adversarialReview: { status: "block", reason: "Injekt" } });
  const out = reviewBundleSummary(makeBundle({ items: [item] }));
  assert.match(out, /❌ Sicherheitsprüfung/);
});
```

### B — Notiz-Vorschau
```javascript
test("telegramPreviewLines: zeigt Dateiname + Snippet", () => {
  const items = [{ id: "1", type: "note_import_candidate", status: "pending", risk: "low",
    target: "memory/my-note.md",
    applyPreview: { payload: { text: "Inhalt der Notiz hier" } },
    adversarialReview: { status: "pass" } }];
  const out = reviewBundleSummary(makeBundle({ items }));
  assert.match(out, /my-note\.md/);
  assert.match(out, /Inhalt der Notiz hier/);
});

test("telegramPreviewLines: max 3 Items, Rest als Sammelzeile", () => {
  const items = Array.from({ length: 5 }, (_, i) => makeUserItem({
    id: `rbi-00${i}`, target: `memory/note-${i}.md`,
    applyPreview: { payload: { text: `Text ${i}` } }
  }));
  const out = reviewBundleSummary(makeBundle({ items }));
  assert.match(out, /… 2 Notizen/);
});
```

### C — quickapply
```javascript
test("quickapply command applies low-risk items in one step", async () => {
  // setup: vault + bundle mit low-risk pending items
  // run: handleObsidianBridgeCommand(["review", "quickapply", "low-risk"], ...)
  // assert: result.text enthält "gespeichert"
  // assert: items danach status "applied"
});
```

---

## Was NICHT geändert wird

- `telegramBucketLines()` bleibt im Code (eventuell intern noch genutzt; wird einfach nicht mehr aus `reviewBundleSummary` aufgerufen)
- `reviewCommands()` bleibt unverändert
- `eveningReviewSummary()` bleibt unverändert (separate Funktion)
- Obsidian-Markdown-Rendering bleibt unverändert
- Bestehende `approve` + `apply` Befehle bleiben weiterhin funktionsfähig
