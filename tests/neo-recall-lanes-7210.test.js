// 7.20.10 (Mangel 5): Neo-Lanes, deren Etikett zum Inhalt passt.
//
// Bis 7.20.9 war die Lane nur ein Rang: routeNeoRecall bewertete jeden
// Eintrag in allen 14 Lanes und legte ihn in die erste Lane mit freiem Platz.
// Um 12:59 standen so sieben assistant_claim-Einträge unter recent_turns,
// workspace_facts, architecture_decisions, user_preferences und behavior_cards.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NEO_AUTO_RECALL_LANES,
  NEO_DEFAULT_MAX_REFLECTIONS,
  NEO_RECALL_LANES,
  routeNeoRecall,
  scoreNeoRecallItem,
  formatNeoRecallContext,
  dedupeNeoLanesAgainstTexts,
  filterNeoItemsAgainstTexts,
  resolveNeoLaneMinRelevance,
  captureNeoFromAgentEnd,
  candidateIndexEntry,
  turnEventsFromMessages,
} from "../lib/neo-arch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_SOURCE = readFileSync(join(__dirname, "..", "index.js"), "utf8");

// Optionen wie im Auto-Recall-Hook (index.js, before_prompt_build).
const HOOK_OPTS = {
  requesterAgentId: "main",
  lanes: NEO_AUTO_RECALL_LANES,
  maxPerLane: 2,
  minScore: 0.08,
  excludeQueryEcho: true,
  strictLanes: true,
  laneCaps: { agent_private_reflections: NEO_DEFAULT_MAX_REFLECTIONS },
};

function unitVector(cos) {
  // Anfragevektor ist [1, 0]; dieser Vektor hat zur Anfrage genau `cos`.
  return [cos, Math.sqrt(1 - cos * cos)];
}

function assistant(id, statement, extra = {}) {
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

function user(id, statement, category, extra = {}) {
  return {
    id,
    workspaceKey: "main",
    statement,
    category,
    status: "active",
    salience: 0.8,
    recency: 1,
    origin: { role: "user", trustLevel: "user_asserted", scope: "workspace_shared" },
    ...extra,
  };
}

function laneOf(lanes, id) {
  for (const [lane, rows] of Object.entries(lanes)) {
    if (rows.some((row) => row.item.id === id)) return lane;
  }
  return null;
}

describe("NEO_AUTO_RECALL_LANES", () => {
  it("ohne recent_turns und behavior_cards, sonst wie NEO_RECALL_LANES", () => {
    assert.ok(!NEO_AUTO_RECALL_LANES.includes("recent_turns"));
    assert.ok(!NEO_AUTO_RECALL_LANES.includes("behavior_cards"));
    assert.deepEqual(
      [...NEO_AUTO_RECALL_LANES],
      NEO_RECALL_LANES.filter((lane) => lane !== "recent_turns" && lane !== "behavior_cards"),
    );
  });
});

describe("routeNeoRecall strictLanes", () => {
  it("assistant_* landet nur in agent_private_reflections", () => {
    const items = [
      assistant("a1", "Der Plan steht, ich werde morgen die Lanes umbauen.", { category: "assistant_plan", embedding: unitVector(0.7) }),
      assistant("a2", "Die Lanes sind nach Kategorie sortiert.", { embedding: unitVector(0.7) }),
      assistant("a3", "Vielleicht koennte man die Lanes anders sortieren.", { category: "assistant_suggestion", embedding: unitVector(0.7) }),
    ];
    const lanes = routeNeoRecall(items, "Lanes sortieren", { ...HOOK_OPTS, queryVector: [1, 0] });
    for (const id of ["a1", "a2", "a3"]) assert.equal(laneOf(lanes, id), "agent_private_reflections", id);
  });

  it("eine Kategorie ohne Lane landet nie in einer fremden Lane", () => {
    const items = ["success", "external_source", "test_result", "agent_strategy"].map((category, i) =>
      user(`u${i}`, `Eintrag ${category} mit dem Wort Gateway`, category, { embedding: unitVector(0.9) }));
    const lanes = routeNeoRecall(items, "Gateway", { ...HOOK_OPTS, requesterWorkspaceKey: "main", queryVector: [1, 0] });
    assert.equal(Object.values(lanes).flat().length, 0);
  });

  it("User-Einträge mit passender Kategorie bleiben in ihrer Lane", () => {
    const items = [
      user("pref", "Ich mag kurze Antworten auf Deutsch.", "user_preference"),
      user("fact", "Der Gateway laeuft auf dem VPS.", "project_fact"),
      user("bug", "Der Recall-Block ist kaputt.", "bug"),
    ];
    const lanes = routeNeoRecall(items, "Antworten Gateway Recall", { ...HOOK_OPTS, requesterWorkspaceKey: "main", minScore: 0 });
    assert.equal(laneOf(lanes, "pref"), "user_preferences");
    assert.equal(laneOf(lanes, "fact"), "workspace_facts");
    assert.equal(laneOf(lanes, "bug"), "failures_and_corrections");
  });

  it("15 assistant-Einträge ergeben höchstens 4 Reflexionen und kein fremdes Etikett", () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      assistant(`r${i}`, `Bericht Nummer ${i} ueber den Recall-Test mit eigenem Inhalt ${i}`, { embedding: unitVector(0.6 + i * 0.01) }));
    const lanes = routeNeoRecall(items, "Recall-Test Bericht", { ...HOOK_OPTS, queryVector: [1, 0] });
    const rows = Object.entries(lanes).flatMap(([lane, list]) => list.map((row) => ({ lane, id: row.item.id, score: row.score })));
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.lane === "agent_private_reflections"));
    // die stärksten vier (höchster Kosinus)
    assert.deepEqual(rows.map((row) => row.id).sort(), ["r11", "r12", "r13", "r14"]);
  });

  it("laneCaps 0 schaltet die Reflexionen ab", () => {
    const items = [assistant("a1", "Ein Bericht ueber den Recall-Test.", { embedding: unitVector(0.9) })];
    const lanes = routeNeoRecall(items, "Recall-Test", { ...HOOK_OPTS, queryVector: [1, 0], laneCaps: { agent_private_reflections: 0 } });
    assert.equal(Object.values(lanes).flat().length, 0);
  });

  it("ohne strictLanes bleibt der Überlauf wie bis 7.20.9 (memory_search)", () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      assistant(`o${i}`, `Bericht ${i} ueber den Recall-Test Nummer ${i}`, { embedding: unitVector(0.8) }));
    const lanes = routeNeoRecall(items, "Recall-Test", { requesterAgentId: "main", queryVector: [1, 0], maxPerLane: 2, minScore: 0.08 });
    const used = Object.entries(lanes).filter(([, rows]) => rows.length > 0).map(([lane]) => lane);
    assert.deepEqual(used, ["recent_turns", "workspace_facts", "architecture_decisions"]);
  });

  it("die Scores ändern sich durch den strengen Modus nicht", () => {
    const item = assistant("s1", "Ein Bericht ueber den Recall-Test.", { embedding: unitVector(0.75) });
    const strict = routeNeoRecall([item], "Recall-Test", { ...HOOK_OPTS, queryVector: [1, 0] });
    const legacy = routeNeoRecall([item], "Recall-Test", { requesterAgentId: "main", queryVector: [1, 0], maxPerLane: 2, minScore: 0.08 });
    assert.equal(strict.agent_private_reflections[0].score, legacy.recent_turns[0].score);
  });
});

describe("routeNeoRecall: fast gleiche Texte im strengen Modus", () => {
  const status = [
    "No active exec sessions, no subagents, no media tasks running right now.",
    "No active exec sessions, no subagents, no media tasks running right now!",
    "No active exec sessions, no subagents and no media tasks running right now.",
  ];

  it("eine Statuszeile in drei Fassungen belegt nur einen Platz, die nächsten rücken nach", () => {
    const items = [
      ...status.map((text, i) => assistant(`st${i}`, text, { embedding: unitVector(0.9 - i * 0.01) })),
      assistant("x1", "Der Gasspeicher ist zu 71 Prozent gefuellt.", { embedding: unitVector(0.7) }),
      assistant("x2", "Kohlrouladen brauchen etwa eine Stunde im Ofen.", { embedding: unitVector(0.69) }),
      assistant("x3", "Der Bericht zum Recall-Test liegt im Workspace.", { embedding: unitVector(0.68) }),
    ];
    const lanes = routeNeoRecall(items, "Status exec sessions", { ...HOOK_OPTS, queryVector: [1, 0] });
    assert.deepEqual(lanes.agent_private_reflections.map((row) => row.item.id), ["st0", "x1", "x2", "x3"]);
  });

  it("Texte, die sich nur in Zahlen oder Daten unterscheiden, bleiben beide", () => {
    const items = [
      assistant("d1", "Daily Notes für 2026-08-23 angelegt und im Vault abgelegt.", { embedding: unitVector(0.9) }),
      assistant("d2", "Daily Notes für 2026-08-27 angelegt und im Vault abgelegt.", { embedding: unitVector(0.89) }),
    ];
    const lanes = routeNeoRecall(items, "Daily Notes", { ...HOOK_OPTS, queryVector: [1, 0] });
    assert.deepEqual(lanes.agent_private_reflections.map((row) => row.item.id), ["d1", "d2"]);
  });

  it("ohne strictLanes (memory_search) bleibt alles, nearDuplicateJaccard überschreibt die Schwelle", () => {
    const items = status.map((text, i) => assistant(`st${i}`, text, { embedding: unitVector(0.9 - i * 0.01) }));
    const legacy = routeNeoRecall(items, "Status exec sessions", { requesterAgentId: "main", queryVector: [1, 0], maxPerLane: 3, minScore: 0.08 });
    assert.equal(Object.values(legacy).flat().length, 3);
    const off = routeNeoRecall(items, "Status exec sessions", { ...HOOK_OPTS, queryVector: [1, 0], nearDuplicateJaccard: false });
    assert.equal(off.agent_private_reflections.length, 3);
  });
});

describe("Talk-Mode-Präfix zählt im Neo-Score nicht (Befund TALK-EMB)", () => {
  const PREFIX = "Talk Mode active. Reply in a concise, spoken tone.";
  const query = `${PREFIX}\n\nWie wird das Wetter morgen`;
  const talkJa = user("t1", `${PREFIX}\n\nJa`, "user_preference");
  const wetter = user("w1", "Das Wetter morgen wird sonnig mit 20 Grad", "user_preference");

  it("eine Talk-Mode-Anfrage hebt eine Talk-Mode-Zeile ohne Inhalt nicht über einen Treffer", () => {
    // Bis 7.20.9 teilten Anfrage und "Ja"-Zeile die sieben Präfixwörter (Jaccard 0,54).
    assert.ok(scoreNeoRecallItem(wetter, query, "user_preferences") > scoreNeoRecallItem(talkJa, query, "user_preferences"));
    assert.equal(
      scoreNeoRecallItem(talkJa, query, "user_preferences"),
      scoreNeoRecallItem(user("t2", "Ja", "user_preference"), "Wie wird das Wetter morgen", "user_preferences"),
    );
    const lanes = routeNeoRecall([talkJa, wetter], query, { ...HOOK_OPTS, requesterWorkspaceKey: "main", minScore: 0, laneMinRelevance: 0.1 });
    assert.deepEqual(lanes.user_preferences.map((row) => row.item.id), ["w1"], "laneMinRelevance misst ohne Präfix");
  });
});

describe("routeNeoRecall sessionEcho (laufendes Gespräch)", () => {
  const KEY = "agent:main:telegram:direct:55736530";
  const SINCE = Date.parse("2026-11-24T08:00:00.000Z");
  const items = [
    assistant("now", "Die Antwort von eben zum Kontext-Block steht noch im Verlauf.", { createdAt: "2026-11-24T08:44:45.000Z", origin: { role: "assistant", trustLevel: "assistant_asserted", scope: "agent_private", sessionKey: KEY }, embedding: unitVector(0.9) }),
    assistant("old", "Eine ältere Antwort zum Kontext-Block vor der Kompaktierung.", { createdAt: "2026-11-24T07:10:00.000Z", origin: { role: "assistant", trustLevel: "assistant_asserted", scope: "agent_private", sessionKey: KEY }, embedding: unitVector(0.85) }),
    assistant("other", "Eine Antwort zum Kontext-Block aus einer anderen Sitzung.", { createdAt: "2026-11-24T08:50:00.000Z", origin: { role: "assistant", trustLevel: "assistant_asserted", scope: "agent_private", sessionKey: "agent:main:cron:x" }, embedding: unitVector(0.8) }),
    assistant("legacy", "Eine Antwort zum Kontext-Block ohne Sitzungsschlüssel.", { createdAt: "2026-11-24T08:55:00.000Z", embedding: unitVector(0.75) }),
  ];
  const ids = (lanes) => lanes.agent_private_reflections.map((row) => row.item.id);

  it("Einträge derselben Sitzung nach dem Stichtag fallen weg, der Rest bleibt", () => {
    const lanes = routeNeoRecall(items, "Kontext-Block", { ...HOOK_OPTS, queryVector: [1, 0], sessionEcho: { sessionKey: KEY, since: SINCE } });
    assert.deepEqual(ids(lanes), ["old", "other", "legacy"]);
  });

  it("ohne Option oder mit ungültiger Option bleibt alles (memory_search)", () => {
    assert.deepEqual(ids(routeNeoRecall(items, "Kontext-Block", { ...HOOK_OPTS, queryVector: [1, 0] })), ["now", "old", "other", "legacy"]);
    assert.deepEqual(ids(routeNeoRecall(items, "Kontext-Block", { ...HOOK_OPTS, queryVector: [1, 0], sessionEcho: { sessionKey: "", since: SINCE } })), ["now", "old", "other", "legacy"]);
    assert.deepEqual(ids(routeNeoRecall(items, "Kontext-Block", { ...HOOK_OPTS, queryVector: [1, 0], sessionEcho: { sessionKey: KEY, since: NaN } })), ["now", "old", "other", "legacy"]);
  });

  it("Capture schreibt den Sitzungsschlüssel in origin, Index und Kandidaten tragen ihn", () => {
    const appended = {};
    const store = {
      appendTurns: (rows) => { appended.turns = rows; return rows; },
      appendCandidates: (rows) => { appended.candidates = rows; return rows; },
      appendReactions: (rows) => rows,
      appendBehaviorCards: (rows) => rows,
      appendEmbeddingQueue: () => {},
    };
    captureNeoFromAgentEnd(
      { sessionId: "run-0dbe04ad", messages: [{ role: "assistant", content: "Der Kontext-Block kommt jetzt aus zwei Quellen." }] },
      { agentId: "main", workspaceKey: "main", sessionKey: ` ${KEY} ` },
      store,
    );
    assert.equal(appended.turns[0].origin.sessionKey, KEY);
    assert.equal(appended.turns[0].origin.sessionId, "run-0dbe04ad", "sessionId bleibt die Lauf-ID");
    assert.equal(appended.candidates[0].origin.sessionKey, KEY);
    assert.equal(candidateIndexEntry(appended.candidates[0]).origin.sessionKey, KEY);
    const withoutKey = turnEventsFromMessages([{ role: "user", content: "Ohne Schlüssel" }], { workspaceKey: "main", agentId: "main", sessionId: "s" });
    assert.equal(Object.hasOwn(withoutKey[0].origin, "sessionKey"), false);
  });

  it("der Auto-Recall-Hook setzt sessionEcho mit dem Stichtag des LanceDB-Blocks", () => {
    const block = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf("neoRouteOptions = {"), INDEX_SOURCE.indexOf("neoRouteItems = neoItems;"));
    assert.match(block, /sessionEcho: \{\s*sessionKey: normalizeMemorySessionKey\(ctx\?\.sessionKey \|\| event\?\.sessionKey\),\s*since: resolveSessionEchoCutoff\(event\?\.messages, \{ now: Date\.now\(\) \}\)\.since,/);
  });
});

describe("laneMinRelevance", () => {
  it("Kosinus 0,3 mit hohen Vorwerten fällt raus, Kosinus 0,6 bleibt", () => {
    const items = [
      user("weak", "Ganz anderes Thema ohne Bezug.", "project_fact", { embedding: unitVector(0.3), salience: 1, status: "promoted" }),
      user("strong", "Der Gateway laeuft wieder.", "project_fact", { embedding: unitVector(0.6) }),
    ];
    const opts = { ...HOOK_OPTS, requesterWorkspaceKey: "main", queryVector: [1, 0] };
    const without = routeNeoRecall(items, "Status Gateway", opts);
    assert.deepEqual(without.workspace_facts.map((row) => row.item.id).sort(), ["strong", "weak"]);
    const withMin = routeNeoRecall(items, "Status Gateway", { ...opts, laneMinRelevance: 0.45 });
    assert.deepEqual(withMin.workspace_facts.map((row) => row.item.id), ["strong"]);
  });

  it("ohne Vektor zählt der Wort-Jaccard", () => {
    const items = [
      user("lex", "gateway status check done", "project_fact"),
      user("none", "voellig anderer inhalt hier", "project_fact"),
    ];
    const lanes = routeNeoRecall(items, "gateway status check please", { ...HOOK_OPTS, requesterWorkspaceKey: "main", laneMinRelevance: 0.5 });
    assert.deepEqual(lanes.workspace_facts.map((row) => row.item.id), ["lex"]);
  });

  it("Objektform je Lane mit default", () => {
    const items = [
      assistant("refl", "Ein Bericht ueber den Gateway.", { embedding: unitVector(0.5) }),
      user("fact", "Der Gateway laeuft.", "project_fact", { embedding: unitVector(0.5) }),
    ];
    const lanes = routeNeoRecall(items, "Gateway", {
      ...HOOK_OPTS,
      requesterWorkspaceKey: "main",
      queryVector: [1, 0],
      laneMinRelevance: { default: 0.45, agent_private_reflections: 0.55 },
    });
    assert.equal(laneOf(lanes, "fact"), "workspace_facts");
    assert.equal(laneOf(lanes, "refl"), null);
  });

  it("resolveNeoLaneMinRelevance: aus bei fehlenden oder ungültigen Werten", () => {
    for (const value of [undefined, null, 0, -1, 2, "0.5", [], {}, { default: "x" }]) {
      assert.equal(resolveNeoLaneMinRelevance(value), null, JSON.stringify(value));
    }
    assert.equal(resolveNeoLaneMinRelevance(0.4)("workspace_facts"), 0.4);
    const byLane = resolveNeoLaneMinRelevance({ agent_private_reflections: 0.55 });
    assert.equal(byLane("agent_private_reflections"), 0.55);
    assert.equal(byLane("workspace_facts"), null);
  });
});

describe("Dedupe gegen den LanceDB-Block ohne Lücken", () => {
  it("filterNeoItemsAgainstTexts entfernt nur globale Treffer mit gleichem Text", () => {
    const items = [
      assistant("w1", "Eva trinkt gern Tee am Abend"),
      assistant("g1", "Eva trinkt gern Tee am Abend"),
      assistant("g2", "Etwas ganz anderes ueber Autos"),
    ];
    const result = filterNeoItemsAgainstTexts(items, ["Eva trinkt gern Tee am Abend"], { onlyIds: new Set(["g1", "g2"]) });
    assert.deepEqual(result.items.map((item) => item.id), ["w1", "g2"]);
    assert.equal(result.dropped, 1);
    assert.equal(filterNeoItemsAgainstTexts(items, []).dropped, 0);
  });

  it("nach dem Neu-Routing rücken die nächsten Treffer nach", () => {
    const words = [["alpha", "anker"], ["bravo", "birne"], ["charlie", "chor"], ["delta", "dach"], ["echo", "eule"], ["foxtrot", "fuchs"]];
    const items = words.map(([a, b], i) =>
      assistant(`g${i}`, `Bericht ueber den Gateway mit ${a} und ${b}`, { embedding: unitVector(0.9 - i * 0.05) }));
    const opts = { ...HOOK_OPTS, queryVector: [1, 0] };
    const first = routeNeoRecall(items, "Gateway", opts);
    assert.deepEqual(first.agent_private_reflections.map((row) => row.item.id), ["g0", "g1", "g2", "g3"]);
    // g0 und g1 stehen schon im LanceDB-Block.
    const memoryTexts = [items[0].statement, items[1].statement];
    const globalIds = new Set(items.map((item) => item.id));
    const deduped = dedupeNeoLanesAgainstTexts(first, memoryTexts, { onlyIds: globalIds, threshold: 0.8 });
    assert.equal(deduped.dropped, 2);
    assert.equal(deduped.lanes.agent_private_reflections.length, 2, "ohne Neu-Routing bleiben zwei Plätze leer");
    const filtered = filterNeoItemsAgainstTexts(items, memoryTexts, { onlyIds: globalIds, threshold: 0.8 });
    const rerouted = routeNeoRecall(filtered.items, "Gateway", opts);
    assert.deepEqual(rerouted.agent_private_reflections.map((row) => row.item.id), ["g2", "g3", "g4", "g5"]);
  });
});

describe("formatNeoRecallContext", () => {
  it("sortiert über alle Lanes nach Score, abgeschnitten werden die schwächsten", () => {
    const long = "x".repeat(250);
    const lanes = {
      workspace_facts: [{ item: user("low", `niedrig ${long}`, "project_fact"), score: 0.1 }],
      agent_private_reflections: [
        { item: assistant("high", `hoch ${long}`), score: 0.9 },
        { item: assistant("mid", `mittel ${long}`), score: 0.5 },
      ],
    };
    const out = formatNeoRecallContext(lanes, { maxTotalChars: 1100 });
    const ids = [...out.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ["high", "mid"]);
    assert.match(out, /\[truncated\]/);
  });

  it("kürzt Einträge standardmäßig auf 300 Zeichen", () => {
    const out = formatNeoRecallContext({ agent_private_reflections: [{ item: assistant("long", "a".repeat(600)), score: 0.5 }] });
    const evidence = out.match(/<quoted-evidence>([^<]*)<\/quoted-evidence>/)[1];
    assert.equal(evidence.length, 300);
  });
});

describe("Auto-Recall-Hook", () => {
  it("liest keine Behavior Cards mehr", () => {
    assert.ok(!INDEX_SOURCE.includes("neoStore.readBehaviorCards("), "Hook liest Behavior Cards");
    assert.match(INDEX_SOURCE, /const neoItems = \[\.\.\.neoStore\.readCandidates\(500, requester\)\];/);
  });

  it("routet streng mit den Auto-Recall-Lanes und der Reflexions-Obergrenze", () => {
    const block = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf("neoRouteOptions = {"), INDEX_SOURCE.indexOf("neoRouteItems = neoItems;"));
    assert.match(block, /lanes: NEO_AUTO_RECALL_LANES/);
    assert.match(block, /strictLanes: true/);
    assert.match(block, /laneCaps: \{ agent_private_reflections: neoPromptRecall\.maxReflections \}/);
    assert.match(block, /laneMinRelevance: neoPromptRecall\.laneMinRelevance/);
  });

  it("routet nach der Dedupe gegen den LanceDB-Block neu", () => {
    assert.match(INDEX_SOURCE, /filterNeoItemsAgainstTexts\(neoRouteItems, memoryTexts, dedupeOptions\)/);
    assert.match(INDEX_SOURCE, /routeNeoRecall\(filtered\.items, event\.prompt, neoRouteOptions\)/);
  });

  it("der memory_search-Pfad liest weiter Behavior Cards und routet ohne strictLanes", () => {
    assert.match(INDEX_SOURCE, /const items = \[\.\.\.store\.readCandidates\(500, requester\), \.\.\.store\.readBehaviorCards\(200, requester\)\];/);
    assert.match(INDEX_SOURCE, /routeNeoRecall\(items, params\?\.query \|\| "", \{ \.\.\.requester, queryVector, maxPerLane: /);
  });
});

describe("Nachstellung 12:59 (anonymisiert)", () => {
  // Aufbau wie im Prompt von 12:59: sieben assistant_claim-Treffer, fünf davon
  // mit "[visible thinking]"-Präfix, dazu reine Platzhalter, ein Echo der
  // Anfrage (Bernds eigene Antwort von 08:44 enthielt sie wörtlich) und
  // Einträge anderer Agenten aus dem Fenster.
  const QUERY = "Angeblich bekommst du jetzt viel bessere Erinnerungen in den Kontext. Ich versuche noch immer, das System fuer euch beide zu verbessern";
  const items = [
    assistant("mem_a", "Die Erinnerungen kommen jetzt ueber zwei Bloecke in den Kontext.", { embedding: unitVector(0.61) }),
    assistant("mem_b", "Der Kontext-Block war gestern noch leer.", { embedding: unitVector(0.6) }),
    assistant("mem_c", "[visible thinking]\nStimmt, der Vergleich mit dem Kontext ist gar nicht so abwegig.", { embedding: unitVector(0.58) }),
    assistant("mem_d", "[visible thinking]\nDie Erinnerungen im Kontext sind diesmal deutlich besser sortiert.", { embedding: unitVector(0.58) }),
    assistant("mem_e", "[visible thinking]\nTest wiederholt — diesmal laeuft der Recall sauber.", { embedding: unitVector(0.55) }),
    assistant("mem_f", "[visible thinking]\nWeiterer Recall-Testbericht: alle Treffer kamen an.", { embedding: unitVector(0.55) }),
    assistant("mem_g", "[visible thinking]\nListe der Erinnerungen, die mir am meisten bedeuten.", { embedding: unitVector(0.55) }),
    assistant("mem_placeholder_1", "[visible thinking]\n[visible toolCall: exec]", { embedding: unitVector(0.62) }),
    assistant("mem_placeholder_2", "[visible toolCall: memory_recall]", { embedding: unitVector(0.62) }),
    assistant("mem_echo", `[visible thinking]\n${QUERY}`, { embedding: unitVector(0.99) }),
    // fremder Agent im Fenster (developer-Lauf): unsichtbar
    assistant("mem_dev", "Interner Testlauf des Entwickler-Agenten zum Kontext.", { agentId: "developer", embedding: unitVector(0.9) }),
  ];

  it("kein Platzhalter, kein Echo, kein assistant-Eintrag unter einer User-Lane, höchstens vier", () => {
    const lanes = routeNeoRecall(items, QUERY, { ...HOOK_OPTS, queryVector: [1, 0] });
    const rows = Object.entries(lanes).flatMap(([lane, list]) => list.map((row) => ({ lane, row })));
    assert.ok(rows.length > 0 && rows.length <= 4, `rows=${rows.length}`);
    assert.ok(rows.every(({ lane }) => lane === "agent_private_reflections"));
    const ids = rows.map(({ row }) => row.row?.item?.id || row.item.id);
    assert.ok(!ids.includes("mem_echo"));
    assert.ok(!ids.includes("mem_placeholder_1") && !ids.includes("mem_placeholder_2"));
    assert.ok(!ids.includes("mem_dev"));
    const out = formatNeoRecallContext(lanes, { idempotencyKey: "replay" });
    assert.doesNotMatch(out, /\[visible/);
    assert.doesNotMatch(out, /lane="(?:recent_turns|workspace_facts|architecture_decisions|user_preferences|behavior_cards)"/);
    assert.equal((out.match(/<memory-record /g) || []).length, rows.length);
  });

  it("die inhaltlichen Einträge bleiben als Reflexionen erhalten", () => {
    const lanes = routeNeoRecall(items, QUERY, { ...HOOK_OPTS, queryVector: [1, 0] });
    const ids = lanes.agent_private_reflections.map((row) => row.item.id).sort();
    assert.deepEqual(ids, ["mem_a", "mem_b", "mem_c", "mem_d"]);
  });
});
