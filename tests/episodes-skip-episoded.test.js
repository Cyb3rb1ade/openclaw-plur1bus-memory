import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";

import { makeTempDir } from "./helpers/temp-dir.js";
import { extractEpisodesWithState } from "../lib/episodes.js";

const T0 = Date.now() - 40 * 60_000;

function turn(id, role, content, offsetSeconds) {
  return { id, role, content, createdAt: new Date(T0 + offsetSeconds * 1000).toISOString() };
}

describe("7.12.55: bereits episodierte Spannen kosten keinen Modellaufruf", () => {
  const turns = [
    turn("turn-a", "user", "Wie lief der Umzug der Datenbank?", 0),
    turn("turn-b", "assistant", "Die Migration lief sauber durch, alle Zeilen sind übernommen.", 30),
    turn("turn-c", "user", "Gut, dann kann der alte Server weg.", 60),
    turn("turn-d", "assistant", "Ich habe ihn abgeschaltet und den Eintrag entfernt.", 90),
  ];

  it("reichert eine bekannte Spanne nicht erneut an", async (t) => {
    const dir = makeTempDir("episodes-skip-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let calls = 0;
    const result = await extractEpisodesWithState(turns, {
      workspaceDir: dir,
      agentId: "agent-a",
      episodedTurnIds: new Set(["turn-a", "turn-b", "turn-c", "turn-d"]),
      llmCfg: { model: "test" },
      callLlm: async () => { calls += 1; return JSON.stringify({ title: "T", summary: "S" }); },
    });
    assert.equal(calls, 0, "kein Aufruf für eine verworfene Spanne");
    assert.equal(result.skippedEpisodedSpans, 1);
    assert.equal(result.episodes.length, 1, "die Spanne entsteht weiter, der Aufrufer verwirft sie");
  });

  it("reichert eine neue Spanne weiterhin an", async (t) => {
    const dir = makeTempDir("episodes-fresh-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let calls = 0;
    const result = await extractEpisodesWithState(turns, {
      workspaceDir: dir,
      agentId: "agent-a",
      episodedTurnIds: new Set(["turn-a"]),
      llmCfg: { model: "test" },
      callLlm: async () => { calls += 1; return JSON.stringify({ title: "T", summary: "S" }); },
    });
    assert.equal(calls, 1, "teilweise neue Spanne wird angereichert");
    assert.equal(result.skippedEpisodedSpans, 0);
  });

  it("ohne Angabe bleibt es beim bisherigen Verhalten", async (t) => {
    const dir = makeTempDir("episodes-default-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let calls = 0;
    const result = await extractEpisodesWithState(turns, {
      workspaceDir: dir,
      agentId: "agent-a",
      llmCfg: { model: "test" },
      callLlm: async () => { calls += 1; return JSON.stringify({ title: "T", summary: "S" }); },
    });
    assert.equal(calls, 1);
    assert.equal(result.skippedEpisodedSpans, 0);
  });
});
