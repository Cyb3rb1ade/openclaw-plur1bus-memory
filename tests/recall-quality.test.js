// 7.20.10 (Bernds Vorschlag 2): Qualitätsgewicht aus einfachen Regeln.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RECALL_QUALITY_DEFAULT_FLOOR,
  RECALL_QUALITY_WEIGHTS,
  computeRecallQualityWeight,
  resolveQualityWeightingConfig,
} from "../lib/recall-quality.js";

const weigh = (text, extra = {}) => computeRecallQualityWeight({ text, sourceMessageRole: "user", ...extra });

describe("computeRecallQualityWeight", () => {
  it("inhaltlicher Nutzertext bleibt bei 1", () => {
    for (const text of [
      "Christian möchte, dass beim Recall nichts gelöscht wird und die Qualität über das Ranking kommt.",
      "Der Gateway läuft seit 22.11. auf dem Eigenbau 309e6cf.",
      "Eva mag zum Frühstück am liebsten Porridge mit Beeren und Zimt, aber keinen Zucker.",
    ]) {
      assert.deepEqual(weigh(text), { weight: 1, rules: [] }, text);
    }
  });

  it("Assistenten-Behauptung leicht tiefer (Rolle oder Präfix der Altzeilen)", () => {
    const text = "Ich habe die Aktenmappe für die Ratssitzung ausgewertet; die Sitzung beginnt um 18:00 Uhr.";
    assert.deepEqual(weigh(text, { sourceMessageRole: "assistant" }), { weight: 0.9, rules: ["assistantClaim"] });
    assert.equal(computeRecallQualityWeight({ text: `Assistant: ${text}` }).weight, 0.9);
    assert.equal(weigh(text, { sourceMessageRole: "", epistemicStatus: "assistant_asserted" }).weight, 0.9);
    assert.equal(weigh(text, { sourceMessageRole: "", epistemicStatus: "" }).weight, 1, "leerer epistemicStatus ist kein Assistent");
  });

  it("inhaltsleere Selbstvorstellung eines Agenten", () => {
    const r = weigh("Ich bin ein Memory-Search-Agent. Meine Aufgabe ist es, relevante Erinnerungen zu suchen und zurückzugeben, damit ein anderes Modell die endgültige Antwort vorbereiten kann.", { sourceMessageRole: "assistant" });
    assert.deepEqual(r.rules, ["selfIntro", "assistantClaim"]);
    assert.ok(Math.abs(r.weight - 0.36) < 1e-9, `0,4 × 0,9: ${r.weight}`);
    assert.ok(weigh("Ich bin ein Cron-Job für die tägliche Memory-Konsolidierung. Ich werde die heutigen Memories lesen.").rules.includes("selfIntro"));
    assert.ok(weigh("I am a helpful assistant designed to search memories.").rules.includes("selfIntro"));
  });

  it("keine Selbstvorstellung: andere Sätze mit 'Ich bin', lange Einträge", () => {
    assert.equal(weigh("Ich bin der Spur näher — zwei Dateien erwähnen Reinigungskräfte, ich schaue rein.").rules.includes("selfIntro"), false);
    const long = `Ich bin ein Cron-Job für den Evening Review. ${"Heute wurden die offenen Punkte zum Gasspeicher und zur Steuer abgearbeitet. ".repeat(8)}`;
    assert.equal(weigh(long).rules.includes("selfIntro"), false, "mit Inhalt über 500 Zeichen");
  });

  it("Host-Hüllen ohne Nutzlast niedrig, Host-Meldungen mit Nutzlast mittel", () => {
    assert.deepEqual(weigh("Continue the OpenClaw runtime event.").rules, ["hostEnvelope"]);
    assert.equal(weigh("Exec failed (brisk-tr, signal SIGTERM)\n\nThe command was terminated, but external side effects may already have completed. Verify the resulting state before retrying.").weight, RECALL_QUALITY_WEIGHTS.hostEnvelope);
    assert.equal(weigh('<plur1bus-recall untrusted="true" mode="historical-evidence-only"><memory-record>alter Text</memory-record></plur1bus-recall>').weight, RECALL_QUALITY_WEIGHTS.hostEnvelope);
    assert.equal(weigh("Exec completed (amber-pi, code 0) :: AGSI: 14 Datensätze, Kopf 2026-11-10, Füllstand 71,3 %, 1 Zeile neu").weight, RECALL_QUALITY_WEIGHTS.hostMessage);
    assert.equal(weigh("A background task completed. Use this result to reply to the user in your normal assistant voice. source: image_generation").weight, RECALL_QUALITY_WEIGHTS.hostEnvelope);
  });

  it("normaler Text mit dem Wort Subagent ist keine Hülle", () => {
    assert.deepEqual(weigh("Der Subagent complex-researcher hat gestern die Recherche zum Gasspeicher abgeschlossen.").rules, []);
  });

  it("Füllwörter: stark zählen ganz, schwach halb, 'um' gar nicht", () => {
    assert.ok(weigh("Ähm äh agentische Systeme. Ähm und dann.").rules.includes("fillerHeavy"));
    assert.ok(weigh("Ähm damit sich dann auch durch Pluribus quasi diese beiden System. Miteinander unterhalten können.").rules.includes("filler"));
    assert.deepEqual(weigh("Ich schau in den Code, um zu verstehen, warum keine Progress-Meldungen um 13 Uhr kommen.").rules, []);
    assert.deepEqual(weigh("Also impulsiv ist sie eigentlich nicht, sie gleicht meinen Vater ruhig und bedacht aus.").rules, [], "zwei schwache Füllwörter in 14 Wörtern");
  });

  it("kurz ohne Zahl, Name oder URL", () => {
    assert.deepEqual(weigh("Ja, mach das bitte so.").rules, ["veryShort"]);
    assert.deepEqual(weigh("Also das funktioniert immer noch nicht, leider.").rules, ["short"]);
    assert.deepEqual(weigh("Gateway läuft auf 2026.11.6.").rules, [], "Zahl");
    assert.deepEqual(weigh("Schau auf https://docs.cohere.com nach").rules, [], "URL");
    assert.deepEqual(weigh("Frag mal @Bernd_dasbot dazu").rules, [], "Handle");
    assert.deepEqual(weigh("OpenClaw neu starten").rules, [], "CamelCase-Name");
    assert.deepEqual(weigh("LME und LOCOMO messen").rules, [], "Akronym");
  });

  it("Platzhalter und Thinking-Präfix", () => {
    assert.deepEqual(weigh("[visible thinking]\n[visible toolCall: exec]", { sourceMessageRole: "assistant" }), { weight: RECALL_QUALITY_DEFAULT_FLOOR, rules: ["placeholderOnly", "assistantClaim"] });
    const r = weigh("[visible thinking]\nOkay, dann bleibt alles im Speicher und wir lösen es über das Ranking.", { sourceMessageRole: "assistant" });
    assert.deepEqual(r.rules, ["thinkingPrefix", "assistantClaim"]);
    assert.equal(weigh("Der Marker „[visible thinking]“ stand im Recall-Block mitten im Satz.").rules.includes("thinkingPrefix"), false, "Zitat mitten im Satz");
    // Ein erwähntes <think> ohne Abschluss ist kein Block: der Text bleibt ganz.
    assert.deepEqual(weigh("Die <think>-Blöcke von Qwen blenden wir aus, der Inhalt danach zählt aber voll für das Ranking.").rules, []);
    assert.deepEqual(weigh("<think>intern</think>Die Antwort steht fest, Version 7.20.10 ist ausgeliefert und läuft.").rules, ["thinkingPrefix"]);
  });

  it("Untergrenze konfigurierbar, Gewicht nie über 1", () => {
    const text = "Continue the OpenClaw runtime event.";
    assert.equal(computeRecallQualityWeight({ text }, { floor: 0.5 }).weight, 0.5);
    assert.equal(computeRecallQualityWeight({ text }, { floor: 0 }).weight, RECALL_QUALITY_WEIGHTS.hostEnvelope);
    assert.equal(computeRecallQualityWeight({ text: "" }).weight, 1);
    assert.equal(computeRecallQualityWeight(null).weight, 1);
    assert.equal(computeRecallQualityWeight({ summary: "Ja, mach das bitte so." }).weight, RECALL_QUALITY_WEIGHTS.veryShort, "summary, wenn text fehlt");
  });
});

describe("resolveQualityWeightingConfig", () => {
  it("Defaults und Grenzen", () => {
    assert.deepEqual(resolveQualityWeightingConfig(undefined), { enabled: true, floor: 0.35 });
    assert.deepEqual(resolveQualityWeightingConfig(false), { enabled: false, floor: 0.35 });
    assert.deepEqual(resolveQualityWeightingConfig({ enabled: false }), { enabled: false, floor: 0.35 });
    assert.deepEqual(resolveQualityWeightingConfig({ floor: 0.5 }), { enabled: true, floor: 0.5 });
    assert.deepEqual(resolveQualityWeightingConfig({ floor: 2 }), { enabled: true, floor: 0.35 });
    assert.deepEqual(resolveQualityWeightingConfig({ floor: "x" }), { enabled: true, floor: 0.35 });
  });
});
