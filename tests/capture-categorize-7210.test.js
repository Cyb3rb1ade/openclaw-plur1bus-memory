// 7.20.10 (A2): Kategorien beim Capture. "noch immer", "wie immer" usw. sind
// keine Vorliebe, "like" zählt nur mit Subjekt, reine Fragen sind Gespräch
// (LanceDB) bzw. offene Fragen (Neo); Neo-Regeln mit Wortgrenzen.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_CATEGORIES,
  categorizeMemoryWithReason,
  isQuestionOnly,
  stripNonDurablePhrases,
} from "../lib/categorize.js";
import {
  behaviorCardsFromReactions,
  categorizeNeoText,
  createTurnEvent,
  reactionSignalsFromTurns,
} from "../lib/neo-arch.js";

const cat = (text) => categorizeMemoryWithReason(text).category;
const userTurn = (content) => createTurnEvent({ role: "user", content, workspaceKey: "main", agentId: "main", sessionId: "s1" });

describe("categorizeMemoryWithReason — nicht dauerhafte Wendungen (A2)", () => {
  it("das Selbst-Echo vom 24.11. ist keine Vorliebe mehr", () => {
    const echo = "Angeblich bekommst du jetzt viel bessere Erinnerungen in den Kontext gespült. Ich versuche noch immer, PLUR1BUS für Dich und Bernhardine zu perfektionieren";
    assert.equal(cat(echo), "conversation");
  });

  it("immer noch, wie immer, was auch immer, noch nie, nie wieder lösen keine Vorliebe aus", () => {
    for (const text of [
      "Also das funktioniert immer noch nicht.",
      "Und wie immer: @Bernhardine_dasBot und @Bernd_dasbot",
      "Was auch immer da passiert ist, es läuft wieder.",
      "Das habe ich noch nie gesehen, sehr seltsam.",
      "Der Server stürzt immer wieder ab nach dem Update.",
      "As always, thanks for the quick help here.",
    ]) {
      assert.notEqual(cat(text), "preference", text);
    }
  });

  it("dauerhafte Marker bleiben eine Vorliebe", () => {
    assert.equal(cat("ab jetzt immer auf Deutsch"), "preference");
    assert.equal(cat("Antworte mir immer auf Deutsch"), "preference");
    assert.equal(cat("I never want emojis"), "preference");
    assert.equal(cat("From now on, use German for repo prompts"), "preference");
    assert.equal(cat("Ich möchte nie wieder so lange Antworten"), "preference", "möchte trägt die Vorliebe");
  });

  it("like zählt nur mit Subjekt", () => {
    assert.notEqual(cat("like sugar in rain, the city glowed under neon light"), "preference");
    assert.notEqual(cat("It felt like a dream where the walls were made of glass"), "preference");
    assert.equal(cat("I'd like shorter answers"), "preference");
    assert.equal(cat("I would like the summary in German"), "preference");
    assert.equal(cat("I really like the dark theme"), "preference");
    assert.equal(cat("User likes short answers"), "preference");
  });

  it("reine Fragen werden conversation mit eigenem Grund, gemischte bleiben auf dem alten Weg", () => {
    assert.deepEqual(categorizeMemoryWithReason("Ist der auto-capture-Bug noch da?"), { category: "conversation", reason: "question without assertion" });
    assert.equal(cat("Was ist das? Wie geht das?"), "conversation");
    assert.equal(cat("Antwortest du mir immer auf Deutsch?"), "conversation", "Frage mit immer ist keine Vorliebe");
    assert.equal(
      cat("[Audio transcript (machine-generated, untrusted)]: \"Christian: Kannst du mir sagen, wie das Projekt heißt?\""),
      "conversation",
    );
    assert.equal(cat("We decided to use React. Is that fine?"), "decision", "Aussage plus Frage bleibt beim alten Weg");
  });

  it("liefert nur gültige Kategorien", () => {
    for (const text of ["noch immer", "?", "like", "Was?", "Ähm ok"]) {
      assert.ok(MEMORY_CATEGORIES.includes(cat(text)), text);
    }
  });
});

describe("isQuestionOnly / stripNonDurablePhrases", () => {
  it("erkennt reine Fragen, nicht gemischte und nicht lange Texte", () => {
    assert.equal(isQuestionOnly("Geht das?"), true);
    assert.equal(isQuestionOnly("Geht das? Und das?\nUnd jenes?"), true);
    assert.equal(isQuestionOnly("Das geht. Oder?"), false);
    assert.equal(isQuestionOnly("Kein Fragezeichen"), false);
    assert.equal(isQuestionOnly(`${"Warum ".repeat(120)}?`), false);
    assert.equal(isQuestionOnly("Christian: Wie spät ist es?"), true);
  });

  it("entfernt nur die Wendungen, nicht das Wort immer allein", () => {
    assert.doesNotMatch(stripNonDurablePhrases("Das geht noch immer nicht"), /immer/);
    assert.match(stripNonDurablePhrases("Mach das immer so"), /immer/);
    assert.doesNotMatch(stripNonDurablePhrases("Wie immer danke"), /immer/i);
  });
});

describe("categorizeNeoText — Wortgrenzen und offene Fragen (A2)", () => {
  it("Anhänge und Bezeichner werden nicht user_preference", () => {
    assert.notEqual(categorizeNeoText("[visible image (image/jpeg)]", "user"), "user_preference");
    assert.notEqual(categorizeNeoText("Klick auf share_button", "user"), "user_preference");
    assert.notEqual(categorizeNeoText("Die Tonhöhe der Stimme passt", "user"), "user_preference");
    assert.equal(categorizeNeoText("Ich mag kurze Antworten", "user"), "user_preference");
    assert.equal(categorizeNeoText("Der Ton ist zu förmlich", "user"), "user_preference");
  });

  it("hoffentlich ist keine offene Frage, digital kein git", () => {
    assert.notEqual(categorizeNeoText("Hoffentlich klappt das morgen", "user"), "open_question");
    assert.notEqual(categorizeNeoText("Das Dokument ist digital signiert", "user"), "tooling_constraint");
    assert.equal(categorizeNeoText("git push auf main", "user"), "tooling_constraint");
  });

  it("Wortstämme laufen weiter", () => {
    assert.equal(categorizeNeoText("Fehlermeldung beim Start", "user"), "bug");
    assert.equal(categorizeNeoText("Das debugging dauert", "user"), "bug");
    assert.equal(categorizeNeoText("Die offene Frage bleibt", "user"), "open_question");
    assert.equal(categorizeNeoText("Wir haben uns entschieden: entscheidung steht", "user"), "architecture_decision");
  });

  it("reine Fragen werden open_question statt project_fact", () => {
    assert.equal(categorizeNeoText("Ist der auto-capture-Bug noch da?", "user"), "open_question");
    assert.equal(categorizeNeoText("Wie heißt das Projekt?", "user"), "open_question");
  });

  it("Assistant- und Tool-Regeln bleiben", () => {
    assert.equal(categorizeNeoText("I will fix it", "assistant"), "assistant_plan");
    assert.equal(categorizeNeoText("npm test passed", "tool"), "test_result");
    assert.equal(categorizeNeoText("latest build output", "tool"), "tooling_constraint");
  });
});

describe("Neo-Reaktionen und Verhaltenskarten (A2)", () => {
  it("\"noch immer\" erzeugt keine Anweisung mehr", () => {
    const reactions = reactionSignalsFromTurns([userTurn("Ich versuche noch immer, PLUR1BUS zu perfektionieren")]);
    assert.equal(reactions.length, 0);
  });

  it("\"immer\" als Anweisung bleibt", () => {
    const reactions = reactionSignalsFromTurns([userTurn("Antworte immer auf Deutsch")]);
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].explicitness, "explicit_instruction");
  });

  it("Kategorie der Karte mit Wortgrenzen (directory ist kein Kommunikationsstil)", () => {
    const cards = behaviorCardsFromReactions(reactionSignalsFromTurns([userTurn("Arbeite immer im directory /srv/data")]));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].category, "workflow_preference");
    const styled = behaviorCardsFromReactions(reactionSignalsFromTurns([userTurn("Antworte immer kurz und direkt")]));
    assert.equal(styled[0].category, "communication_style");
  });
});
