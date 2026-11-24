// 7.20.10 (Mangel 1): Selbst-Echo der aktuellen Anfrage im Auto-Recall.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeForEcho, isQueryEcho, createQueryEchoMatcher } from "../lib/query-echo.js";
import { routeNeoRecall } from "../lib/neo-arch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Anonymisierte Nachbildung der Nachricht von 12:59 (gleicher Aufbau, anderer Inhalt).
const QUERY = "Angeblich bekommst du jetzt viel bessere Erinnerungen in den Kontext. Ich versuche noch immer, das System fuer euch beide zu verbessern";

describe("normalizeForEcho", () => {
  it("dekodiert HTML-Entities und vereinheitlicht Satzzeichen", () => {
    assert.equal(normalizeForEcho("Tom &amp; Jerry &lt;3 &#x27;ok&#39;"), "tom jerry 3 ok");
  });

  it("entfernt den Transkript-Umschlag", () => {
    assert.equal(
      normalizeForEcho("[Audio transcript (de)]: \"Hallo zusammen, wie geht es euch heute?\""),
      normalizeForEcho("Hallo zusammen, wie geht es euch heute?"),
    );
  });

  it("entfernt ein Sprecherpraefix", () => {
    assert.equal(normalizeForEcho("Mr. Cy: Das ist ein Test"), "das ist ein test");
  });

  it("NFKC und Kleinschreibung", () => {
    assert.equal(normalizeForEcho("ＡＢＣ Übung"), "abc übung");
  });
});

describe("isQueryEcho", () => {
  it("gleicher Text ist ein Echo", () => {
    assert.equal(isQueryEcho(QUERY, QUERY), true);
  });

  it("Audio-Huelle gegen Klartext", () => {
    assert.equal(isQueryEcho(`[Audio transcript]: "${QUERY}"`, QUERY), true);
  });

  it("Sprecherpraefix und Entities", () => {
    assert.equal(isQueryEcho(`Mr. Cy: ${QUERY.replace("euch", "euch &amp; mich")}`, QUERY.replace("euch", "euch & mich")), true);
  });

  it("Erinnerung steckt in der Anfrage und macht den Grossteil aus", () => {
    const memory = QUERY.slice(0, Math.ceil(QUERY.length * 0.7)).replace(/\s+\S*$/, "");
    assert.equal(isQueryEcho(memory, QUERY), true);
  });

  it("kurzes Zitat in langer Anfrage ist kein Echo", () => {
    const memory = "Ich versuche noch immer, das System";
    assert.ok(memory.length < QUERY.length * 0.6);
    assert.equal(isQueryEcho(memory, QUERY), false);
  });

  it("Teilstueck zaehlt immer, wenn chunkPart gesetzt ist", () => {
    const memory = "Ich versuche noch immer, das System";
    assert.equal(isQueryEcho(memory, QUERY, { chunkPart: true }), true);
  });

  it("Anfrage steckt in der Erinnerung mit wenig Rest", () => {
    assert.equal(isQueryEcho(`${QUERY} Danke!`, QUERY), true);
  });

  it("Anfrage steckt in einer viel laengeren Erinnerung: kein Echo", () => {
    const memory = `${QUERY}. ${"Dazu kommt noch eine lange Ausfuehrung ueber etwas ganz anderes. ".repeat(3)}`;
    assert.equal(isQueryEcho(memory, QUERY), false);
  });

  it("Enthaltensein nur an Wortgrenzen", () => {
    const matcher = createQueryEchoMatcher("alpha beta gamma delta epsilon zeta");
    assert.equal(matcher("lpha beta gamma delta epsilon zet"), false);
  });

  it("kurze Anfrage ist nie ein Echo", () => {
    assert.equal(isQueryEcho("ja genau so", "ja genau so"), false);
    assert.equal(isQueryEcho("Mach weiter", "Mach weiter"), false);
  });

  it("Jaccard an der Grenze 0,9", () => {
    const words = Array.from({ length: 10 }, (_, i) => `wort${i}`);
    const query = words.join(" ");
    // 9 gemeinsame Woerter, je eines verschieden: 9 / 11 = 0,818 → kein Echo
    const a = [...words.slice(0, 9), "anders"].join(" ");
    assert.equal(isQueryEcho(a, query), false);
    // 10 gemeinsame plus eines mehr: 10 / 11 = 0,909 → Echo
    const b = [...words.slice(0, 5), "extra", ...words.slice(5)].join(" ");
    assert.equal(isQueryEcho(b, query), true);
  });

  it("Schwelle ist einstellbar", () => {
    const words = Array.from({ length: 10 }, (_, i) => `wort${i}`);
    const a = [...words.slice(0, 9), "anders"].join(" ");
    assert.equal(isQueryEcho(a, words.join(" "), { minJaccard: 0.8 }), true);
  });

  it("leere Eingaben", () => {
    assert.equal(isQueryEcho("", QUERY), false);
    assert.equal(isQueryEcho(QUERY, ""), false);
    assert.equal(isQueryEcho(null, undefined), false);
  });
});

describe("routeNeoRecall excludeQueryEcho", () => {
  const items = [
    {
      id: "mem_echo",
      workspaceKey: "main",
      statement: QUERY,
      category: "project_fact",
      status: "active",
      salience: 0.8,
      recency: 1,
      origin: { role: "user", trustLevel: "user_asserted", scope: "workspace_shared" },
    },
    {
      id: "mem_other",
      workspaceKey: "main",
      statement: "Die Erinnerungen kommen ueber den Recall-Block in den Kontext, nicht ueber das System selbst.",
      category: "project_fact",
      status: "active",
      salience: 0.8,
      recency: 1,
      origin: { role: "user", trustLevel: "user_asserted", scope: "workspace_shared" },
    },
  ];
  const opts = { requesterWorkspaceKey: "main", maxPerLane: 2, minScore: 0.08 };

  it("ohne Option kommt das Echo an die Spitze", () => {
    const rows = Object.values(routeNeoRecall(items, QUERY, opts)).flat().sort((a, b) => b.score - a.score);
    assert.equal(rows[0].item.id, "mem_echo");
  });

  it("mit Option fehlt das Echo, der Rest bleibt", () => {
    const ids = Object.values(routeNeoRecall(items, QUERY, { ...opts, excludeQueryEcho: true })).flat().map((row) => row.item.id);
    assert.ok(!ids.includes("mem_echo"));
    assert.ok(ids.includes("mem_other"));
  });

  it("ein Echo mit Platzhalterzeile aus Altdaten wird ebenfalls erkannt", () => {
    const withMarker = [{ ...items[0], id: "mem_echo_alt", statement: `[visible thinking]\n${QUERY}` }];
    const ids = Object.values(routeNeoRecall(withMarker, QUERY, { ...opts, excludeQueryEcho: true })).flat().map((row) => row.item.id);
    assert.deepEqual(ids, []);
  });

  it("der Auto-Recall-Hook setzt die Option", () => {
    const source = readFileSync(join(__dirname, "..", "index.js"), "utf8");
    assert.match(source, /routeNeoRecall\(neoItems, event\.prompt, \{[^}]*excludeQueryEcho: true/);
  });
});
