/**
 * tests/recall-context-e2e-7212.test.js — 7.21.2 through the real
 * before_prompt_build path: in a group, a legacy DM memory (origin dm, no
 * session key, no LLM verdict) stays out; the group's own memory is shown.
 * The same store in a direct chat (unknown owner) shows the group memory.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { runScenario } from "./helpers/golden-prefix-driver.js";

const base = () => SCENARIOS.find((s) => s.name === "recall-basic");
const GROUP = "agent:golden-agent:telegram:group:-100123";
const DM = "agent:golden-agent:telegram:default:direct:4242";

function scenario(sessionKey) {
  const s = base();
  return {
    ...s,
    name: "recall-context-e2e",
    startNotice: null,
    knowledge: null,
    topics: { "Wohin geht die Reise?": "trip", "Die Gruppe plant eine Reise nach Lissabon.": "trip", "Eva fliegt im Dezember allein nach Lissabon.": "trip" },
    memories: [
      { id: "11111111-1111-4111-8111-111111111111", text: "Die Gruppe plant eine Reise nach Lissabon.", summary: "Gruppenreise Lissabon", category: "fact", ageDays: 2, fields: { origin: "group", sessionKey: GROUP, sensitivity: "banal", sensitivitySource: "rules" } },
      { id: "22222222-2222-4222-8222-222222222222", text: "Eva fliegt im Dezember allein nach Lissabon.", summary: "Eva Lissabon Dezember", category: "fact", ageDays: 3, fields: { origin: "dm" } },
    ],
    event: { ...s.event, prompt: "Wohin geht die Reise?", sessionKey },
    ctx: { ...s.ctx, sessionKey },
  };
}

describe("context weighting end to end", () => {
  it("in the group: the group's memory yes, the unclassified legacy DM memory no", async () => {
    const out = await runScenario(scenario(GROUP));
    assert.match(out, /Gruppenreise Lissabon|Die Gruppe plant/);
    assert.doesNotMatch(out, /Eva fliegt|Eva Lissabon/);
  });

  it("recall.contextWeighting.enabled=false shows both again", async () => {
    const s = scenario(GROUP);
    s.config = { ...s.config, recall: { ...(s.config?.recall || {}), contextWeighting: { enabled: false } } };
    const out = await runScenario(s);
    assert.match(out, /Eva fliegt|Eva Lissabon/);
  });

  it("in a direct chat with someone who is not the proved owner: the group memory comes, slightly weighted", async () => {
    const out = await runScenario(scenario(DM));
    assert.match(out, /Gruppenreise Lissabon|Die Gruppe plant/);
  });
});
