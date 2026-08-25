/**
 * tests/critical-classifier-secret-criterion.test.js
 *
 * Der Klassifizierer beschrieb `zugang_passwort` als „Passwort, API-Key, Login,
 * Token". Alle anderen Typen sind ueber VORHANDENEN Inhalt definiert (Diagnose,
 * Medikament, IBAN) — hier stand mit „Login" eine Taetigkeit in der Liste. Das
 * LLM klassifizierte daraufhin auf das Wortfeld statt auf ein Geheimnis.
 *
 * Beobachtet am 25.08.2026 in einem produktiven Bestand: 4 von 4 offenen
 * `zugang_passwort`-Karten enthielten KEIN Passwort-, Token- oder API-Key-Muster:
 *   - ein Audio-Transkript („also ich du bist so witzig ne ja ernsthaft")
 *   - eine Werkzeugliste (browser_find, browser_click, browser_fill_form)
 *   - die Anweisung „Zugangsdaten NICHT im Text nennen"
 *   - die Bemerkung, dass ein Agent Zugriff auf ein Abo hat
 *
 * Folge: harmlose Inhalte werden im Push ausgeblendet und verlangen eine
 * Entscheidung.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyMemory } from "../lib/critical-push-classifier.js";

/** Faengt den Prompt ab, den classifyMemory an das Modell schickt. */
async function capturePrompt(content = "irgendein Inhalt") {
  let seen = "";
  const model = { complete: async ({ prompt }) => { seen = prompt; return { text: "fakt" }; } };
  await classifyMemory(content, model);
  return seen;
}

describe("Klassifizierer-Prompt: zugang_passwort", () => {
  it("verlangt einen tatsaechlich vorhandenen Geheimniswert", async () => {
    const p = await capturePrompt();
    const zeile = p.split("\n").find((l) => l.includes("zugang_passwort"));
    assert.ok(zeile, "zugang_passwort-Zeile fehlt");
    assert.match(p, /TATSAECHLICH|tatsächlich/i);
  });

  it("schliesst die blosse Erwaehnung von Login oder Zugriff aus", async () => {
    const p = await capturePrompt();
    const block = p.slice(p.indexOf("zugang_passwort"), p.indexOf("Memory-Inhalt"));
    assert.match(block, /NICHT/, "es fehlt eine explizite Abgrenzung");
    assert.match(block, /Erwaehnung|Erwähnung/i);
  });

  it("nennt weiterhin die echten Geheimnisarten", async () => {
    const p = await capturePrompt();
    const block = p.slice(p.indexOf("zugang_passwort"), p.indexOf("Memory-Inhalt"));
    for (const wort of ["Passwort", "API-Key", "Token"]) assert.match(block, new RegExp(wort, "i"), wort);
  });

  it("laesst die uebrigen Typdefinitionen unveraendert", async () => {
    const p = await capturePrompt();
    assert.match(p, /- gesundheit:\s+Diagnose, Medikament, Allergie, Termin/);
    assert.match(p, /- geld_konto:\s+Bankkonto, Karte, IBAN, Zahlungsmittel/);
    assert.match(p, /- fakt:\s+alles andere \(Default\)/);
  });

  it("uebergibt den Inhalt weiterhin an das Modell", async () => {
    const p = await capturePrompt("Christian hat um 23:14 Novaminsulfon genommen");
    assert.match(p, /Novaminsulfon/);
  });
});
