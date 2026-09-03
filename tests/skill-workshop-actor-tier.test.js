/**
 * Die Akteursstufe des Skill-Workshop-Spiegels.
 *
 * Der Lebenszyklus-Pfad für extern angewendete Skills übergab `actorTier:
 * "system"` — einen Wert, den `isLegalEpistemicTransition` nie akzeptiert
 * hat. Jeder Nachweis scheiterte deshalb dauerhaft mit „illegal transition",
 * und der lokale Datensatz blieb für immer auf `activation_partial` stehen
 * (im 8.2-Labor an vier Nachweisen sichtbar). Die eigene Stufe darf genau
 * einen Schritt: Nachweise bestätigen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isLegalEpistemicTransition, transitionEpistemicStatus } from "../lib/epistemic-status.js";

const TIER = "system:skill-workshop";

describe("Akteursstufe system:skill-workshop", () => {
  it("darf Nachweise bestätigen", () => {
    for (const from of ["", "observed", "untrusted", "disputed", "corroborated"]) {
      assert.equal(isLegalEpistemicTransition(from, "corroborated", TIER), true, from || "(leer)");
    }
  });

  it("darf nichts anderes", () => {
    for (const to of ["observed", "untrusted", "disputed", "trusted", "invalidated"]) {
      assert.equal(isLegalEpistemicTransition("observed", to, TIER), false, to);
    }
  });

  it("erreicht einen invalidierten Datensatz nicht", () => {
    assert.equal(isLegalEpistemicTransition("invalidated", "corroborated", TIER), false);
  });

  it("weist unbekannte Stufen weiterhin ab", () => {
    for (const tier of ["system", "gateway", "system:skill", "", null, undefined]) {
      assert.equal(isLegalEpistemicTransition("observed", "corroborated", tier), false, String(tier));
    }
  });

  it("schreibt einen vollständigen Übergang mit Akteur", () => {
    const patch = transitionEpistemicStatus({ epistemicStatus: "observed" }, "corroborated", {
      actor: "openclaw-skill-workshop",
      actorTier: TIER,
      reason: "skill-workshop-lifecycle",
    });
    assert.equal(patch.epistemicStatus, "corroborated");
    assert.equal(patch.previousEpistemicStatus, "observed");
    assert.equal(patch.epistemicStatusActor, "openclaw-skill-workshop");
  });

  it("der Lebenszyklus-Pfad übergibt genau diese Stufe", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    assert.match(source, /actor: "openclaw-skill-workshop",[\s\S]{0,400}?actorTier: "system:skill-workshop"/u);
    assert.doesNotMatch(source, /actorTier: "system"(?!:)/u);
  });
});
