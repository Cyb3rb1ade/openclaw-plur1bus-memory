import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isNoteImportExcluded, reviewBundleSummary } from "../lib/obsidian-control-room.js";

describe("Notiz-Import: nur Inhalt, der sonst nirgends im Gedächtnis landet", () => {
  for (const path of [
    "SOUL.md",
    "USER.md",
    "IDENTITY.md",
    "AGENTS.md",
    "HEARTBEAT.md",
    "persona-voice.md",
    "memory/episodes/2026/11/2026-11-06-gas.md",
    "memory/dream-diary/light/2026-11-06-light-dream-1.md",
    "DREAMS.md",
    "memory/consolidation/2026-W45.md",
    "memory/graph/2026/11/x.md",
    "reports/routines/gas/2026-11-06-evening-update.md",
    "trading/logbuch.md",
    "autosuche/gesehen.md",
  ]) {
    it(`schließt ${path} aus`, () => assert.equal(isNoteImportExcluded(path), true));
  }

  for (const path of [
    "memory/eigenzeit.md",
    "memory/2026-11-06.md",
    "subagent-recherche-gemeinde-hohne-20261105T174835Z-625012.md",
    "reports/gemeinde-hohne/protokolle/2026-10-01.md",
    "reports/pflege-kkh/INDEX.md",
    "reports/finance/steuer/2025.md",
    "notes/SOUL.md",
    "memory/notiz.md",
  ]) {
    it(`lässt ${path} zu`, () => assert.equal(isNoteImportExcluded(path), false));
  }
});

describe("Morgen-Review: automatisch übernommene Notizen", () => {
  const applied = (n) => Array.from({ length: n }, (_, i) => ({
    type: "note_import_candidate",
    status: "applied",
    risk: "low",
    target: `reports/x/${i}.md`,
    applyPreview: { payload: { text: `Notiz ${i}: Inhalt` } },
  }));

  it("meldet die Übernahme statt eines Vorschau-Hinweises", () => {
    const text = reviewBundleSummary({
      bundle: { createdAt: "2026-11-08T08:00:00.000Z" },
      items: applied(3),
      morningReview: true,
      autoApply: { autoApproved: 3, autoApplied: 3, blocked: [] },
      maintenance: { findings: [] },
    }, "PLUR1BUS Morning Review");
    assert.match(text, /✅ 3 Notizen automatisch ins Gedächtnis übernommen/);
    assert.doesNotMatch(text, /noch nichts übernommen|Ohne deine Freigabe wird nichts/);
    assert.doesNotMatch(text, /quickapply/);
    assert.match(text, /übernimmt PLUR1BUS automatisch/);
  });

  it("nennt Vorschläge, die nicht übernommen werden konnten", () => {
    const text = reviewBundleSummary({
      bundle: { createdAt: "2026-11-08T08:00:00.000Z" },
      items: applied(2),
      morningReview: true,
      autoApply: { autoApproved: 3, autoApplied: 2, blocked: [{ id: "x", reason: "source hash mismatch" }] },
      maintenance: { findings: [] },
    }, "PLUR1BUS Morning Review");
    assert.match(text, /⚠️ 1 Vorschlag konnte nicht übernommen werden/);
  });
});
