import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { reviewBundleSummary } from "../lib/obsidian-control-room.js";

const note = (target, text, risk = "low") => ({
  type: "note_import_candidate",
  status: "pending",
  risk,
  target,
  applyPreview: { payload: { text } },
});

const linkFinding = (file) => ({ severity: "warning", code: "generated_link_review", message: `link ${file}` });

const morning = (items, findings = []) => ({
  bundle: { createdAt: "2026-11-07T08:00:00.000Z" },
  items,
  morningReview: true,
  maintenance: { findings },
});

describe("Morgen-Review: Telegram-Layout", () => {
  const items = [
    note("memory/consolidation/2026-W45.md", "Konsolidierungs-Report — 2026-W45: **Zeitpunkt:** 2026-11-07T03:00"),
    note("memory/episodes/2026/11/2026-11-06-gas.md", "Doppelte Gasreports zusammengeführt: Bernd hat zwei Reports"),
    note("memory/dream-diary/light/2026-11-06-light-dream-1.md", "Light Dream — 2026-11-06: *Stimmung beim Träumen*"),
    note("memory/2026-11-06.md", "2026-11-06 — Daily Notes: Der Tag war dicht"),
    note("memory/ohne-titel.md", "kein Doppelpunkt im Text"),
  ];

  it("zeigt Notiztitel statt Dateiname und Textanriss", () => {
    const text = reviewBundleSummary(morning(items), "PLUR1BUS Morning Review");
    assert.match(text, /\n• Konsolidierungs-Report — 2026-W45\n/);
    assert.match(text, /\n• Doppelte Gasreports zusammengeführt\n/);
    assert.match(text, /\n• Light Dream — 2026-11-06\n/);
    assert.doesNotMatch(text, /\.md|\*\*|\.\.\./);
  });

  it("fasst den Rest und das Risiko in ganzen Sätzen zusammen", () => {
    const text = reviewBundleSummary(morning(items), "PLUR1BUS Morning Review");
    assert.match(text, /📋 5 neue Notizen\n/);
    assert.match(text, /\n… und 2 weitere\nAlle mit niedrigem Risiko\.\n/);
    assert.doesNotMatch(text, /Risiko: \d+×/);
  });

  it("zählt Risikostufen weiter auf, sobald nicht alles niedrig ist", () => {
    const text = reviewBundleSummary(morning([...items, note("x/y.md", "Heikel: z", "medium")]), "PLUR1BUS Morning Review");
    assert.match(text, /\nRisiko: 1× mittel, 5× niedrig\.\n/);
  });

  it("nennt reine Systemhinweise nur einmal und ohne Uhrzeit im Titel", () => {
    const findings = ["a", "b", "c"].map(linkFinding);
    const text = reviewBundleSummary(morning(items, findings), "PLUR1BUS Morning Review");
    assert.match(text, /^🌅 Morgen-Review · Samstag, 7\. November\nVorschau · noch nichts übernommen\n\n📋/);
    assert.doesNotMatch(text, /System: 1 Hinweis/);
    assert.match(text, /ℹ️ Systemhinweise, kein Handeln nötig:\n• Dashboard-Link zu prüfen \(meist kein Problem\) \(3×\)/);
    assert.doesNotMatch(text, /\n\n\n/);
  });

  it("verweist auf einen echten Befehl", () => {
    const text = reviewBundleSummary(morning(items), "PLUR1BUS Morning Review");
    assert.match(text, /👉 Übernehmen: \/plur1bus review quickapply/);
    assert.doesNotMatch(text, /approve low-risk → apply/);
  });

  it("behält die Fehlerzeile, wenn ein Systemfehler vorliegt", () => {
    const text = reviewBundleSummary(
      morning(items, [{ severity: "error", code: "invalid_mode", message: "x" }]),
      "PLUR1BUS Morning Review",
    );
    assert.match(text, /❌ System: 1 Fehler/);
  });
});
