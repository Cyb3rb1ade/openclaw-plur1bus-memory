/**
 * Regression: die KNOWLEDGE.md-Beförderung rief das Modell mit einem festen
 * Ausgabebudget von 3000 Token auf, obwohl der Aufruf den **ganzen** Textkoerper
 * zurueckgibt. Solange die Datei klein war, ging das gut; am 09.09.2026
 * brauchte allein der Bestand 2752 Token (Bernd, 11 011 Bytes) bzw. 3121
 * (Bernhardine, 12 487) — beide Laeufe schlugen fehl, waehrend derselbe Aufruf
 * fuer eine 1841 Bytes grosse Datei durchlief. Ein mitwachsender Fehler.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isTruncatedKnowledgeBody, resolveKnowledgeUpdateMaxTokens, resolveKnowledgeUpdateTimeoutMs } from "../lib/knowledge-update-budget.js";

describe("resolveKnowledgeUpdateMaxTokens", () => {
  it("bleibt bei kleinen Bestaenden auf dem bisherigen Wert", () => {
    assert.equal(resolveKnowledgeUpdateMaxTokens("x".repeat(1_841)), 3_000);
    assert.equal(resolveKnowledgeUpdateMaxTokens(""), 3_000);
  });

  it("waechst mit dem Bestand ueber den alten Deckel hinaus", () => {
    // Die beiden Faelle, die am 09.09.2026 fehlschlugen.
    const bernd = resolveKnowledgeUpdateMaxTokens("x".repeat(11_011));
    const bernhardine = resolveKnowledgeUpdateMaxTokens("x".repeat(12_487));
    assert.ok(bernd > 3_000, `Bernd braucht mehr als 3000, bekam ${bernd}`);
    assert.ok(bernhardine > bernd, "groesserer Bestand, groesseres Budget");
    // Genug, um den Bestand ueberhaupt reproduzieren zu koennen.
    assert.ok(bernd >= Math.ceil(11_011 / 4), "unter der Reproduktionsgrenze");
  });

  it("deckelt nach oben und akzeptiert Nicht-Zeichenketten", () => {
    assert.equal(resolveKnowledgeUpdateMaxTokens("x".repeat(5_000_000)), 16_000);
    assert.equal(resolveKnowledgeUpdateMaxTokens(undefined), 3_000);
    assert.equal(resolveKnowledgeUpdateMaxTokens(null), 3_000);
  });

  it("respektiert einen angehobenen Mindestwert", () => {
    assert.equal(resolveKnowledgeUpdateMaxTokens("kurz", { floor: 4_000 }), 4_000);
  });
});

describe("isTruncatedKnowledgeBody", () => {
  it("erkennt eine abgeschnittene Antwort", () => {
    // Ohne diese Pruefung wuerde der gekuerzte Text den Bestand ueberschreiben.
    assert.equal(isTruncatedKnowledgeBody("x".repeat(10_000), "x".repeat(3_000)), true);
  });

  it("laesst Wachstum und leichte Verdichtung durch", () => {
    assert.equal(isTruncatedKnowledgeBody("x".repeat(10_000), "x".repeat(12_000)), false);
    assert.equal(isTruncatedKnowledgeBody("x".repeat(10_000), "x".repeat(8_000)), false);
  });

  it("blockiert die erste Anlage nicht", () => {
    assert.equal(isTruncatedKnowledgeBody("", "frischer Inhalt"), false);
    assert.equal(isTruncatedKnowledgeBody("   ", "frischer Inhalt"), false);
  });

  it("wertet eine leere Antwort bei vorhandenem Bestand als Kuerzung", () => {
    assert.equal(isTruncatedKnowledgeBody("x".repeat(1_000), ""), true);
    assert.equal(isTruncatedKnowledgeBody("x".repeat(1_000), undefined), true);
  });
});

describe("resolveKnowledgeUpdateTimeoutMs", () => {
  it("bleibt fuer kleine Ausgaben bei mindestens dem bisherigen Standard", () => {
    assert.equal(resolveKnowledgeUpdateTimeoutMs(500), 30_000);
    assert.equal(resolveKnowledgeUpdateTimeoutMs(0), 30_000);
  });

  it("waechst mit dem Ausgabebudget", () => {
    // Der Fall, der seit dem 01.07.2026 in TimeoutError lief.
    const bernd = resolveKnowledgeUpdateTimeoutMs(resolveKnowledgeUpdateMaxTokens("x".repeat(11_011)));
    assert.ok(bernd > 30_000, `30 s reichten nicht, bekam ${bernd}`);
    assert.ok(bernd > resolveKnowledgeUpdateTimeoutMs(3_000), "mehr Token, mehr Zeit");
  });

  it("deckelt nach oben und vertraegt Unsinn", () => {
    assert.equal(resolveKnowledgeUpdateTimeoutMs(1_000_000), 180_000);
    assert.equal(resolveKnowledgeUpdateTimeoutMs(undefined), 30_000);
    assert.equal(resolveKnowledgeUpdateTimeoutMs(-5), 30_000);
  });
});
