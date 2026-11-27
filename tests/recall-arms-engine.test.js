/**
 * tests/recall-arms-engine.test.js
 *
 * The retrieval-arm switches through the real before_prompt_build handler
 * (golden-prefix driver): with recall.eventDateRender on and an enrichment
 * sidecar next to the agent's store, the record gets event-date/event-ago
 * and the block one instruction line — and nothing else changes, also with
 * the arms in shadow mode. The off path is pinned by tests/golden-prefix.test.js.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { FROZEN_NOW, runScenario } from "./helpers/golden-prefix-driver.js";
import { appendAgentEnrichmentEntries } from "../lib/enrichment/sidecar.js";
import { enrichmentContentHash } from "../lib/enrichment/enrich-llm.js";
import { EVENT_DATE_INSTRUCTION } from "../lib/event-date-render.js";

const basic = SCENARIOS.find((s) => s.name === "recall-basic");
const expected = readFileSync(new URL("./fixtures/golden-prefix/expected/recall-basic.txt", import.meta.url), "utf8");
const RELEASE_ID = "22222222-2222-4222-8222-222222222222";

function sidecarEntry(text, extra = {}) {
  return {
    id: RELEASE_ID,
    contentHash: enrichmentContentHash(text),
    enrichedAt: FROZEN_NOW - 1_000,
    enrichVersion: 1,
    model: "test",
    promptHash: "test",
    timeZone: "Europe/Berlin",
    anchorTs: FROZEN_NOW - 10 * 86_400_000,
    entities: [],
    about: [],
    facets: ["work"],
    event: { from: "2026-01-02", until: "2026-01-02", fromMs: Date.UTC(2026, 0, 1, 23), untilMs: Date.UTC(2026, 0, 2, 23), precision: "day", kind: "past", phrase: "on 2026-01-02", source: "explicit" },
    dateCheck: "agree",
    ...extra,
  };
}

function scenarioWith(recallExtra, entryText) {
  const release = basic.memories.find((m) => m.id === RELEASE_ID);
  return {
    ...basic,
    config: {
      ...basic.config,
      recall: {
        dedup: false,
        canonicalFirst: true,
        canonicalMaxItems: 1,
        maxPromptMemories: 5,
        decisionTrace: { enabled: false, includeInPrompt: false },
        globalInjectMaxChars: 17_000,
        ...recallExtra,
      },
    },
    beforeRegister: ({ baseDbPath }) => {
      const written = appendAgentEnrichmentEntries(baseDbPath, basic.agentId, "backfill", [sidecarEntry(entryText ?? release.text)]);
      assert.equal(written.written, 1);
    },
  };
}

function stripEventDate(text) {
  return text
    .replace(/ event-date="[^"]*" event-ago="[^"]*"/g, "")
    .replace(`\n${EVENT_DATE_INSTRUCTION}`, "");
}

describe("retrieval-arm switches through before_prompt_build", () => {
  it("eventDateRender adds event-date/event-ago to the dated record and changes nothing else", async () => {
    const actual = await runScenario(scenarioWith({ eventDateRender: { enabled: true } }));
    const line = actual.split("\n").find((l) => l.includes(`id="${RELEASE_ID}"`));
    assert.match(line, /event-date="2026-01-02" event-ago="13 days ago"/);
    assert.equal(actual.split(EVENT_DATE_INSTRUCTION).length, 2);
    assert.equal(stripEventDate(actual), expected);
  });

  it("a stale sidecar entry (other text) renders no event date", async () => {
    const actual = await runScenario(scenarioWith({ eventDateRender: { enabled: true } }, "an older wording of the release note"));
    assert.equal(actual, expected);
  });

  it("arms in shadow mode leave the prompt unchanged", async () => {
    const actual = await runScenario(scenarioWith({ retrievalArms: { mode: "shadow", entity: true, eventTime: true } }));
    assert.equal(actual, expected);
  });

  it("arms read the sidecar and real LanceDB rows (Arrow vectors) through the engine", async () => {
    const lines = [];
    const scenario = scenarioWith({ retrievalArms: { mode: "shadow", eventTime: true, timeoutMs: 2_000 } });
    const prompt = "When was the release decision made?";
    const actual = await runScenario({
      ...scenario,
      topics: { ...scenario.topics, [prompt]: "dashboard" },
      event: { ...scenario.event, prompt, messages: [{ role: "user", content: prompt }] },
      onLog: (level, message) => { if (/retrieval arms/.test(message)) lines.push(message); },
    });
    assert.equal(typeof actual, "string");
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], /mode=shadow .*event=1 /, "the dated row passed hydration, ACL, freshness and scoring");
  });

  it("collection width on a lookup question leaves the prompt unchanged", async () => {
    const actual = await runScenario(scenarioWith({ collectionWidth: { enabled: true }, candidateHardLimitMax: 200 }));
    assert.equal(actual, expected);
  });
});
