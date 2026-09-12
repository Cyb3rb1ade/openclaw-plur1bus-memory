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

  it("bewahrt bei einer bekannten letzten Spanne den persistierten openEpisode-Zustand", async (t) => {
    const dir = makeTempDir("episodes-open-state-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const persisted = {
      id: "persisted-open",
      endTime: turns[1].createdAt,
      createdAt: turns[0].createdAt,
      revision: 3,
      vaultPath: "episodes/persisted-open.md",
      turns: turns.slice(0, 2),
    };

    const result = await extractEpisodesWithState(turns.slice(0, 2), {
      workspaceDir: dir,
      agentId: "agent-a",
      openEpisode: persisted,
      episodedTurnIds: new Set(["turn-a", "turn-b"]),
      llmCfg: { model: "test" },
      callLlm: async () => { throw new Error("known span must not call the model"); },
    });

    assert.equal(result.skippedEpisodedSpans, 1);
    assert.equal(result.openEpisode.id, "persisted-open");
    assert.equal(result.openEpisode.vaultPath, persisted.vaultPath);
    assert.deepEqual(result.openEpisode.turns.map((turn) => turn.id), ["turn-a", "turn-b"]);

    const continued = await extractEpisodesWithState([
      turn("turn-c", "user", "Noch eine kurze Nachfrage", 60),
    ], {
      workspaceDir: dir,
      agentId: "agent-a",
      openEpisode: result.openEpisode,
      episodedTurnIds: new Set(["turn-a", "turn-b"]),
      llmCfg: { model: "test" },
      callLlm: async () => JSON.stringify({ title: "Fortsetzung", summary: "Fortgesetzt" }),
    });
    assert.equal(continued.continuedId, "persisted-open");
    assert.equal(continued.openEpisode.id, "persisted-open");
  });

  it("bewahrt den persistierten Zustand auch bei gemischten neuen und bekannten Gruppen", async (t) => {
    const dir = makeTempDir("episodes-open-state-mixed-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const mixedTurns = [
      turn("new-a", "user", "Neue Frage", 0),
      turn("new-b", "assistant", "Neue Antwort", 30),
      turn("old-a", "user", "Bereits gespeicherte Frage", 60 * 60),
      turn("old-b", "assistant", "Bereits gespeicherte Antwort", 60 * 60 + 30),
    ];
    const persisted = {
      id: "persisted-open-mixed",
      endTime: new Date(T0 - 60 * 60_000).toISOString(),
      createdAt: new Date(T0 - 60 * 60_000).toISOString(),
      revision: 2,
      vaultPath: "episodes/persisted-open-mixed.md",
      turns: [turn("prior", "assistant", "Persistierter Zustand", -60 * 60)],
    };
    let calls = 0;

    const result = await extractEpisodesWithState(mixedTurns, {
      workspaceDir: dir,
      agentId: "agent-a",
      openEpisode: persisted,
      episodedTurnIds: new Set(["old-a", "old-b"]),
      llmCfg: { model: "test" },
      callLlm: async () => {
        calls += 1;
        return JSON.stringify({ title: "Neue Episode", summary: "Neue Zusammenfassung" });
      },
    });

    assert.equal(calls, 1, "nur die neue Gruppe wird angereichert");
    assert.equal(result.skippedEpisodedSpans, 1);
    assert.equal(result.episodes.length, 2);
    assert.equal(result.openEpisode.id, "persisted-open-mixed");
    assert.equal(result.openEpisode.vaultPath, persisted.vaultPath);
  });

  it("verwendet bei einer bekannten ersten und neuen letzten Gruppe die neue Episode als openEpisode", async (t) => {
    const dir = makeTempDir("episodes-open-state-final-fresh-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const orderedTurns = [
      turn("old-a", "user", "Bereits gespeicherte Frage", 0),
      turn("old-b", "assistant", "Bereits gespeicherte Antwort", 30),
      turn("new-a", "user", "Neue Frage", 60 * 60),
      turn("new-b", "assistant", "Neue Antwort", 60 * 60 + 30),
    ];
    const persisted = {
      id: "persisted-open-final-fresh",
      endTime: new Date(T0 - 60 * 60_000).toISOString(),
      createdAt: new Date(T0 - 60 * 60_000).toISOString(),
      revision: 1,
      vaultPath: "episodes/persisted-open-final-fresh.md",
      turns: [turn("prior", "assistant", "Persistierter Zustand", -60 * 60)],
    };

    const result = await extractEpisodesWithState(orderedTurns, {
      workspaceDir: dir,
      agentId: "agent-a",
      openEpisode: persisted,
      episodedTurnIds: new Set(["old-a", "old-b"]),
      llmCfg: { model: "test" },
      callLlm: async () => JSON.stringify({ title: "Neue Episode", summary: "Neue Zusammenfassung" }),
    });

    assert.equal(result.skippedEpisodedSpans, 1);
    assert.equal(result.episodes.length, 2);
    assert.equal(result.openEpisode.id, result.episodes[1].id);
    assert.notEqual(result.openEpisode.id, persisted.id);
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
