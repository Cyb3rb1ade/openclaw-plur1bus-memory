# PLUR1BUS UX Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drei UX-Verbesserungen am PLUR1BUS Telegram-Output: (A) Happy-Path schweigt, (B) Notiz-Vorschau mit echten Dateinamen, (C) `quickapply`-Befehl für approve+apply in einem Schritt.

**Architecture:** Alle Änderungen in zwei Dateien: `obsidian-control-room.js` (neue Funktionen + minimale Anpassungen in `reviewBundleSummary` und `handleObsidianBridgeCommand`) und dem zugehörigen Test-File. TDD: Tests für A+B zuerst (Task 1), dann implementieren (Task 2+3). C wird in einem Task TDD-mäßig end-to-end abgedeckt (Task 4).

**Tech Stack:** Node.js ESM, `node:test` + `node:assert`, keine neuen Dependencies. Baseline: 69 Tests grün.

---

## Dateien

| Datei | Änderung |
|---|---|
| `extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js` | A: `adversarialLine`-Bedingung; B: neue `telegramPreviewLines()` + Headerlogik in `reviewBundleSummary`; C: `export function quickapplySummary()` + `case "quickapply"` in `handleObsidianBridgeCommand` |
| `extensions/memory-lancedb-namespaced/__tests__/obsidian-control-room.test.js` | Tests für A, B, C |

Alle Pfade relativ zu `/root/openclaw-memory-system/`.

---

## Task 1: Tests für A und B schreiben (failing)

**Files:**
- Modify: `extensions/memory-lancedb-namespaced/__tests__/obsidian-control-room.test.js`

`reviewBundleSummary` und die `makeBundle`/`makeUserItem`-Helfer sind bereits im File vorhanden und müssen nicht neu angelegt werden.

- [ ] **Step 1: Tests am Ende des Files ergänzen**

Folgende Tests direkt VOR der abschließenden `});` des letzten `test()`-Blocks einfügen — oder als neue `test()`-Aufrufe ganz am Dateiende:

```javascript
// ─── UX Round 2: A — Happy-Path kürzen ───────────────────────────────────────

test("reviewBundleSummary: kein Sicherheitstext im Happy-Path", () => {
  const out = reviewBundleSummary(makeBundle({ items: [makeUserItem()] }));
  assert.doesNotMatch(out, /Sicherheitsprüfung/);
});

test("reviewBundleSummary: Sicherheitsprüfung erscheint bei Block", () => {
  const item = makeUserItem({ adversarialReview: { status: "block", reason: "Injekt" } });
  const out = reviewBundleSummary(makeBundle({ items: [item] }));
  assert.match(out, /❌ Sicherheitsprüfung/);
});

test("reviewBundleSummary: Sicherheitsprüfung erscheint bei Warnung", () => {
  const item = makeUserItem({ adversarialReview: { status: "warning", reason: "Verdächtig" } });
  const out = reviewBundleSummary(makeBundle({ items: [item] }));
  assert.match(out, /⚠️ Sicherheitsprüfung/);
});

// ─── UX Round 2: B — Notiz-Vorschau ──────────────────────────────────────────

test("reviewBundleSummary: zeigt Dateiname + Snippet für note_import_candidate", () => {
  const items = [{
    id: "rbi-b1", type: "note_import_candidate", status: "pending", risk: "low",
    target: "memory/my-note.md",
    applyPreview: { payload: { text: "Inhalt der Notiz hier" } },
    adversarialReview: { status: "pass" },
  }];
  const out = reviewBundleSummary(makeBundle({ items }));
  assert.match(out, /my-note\.md/);
  assert.match(out, /Inhalt der Notiz hier/);
});

test("reviewBundleSummary: max 3 Vorschau-Items, Rest als Sammelzeile", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    id: `rbi-b${i}`, type: "note_import_candidate", status: "pending", risk: "low",
    target: `memory/note-${i}.md`,
    applyPreview: { payload: { text: `Text ${i}` } },
    adversarialReview: { status: "pass" },
  }));
  const out = reviewBundleSummary(makeBundle({ items }));
  assert.match(out, /… 2 Notizen/);
});

test("reviewBundleSummary: Header 'neue Notizen' wenn nur note_import_candidate", () => {
  const items = [
    makeUserItem({ id: "rbi-b10", target: "memory/a.md", applyPreview: { payload: { text: "Inhalt A" } } }),
    makeUserItem({ id: "rbi-b11", target: "memory/b.md", applyPreview: { payload: { text: "Inhalt B" } } }),
  ];
  const out = reviewBundleSummary(makeBundle({ items }));
  assert.match(out, /neue Notizen:/);
});

test("reviewBundleSummary: Header 'Vorschläge' bei gemischten Typen", () => {
  const items = [
    makeUserItem({ id: "rbi-b20", target: "memory/a.md" }),
    makeUserItem({ id: "rbi-b21", type: "task_suggestion" }),
  ];
  const out = reviewBundleSummary(makeBundle({ items }));
  assert.match(out, /Vorschläge:/);
});

test("reviewBundleSummary: Header 'Aufgaben' wenn nur tasks", () => {
  const items = [
    makeUserItem({ id: "rbi-b30", type: "task_suggestion" }),
    makeUserItem({ id: "rbi-b31", type: "task_suggestion" }),
  ];
  const out = reviewBundleSummary(makeBundle({ items }));
  assert.match(out, /Aufgaben:/);
});
```

- [ ] **Step 2: Tests ausführen und Fehlschläge bestätigen**

```bash
cd /root/openclaw-memory-system/extensions/memory-lancedb-namespaced
node --test __tests__/obsidian-control-room.test.js 2>&1 | grep -E "^(ℹ pass|ℹ fail|✗|▶ FAIL)"
```

Erwartete Ausgabe: `ℹ pass 69` (alte Tests weiter grün), `ℹ fail 7` (neue Tests rot). Kein `SyntaxError`.

- [ ] **Step 3: Commit**

```bash
cd /root/openclaw-memory-system
git add extensions/memory-lancedb-namespaced/__tests__/obsidian-control-room.test.js
git commit -m "test: UX Round 2 — failing tests für A (happy-path) und B (Notiz-Vorschau)"
```

---

## Task 2: Implementierung A — Happy-Path schweigt

**Files:**
- Modify: `extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js` (Zeile ~2936–2945)

- [ ] **Step 1: `adversarialLine`-Block anpassen**

Aktuellen Block (Zeile ~2936–2945) ersetzen:

```javascript
// ALT — ersetzen:
  let adversarialLine = null;
  if (totalUserItems > 0) {
    if (adversarialBlocks > 0) {
      adversarialLine = `❌ Sicherheitsprüfung: ${adversarialBlocks} blockiert`;
    } else if (adversarialWarnings > 0) {
      adversarialLine = `⚠️ Sicherheitsprüfung: ${adversarialWarnings} Warnung${adversarialWarnings === 1 ? "" : "en"}`;
    } else {
      adversarialLine = `✅ Sicherheitsprüfung: alle ${totalUserItems} geprüft`;
    }
  }
```

```javascript
// NEU — einsetzen:
  let adversarialLine = null;
  if (adversarialBlocks > 0) {
    adversarialLine = `❌ Sicherheitsprüfung: ${adversarialBlocks} blockiert`;
  } else if (adversarialWarnings > 0) {
    adversarialLine = `⚠️ Sicherheitsprüfung: ${adversarialWarnings} Warnung${adversarialWarnings === 1 ? "" : "en"}`;
  }
  // Kein else-Branch — alles OK bleibt still
```

- [ ] **Step 2: Syntaxcheck**

```bash
node --check /root/openclaw-memory-system/extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js
```

Erwartete Ausgabe: kein Output.

- [ ] **Step 3: Tests ausführen**

```bash
cd /root/openclaw-memory-system/extensions/memory-lancedb-namespaced
node --test __tests__/obsidian-control-room.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
```

Erwartete Ausgabe: `ℹ pass 72`, `ℹ fail 4` (A-Tests grün, B-Tests noch rot).

- [ ] **Step 4: Commit**

```bash
cd /root/openclaw-memory-system
git add extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js
git commit -m "feat: reviewBundleSummary — happy-path Sicherheitsprüfung ausblenden (A)"
```

---

## Task 3: Implementierung B — Notiz-Vorschau (telegramPreviewLines)

**Files:**
- Modify: `extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js`

Zwei Änderungen: (1) neue Funktion `telegramPreviewLines` nach `telegramBucketLines` einfügen, (2) in `reviewBundleSummary` die Bucket-Zeilen durch Preview-Zeilen + angepasste Header-Logik ersetzen.

- [ ] **Step 1: `telegramPreviewLines()` nach `telegramBucketLines()` einfügen**

Die Funktion `telegramBucketLines` endet mit `}` um Zeile 2510. Direkt danach einfügen:

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
    const text = item.applyPreview?.payload?.text || item.reason || item.action || "";
    const snippet = shortenText(text, 55);
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

- [ ] **Step 2: `bucketLines`-Nutzung in `reviewBundleSummary` ersetzen**

In `reviewBundleSummary` um Zeile ~2960 die Zeile:
```javascript
  const bucketLines = telegramBucketLines(userItems, hygieneItems);
```
ersetzen durch:
```javascript
  const previewLines = telegramPreviewLines(userItems);
```

- [ ] **Step 3: Header-Logik und Ausgabe aktualisieren**

Im Vorschläge-Sektion-Block (um Zeile ~2982–2989):

```javascript
// ALT:
  if (totalUserItems > 0) {
    out.push("");
    const countLabel = totalUserItems === 1 ? "1 Vorschlag" : `${totalUserItems} Vorschläge`;
    const pendingExtra = approved > 0 && pending < totalUserItems
      ? ` (${pending} offen, ${approved} freigegeben)` : "";
    out.push(`📋 ${countLabel}${pendingExtra}:`);
    if (bucketLines) out.push(bucketLines);
    if (riskLine) out.push(riskLine);
```

```javascript
// NEU:
  if (totalUserItems > 0) {
    out.push("");
    const pendingItems = userItems.filter((i) => !i.status || i.status === "pending");
    const allPreviewable = pendingItems.length > 0 && pendingItems.every((i) =>
      ["note_import_candidate", "memory_promotion"].includes(i.type));
    const allTasks = pendingItems.length > 0 && pendingItems.every((i) => i.type === "task_suggestion");
    const bucketLabel = allTasks
      ? (totalUserItems === 1 ? "1 Aufgabe" : `${totalUserItems} Aufgaben`)
      : allPreviewable
        ? (totalUserItems === 1 ? "1 neue Notiz" : `${totalUserItems} neue Notizen`)
        : (totalUserItems === 1 ? "1 Vorschlag" : `${totalUserItems} Vorschläge`);
    const pendingExtra = approved > 0 && pending < totalUserItems
      ? ` (${pending} offen, ${approved} freigegeben)` : "";
    out.push(`📋 ${bucketLabel}${pendingExtra}:`);
    if (previewLines) out.push(previewLines);
    if (riskLine) out.push(riskLine);
```

- [ ] **Step 4: Syntaxcheck**

```bash
node --check /root/openclaw-memory-system/extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js
```

Erwartete Ausgabe: kein Output.

- [ ] **Step 5: Tests ausführen**

```bash
cd /root/openclaw-memory-system/extensions/memory-lancedb-namespaced
node --test __tests__/obsidian-control-room.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
```

Erwartete Ausgabe: `ℹ pass 76`, `ℹ fail 0`. Alle Tests grün.

Falls Tests rot sind, Debug-Ausgabe anschauen:
```bash
node --test --test-name-pattern="Dateiname" __tests__/obsidian-control-room.test.js 2>&1
```

- [ ] **Step 6: Commit**

```bash
cd /root/openclaw-memory-system
git add extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js
git commit -m "feat: telegramPreviewLines — Dateiname + Snippet statt abstrakter Zählung (B)"
```

---

## Task 4: Tests + Implementierung C — quickapply-Befehl

**Files:**
- Modify: `extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js`
- Modify: `extensions/memory-lancedb-namespaced/__tests__/obsidian-control-room.test.js`

- [ ] **Step 1: `quickapplySummary` in Test-Import ergänzen**

Am Anfang von `__tests__/obsidian-control-room.test.js` den bestehenden Import um `quickapplySummary` erweitern:

```javascript
// Suche die Zeile mit reviewBundleSummary und eveningReviewSummary und ergänze:
import { reviewBundleSummary, eveningReviewSummary, quickapplySummary } from "../lib/obsidian-control-room.js";
```

- [ ] **Step 2: Unit-Tests für `quickapplySummary` ergänzen**

Am Ende des Test-Files:

```javascript
// ─── UX Round 2: C — quickapply ──────────────────────────────────────────────

test("quickapplySummary: zeigt gespeicherte Einträge", () => {
  const result = quickapplySummary({ applied: ["a", "b"], blocked: [], items: [], hygieneItems: [] });
  assert.match(result, /2 Einträge gespeichert/);
});

test("quickapplySummary: Singular bei einem Eintrag", () => {
  const result = quickapplySummary({ applied: ["a"], blocked: [], items: [], hygieneItems: [] });
  assert.match(result, /1 Eintrag gespeichert/);
});

test("quickapplySummary: 'Nichts zu tun' wenn nichts applied", () => {
  const result = quickapplySummary({ applied: [], blocked: [], items: [], hygieneItems: [] });
  assert.match(result, /Nichts zu tun/);
});

test("quickapplySummary: zeigt blockierte Einträge", () => {
  const result = quickapplySummary({ applied: ["a"], blocked: ["b"], items: [], hygieneItems: [] });
  assert.match(result, /1 Eintrag.*blockiert/);
});
```

- [ ] **Step 3: Integration-Test für quickapply-Befehl ergänzen**

```javascript
test("review quickapply wendet low-risk Items in einem Schritt an", async () => {
  const { tmp, vault } = makeVault();
  try {
    await prepareReviewBundle(config(vault), {
      bundleId: "rb-quickapply-test",
      proposals: [{
        type: "note_import_candidate",
        risk: "low",
        target: "memory/quick.md",
        action: "Quick apply test",
        reason: "Test note import",
        evidence: ["Evidence"],
        noteContent: "# Quick\n\nTest content",
      }],
    });

    const result = await handleObsidianBridgeCommand(["review", "quickapply", "low-risk"], {
      config: config(vault),
      agentId: "main",
      workspaceKey: "main",
      workspaceDir: vault,
    });
    assert.match(result.text, /gespeichert/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Tests ausführen und Fehlschläge bestätigen**

```bash
cd /root/openclaw-memory-system/extensions/memory-lancedb-namespaced
node --test __tests__/obsidian-control-room.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
```

Erwartete Ausgabe: `ℹ pass 76`, `ℹ fail 5` (neue C-Tests rot, weil `quickapplySummary` noch nicht existiert → Import-Fehler oder `undefined`). Falls ein Import-Fehler das gesamte File abbricht, kurz kommentieren und nach der Implementierung wieder einkommentieren.

- [ ] **Step 5: `export function quickapplySummary()` implementieren**

Direkt **vor** `function applySummary` (Zeile ~3081) einfügen:

```javascript
export function quickapplySummary(applyResult = {}) {
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

- [ ] **Step 6: `quickapply`-Case in `handleObsidianBridgeCommand` ergänzen**

Direkt **nach** dem `apply`-Block (der um Zeile ~3384 endet mit `}`) und **vor** der abschließenden `}` des `review`-Blocks einfügen. Der aktuelle Code endet mit:

```javascript
      if (effectiveSub === "apply") {
        if (!bundleId) return commandResult(`${obsidianCommandHelp()}\n\nNo ReviewBundle was found yet. Run /plur1bus_morning first.`);
        return commandResult(applySummary(await applyApprovedReviewBundle(commandConfig, bundleId, {
          agentId,
          workspaceKey,
          workspaceDir: context.workspaceDir,
          memoryStore: context.memoryStore,
          knowledgeUpdate: context.knowledgeUpdate,
        })));
      }
    }
    return commandResult(obsidianCommandHelp());
```

Ersetzen durch:

```javascript
      if (effectiveSub === "apply") {
        if (!bundleId) return commandResult(`${obsidianCommandHelp()}\n\nNo ReviewBundle was found yet. Run /plur1bus_morning first.`);
        return commandResult(applySummary(await applyApprovedReviewBundle(commandConfig, bundleId, {
          agentId,
          workspaceKey,
          workspaceDir: context.workspaceDir,
          memoryStore: context.memoryStore,
          knowledgeUpdate: context.knowledgeUpdate,
        })));
      }
      if (effectiveSub === "quickapply") {
        if (!bundleId) return commandResult("✅ Keine Vorschläge offen — nichts zu tun.");
        const quickSelector = normalizeItemSelector(positionalSelector || "low-risk");
        updateReviewBundleItems(commandConfig, bundleId, "approve", quickSelector);
        const applyResult = await applyApprovedReviewBundle(commandConfig, bundleId, {
          agentId,
          workspaceKey,
          workspaceDir: context.workspaceDir,
          memoryStore: context.memoryStore,
          knowledgeUpdate: context.knowledgeUpdate,
        });
        return commandResult(quickapplySummary(applyResult));
      }
    }
    return commandResult(obsidianCommandHelp());
```

- [ ] **Step 7: Syntaxcheck**

```bash
node --check /root/openclaw-memory-system/extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js
```

Erwartete Ausgabe: kein Output.

- [ ] **Step 8: Alle Tests ausführen**

```bash
cd /root/openclaw-memory-system/extensions/memory-lancedb-namespaced
node --test __tests__/obsidian-control-room.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
```

Erwartete Ausgabe: `ℹ pass 81`, `ℹ fail 0`.

Falls einzelne C-Tests rot sind, Ausgabe einzeln prüfen:
```bash
node --test --test-name-pattern="quickapply" __tests__/obsidian-control-room.test.js 2>&1
```

- [ ] **Step 9: Commit**

```bash
cd /root/openclaw-memory-system
git add extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js \
        extensions/memory-lancedb-namespaced/__tests__/obsidian-control-room.test.js
git commit -m "feat: quickapply-Befehl + quickapplySummary (C)"
```

---

## Task 5: Deploy + Live-Smoke-Test

- [ ] **Step 1: Deployen**

```bash
cd /root/openclaw-memory-system
./scripts/install-memory-system.sh --update-plugin-only /root/.openclaw
```

Erwartete Ausgabe: `[ok] Plugin installed` o.ä. Kein `[error]`.

- [ ] **Step 2: Gateway neu starten**

```bash
systemctl --user restart openclaw-gateway
sleep 3
systemctl --user status openclaw-gateway --no-pager | head -5
```

Erwartete Ausgabe: `Active: active (running)`.

- [ ] **Step 3: Live-Smoke-Test — Happy-Path**

In Telegram an Bernd: `/plur1bus_review show`

Erwartete Antwort:
- Beginnt mit `🧠 Memory Review — ` + deutsches Datum
- **Kein** `✅ Sicherheitsprüfung:` wenn keine Probleme vorliegen
- Zeigt `• dateiname.md — erste Zeile` statt `• 6 Notizen aus Obsidian`
- Endet mit `approve low-risk → apply`

- [ ] **Step 4: Live-Smoke-Test — quickapply**

In Telegram an Bernd: `/plur1bus_review quickapply low-risk`

Erwartete Antwort:
- Enthält `✅ N Einträge gespeichert` oder `✅ Nichts zu tun — keine freigegebenen Einträge.`
- Kein technischer Stack-Output, kein Bundle-Pfad

---

## Verification Summary

| Was | Wie | Erwartetes Ergebnis |
|---|---|---|
| Unit Tests | `node --test __tests__/obsidian-control-room.test.js` | 81 pass, 0 fail |
| Syntaxcheck | `node --check lib/obsidian-control-room.js` | kein Output |
| Gateway läuft | `systemctl --user status openclaw-gateway` | `active (running)` |
| Happy-Path | `/plur1bus_review show` | kein `✅ Sicherheitsprüfung` |
| Vorschau | `/plur1bus_review show` | Dateinamen + erste Zeile |
| quickapply | `/plur1bus_review quickapply` | `gespeichert` oder `Nichts zu tun` |

---

## Was NICHT geändert wird

- `telegramBucketLines()` — bleibt im Code (nicht mehr von `reviewBundleSummary` aufgerufen, aber intern referenziert oder für Zukunft)
- `applySummary()` — unverändert (eigener Command-Output)
- `reviewCommands()` — unverändert
- `eveningReviewSummary()` — unverändert
- `approve` + `apply` Befehle — weiterhin funktionsfähig
