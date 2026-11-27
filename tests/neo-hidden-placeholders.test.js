// 7.20.10 (Mangel 4): Neo schrieb fuer jeden Nicht-Text-Block eine
// Platzhalterzeile wie "[visible thinking]" oder "[visible toolCall: exec]" in
// den Turn-Text. A1 stellt das beim Capture ab, C1 blendet die Zeilen im
// Altbestand vor Score und Render aus.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractVisibleText,
  turnEventsFromMessages,
  memoryCandidatesFromTurns,
  stripNeoHiddenPlaceholders,
  scoreNeoRecallItem,
  routeNeoRecall,
  formatNeoRecallContext,
  dedupeNeoLanesAgainstTexts,
} from "../lib/neo-arch.js";

const REQUESTER = { requesterAgentId: "main" };

function assistantItem(id, statement, extra = {}) {
  return {
    id,
    agentId: "main",
    statement,
    category: "assistant_claim",
    status: "candidate",
    salience: 0.35,
    recency: 1,
    origin: { role: "assistant", trustLevel: "assistant_asserted", scope: "agent_private" },
    ...extra,
  };
}

describe("A1: extractVisibleText ueberspringt versteckte Blocktypen", () => {
  it("[thinking, text] ergibt nur den Text", () => {
    const text = extractVisibleText([
      { type: "thinking" },
      { type: "text", text: "Okay, dann bleibt alles im Speicher." },
    ]);
    assert.equal(text, "Okay, dann bleibt alles im Speicher.");
  });

  it("[thinking, toolCall] ergibt einen leeren String", () => {
    assert.equal(extractVisibleText([{ type: "thinking" }, { type: "toolCall", name: "exec" }]), "");
  });

  it("[text, toolCall] ergibt nur den Text", () => {
    assert.equal(extractVisibleText([{ type: "text", text: "Ich schaue nach." }, { type: "toolCall", name: "memory_recall" }]), "Ich schaue nach.");
  });

  it("alle versteckten Typen fallen weg", () => {
    for (const type of ["thinking", "redacted_thinking", "reasoning", "toolCall", "tool_use", "toolUse", "functionCall", "function_call", "server_tool_use"]) {
      assert.equal(extractVisibleText([{ type, name: "x" }, { type: "text", text: "Inhalt" }]), "Inhalt", type);
    }
  });

  it("Medien-Platzhalter bleiben", () => {
    assert.equal(extractVisibleText([{ type: "image", mediaType: "image/jpeg" }]), "[visible image (image/jpeg)]");
    assert.equal(
      extractVisibleText([{ type: "text", text: "Schau mal" }, { type: "document", fileName: "plan.pdf" }]),
      "Schau mal\n[visible document: plan.pdf]",
    );
  });
});

describe("A1: Capture ohne Platzhalter-Turns", () => {
  const messages = [
    { role: "user", content: "Was ist der Stand?" },
    { role: "assistant", content: [{ type: "thinking" }, { type: "toolCall", name: "exec" }] },
    { role: "assistant", content: [{ type: "thinking" }, { type: "text", text: "Alles erledigt, der Lauf ist durch." }] },
  ];

  it("Assistant-Nachricht nur aus Thinking und Tool-Aufruf ergibt keinen Turn", () => {
    const turns = turnEventsFromMessages(messages, { workspaceKey: "ws", agentId: "main", sessionKey: "s1" });
    assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"]);
    assert.equal(turns[1].content, "Alles erledigt, der Lauf ist durch.");
    assert.ok(turns.every((t) => !t.content.includes("[visible")));
    // Ordnungszahlen bleiben fortlaufend.
    assert.deepEqual(turns.map((t) => t.turnIndex), [0, 1]);
  });

  it("aus Thinking plus Tool-Aufruf entsteht kein Kandidat", () => {
    const turns = turnEventsFromMessages(messages.slice(1, 2), { workspaceKey: "ws", agentId: "main", sessionKey: "s1" });
    assert.equal(turns.length, 0);
    assert.equal(memoryCandidatesFromTurns(turns).length, 0);
  });

  it("die Turn-ID haengt nur am sichtbaren Text", () => {
    const withThinking = turnEventsFromMessages(
      [{ role: "assistant", content: [{ type: "thinking" }, { type: "text", text: "Gleicher Text." }] }],
      { workspaceKey: "ws", agentId: "main", sessionKey: "s1" },
    );
    const plain = turnEventsFromMessages(
      [{ role: "assistant", content: [{ type: "text", text: "Gleicher Text." }] }],
      { workspaceKey: "ws", agentId: "main", sessionKey: "s1" },
    );
    assert.equal(withThinking[0].id, plain[0].id);
  });
});

describe("C1: stripNeoHiddenPlaceholders", () => {
  it("entfernt Platzhalterzeilen am Anfang und dazwischen", () => {
    assert.equal(stripNeoHiddenPlaceholders("[visible thinking]\nStimmt, der Vergleich passt."), "Stimmt, der Vergleich passt.");
    assert.equal(
      stripNeoHiddenPlaceholders("Erst das.\n[visible toolCall: exec]\nDann das."),
      "Erst das.\n\nDann das.",
    );
  });

  it("reiner Platzhalter wird leer", () => {
    assert.equal(stripNeoHiddenPlaceholders("[visible thinking]\n[visible toolCall: exec]"), "");
    assert.equal(stripNeoHiddenPlaceholders("[visible toolCall: memory_recall]"), "");
  });

  it("Zitat mitten im Satz bleibt", () => {
    const quote = "Der Marker [visible thinking] steht vor jeder Antwort, das ist der Fehler.";
    assert.equal(stripNeoHiddenPlaceholders(quote), quote);
  });

  it("Medien-Platzhalter und aehnliche Typnamen bleiben", () => {
    assert.equal(stripNeoHiddenPlaceholders("[visible image (image/png)]"), "[visible image (image/png)]");
    assert.equal(stripNeoHiddenPlaceholders("[visible tool_use_result]\nText"), "[visible tool_use_result]\nText");
  });

  it("Text ohne Marker bleibt unveraendert", () => {
    assert.equal(stripNeoHiddenPlaceholders("  normaler Text  "), "  normaler Text  ");
  });
});

describe("C1: Score, Routing und Render ohne Platzhalter", () => {
  it("reiner Platzhalter bekommt keinen Score", () => {
    assert.equal(scoreNeoRecallItem(assistantItem("p1", "[visible thinking]\n[visible toolCall: exec]"), "exec thinking"), -Infinity);
  });

  it("die Platzhalterwoerter zaehlen nicht im lexikalischen Score", () => {
    const withMarker = scoreNeoRecallItem(assistantItem("a", "[visible thinking]\nDer Vergleich passt gut."), "visible thinking");
    const plain = scoreNeoRecallItem(assistantItem("b", "Der Vergleich passt gut."), "visible thinking");
    assert.equal(withMarker, plain);
  });

  it("eine Altzeile wird ohne Praefix gerendert, ein reiner Platzhalter fehlt", () => {
    const out = formatNeoRecallContext({
      agent_private_reflections: [
        { item: assistantItem("mem_old", "[visible thinking]\nStimmt, der Vergleich ist gar nicht so abwegig."), score: 0.4 },
        { item: assistantItem("mem_empty", "[visible thinking]\n[visible toolCall: exec]"), score: 0.3 },
      ],
    });
    assert.match(out, /<quoted-evidence>Stimmt, der Vergleich ist gar nicht so abwegig\.<\/quoted-evidence>/);
    assert.doesNotMatch(out, /\[visible/);
    assert.doesNotMatch(out, /mem_empty/);
  });

  it("ein Block nur aus Platzhaltern bleibt leer", () => {
    const out = formatNeoRecallContext({
      agent_private_reflections: [{ item: assistantItem("mem_empty", "[visible thinking]"), score: 0.3 }],
    });
    assert.equal(out, "");
  });

  it("ein Zitat des Markers mitten im Satz wird gerendert", () => {
    const out = formatNeoRecallContext({
      workspace_facts: [{ item: { id: "q1", statement: "Bernd meldet: vor jeder Antwort steht [visible thinking] im Recall.", category: "project_fact" }, score: 0.5 }],
    });
    assert.match(out, /steht \[visible thinking\] im Recall/);
  });

  it("gleicher Text unter zwei IDs ergibt einen Eintrag", () => {
    const items = [
      assistantItem("mem_alt", "[visible thinking]\nDer Heartbeat ist seit vorgestern ausgefallen."),
      assistantItem("mem_neu", "Der Heartbeat ist seit vorgestern ausgefallen."),
    ];
    const lanes = routeNeoRecall(items, "Heartbeat ausgefallen", { ...REQUESTER, maxPerLane: 5, minScore: -1 });
    const ids = Object.values(lanes).flat().map((row) => row.item.id);
    assert.equal(ids.length, 1);
  });

  it("reine Platzhalter erreichen keine Lane", () => {
    const items = [assistantItem("mem_empty", "[visible toolCall: cron]")];
    const lanes = routeNeoRecall(items, "cron", { ...REQUESTER, maxPerLane: 5, minScore: -5 });
    assert.equal(Object.values(lanes).flat().length, 0);
  });

  it("Dedupe gegen LanceDB-Texte vergleicht ohne Platzhalter", () => {
    const lanes = { workspace_facts: [{ item: assistantItem("g1", "[visible thinking]\nEva trinkt gern Tee am Abend"), score: 0.4 }] };
    const result = dedupeNeoLanesAgainstTexts(lanes, ["Eva trinkt gern Tee am Abend"], { threshold: 1 });
    assert.equal(result.dropped, 1);
  });
});
