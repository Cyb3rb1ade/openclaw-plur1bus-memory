import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEpisode,
  extractEpisodesFromTurns,
  enrichEpisodeNarratively,
  resolveParticipantNames,
  parseEpisodeJson,
  applyEnrichment,
  locationFromSessionKey,
  writeEpisodeToVault,
} from "../lib/episodes.js";

const T0 = new Date("2026-09-10T19:03:45.000Z").getTime();
function turn(role, content, i = 0) {
  return { id: `turn-${role}-${i}`, role, content, createdAt: new Date(T0 + i * 1000).toISOString() };
}

describe("episodes (7.12.40): Metadaten", () => {
  it("Teilnehmer kommen aus USER.md und IDENTITY.md, nicht aus grossgeschriebenen Woertern", () => {
    const dir = mkdtempSync(join(tmpdir(), "ep-"));
    writeFileSync(join(dir, "USER.md"), "# USER.md\n\n- **Name:** Christian\n- **What to call them:** Chris\n", "utf8");
    writeFileSync(join(dir, "IDENTITY.md"), "# IDENTITY.md\n\n> **Name:** Bernd dasBot\n> **Creature:** Kumpel\n", "utf8");
    const names = resolveParticipantNames(dir, { agentId: "main" });
    assert.deepEqual(names, { user: "Christian", assistant: "Bernd dasBot" });
    const ep = createEpisode([
      turn("user", "Endlich ist es wieder soweit 😂😂 Aber Test, Kumpel!", 0),
      turn("assistant", "Was für ein Feuer, Diggi. Transkript folgt.", 1),
    ], { participantNames: names, agentId: "main" });
    assert.deepEqual(ep.participants, ["Christian", "Bernd dasBot"]);
    // Rueckfall ohne Dateien
    const empty = mkdtempSync(join(tmpdir(), "ep-"));
    assert.deepEqual(resolveParticipantNames(empty, { agentId: "heisenberg" }), { user: "Nutzer", assistant: "heisenberg" });
    // Cache folgt der mtime: Datei aendern → neuer Name.
    writeFileSync(join(dir, "USER.md"), "- **Name:** Chris\n", "utf8");
    assert.equal(resolveParticipantNames(dir, { agentId: "main" }).user, "Chris");
  });

  it("Themen ohne Modell: Nomen statt Satzanfaenge, keine Platzhalter, Markup, Zahlen oder Rauschwoerter", () => {
    const ep = createEpisode([
      turn("user", "[Audio transcript (machine-generated, untrusted)]: \"Meine Schulter tut seit zwei Wochen weh, ich kann nicht auf der Seite pennen.\" https://example.org/x 2097700367546933386", 0),
      turn("assistant", "<visible>Schulter und Kissen sind ein Thema. Die Schulter braucht Ruhe, das Kissen eine andere Position.</visible> thinking visible", 1),
      turn("user", "Und morgen reden wir wieder über die Milchsuppe, die Milchsuppe war gut.", 2),
    ], { agentId: "main" });
    assert.ok(ep.topics.includes("schulter"), `schulter fehlt: ${ep.topics}`);
    assert.ok(ep.topics.includes("kissen"), `kissen fehlt: ${ep.topics}`);
    assert.ok(ep.topics.includes("milchsuppe"), `milchsuppe fehlt: ${ep.topics}`);
    for (const bad of ["visible", "thinking", "transcript", "nicht", "morgen", "reden", "wieder", "2097700367546933386", "audio"]) {
      assert.ok(!ep.topics.includes(bad), `Rauschwort im Thema: ${bad} (${ep.topics})`);
    }
    assert.ok(ep.topics.length <= 5);
  });

  it("Emotion kommt aus dem Stimmungs-Snapshot: neutral bei niedrig, dominant erst ab mittel", () => {
    const turns = [turn("user", "Hallo", 0), turn("assistant", "Moin", 1)];
    const low = createEpisode(turns, { mood: { label: "ausgeglichen", dominant: "fear", intensity: "niedrig", details: { joy: 0.2, trust: 0.45, fear: 0.14 } } });
    assert.equal(low.emotionalDominant, "neutral");
    assert.equal(low.emotionalIntensity, 0.45);
    const mid = createEpisode(turns, { mood: { label: "fröhlich", dominant: "joy", intensity: "mittel", details: { joy: 0.6, trust: 0.45 } } });
    assert.equal(mid.emotionalDominant, "joy");
    assert.equal(mid.emotionalTone.joy, 0.6);
    // Ohne Snapshot und ohne Turn-Valenz: neutral, nicht "fear 0.14".
    const none = createEpisode(turns, {});
    assert.equal(none.emotionalDominant, "neutral");
    assert.equal(none.emotionalIntensity, 0);
  });

  it("location folgt dem Session-Key statt dem ACL-Scope", () => {
    assert.equal(locationFromSessionKey("agent:main:telegram:default:direct:55736530"), "dm");
    assert.equal(locationFromSessionKey("agent:main:telegram:group:-100:topic:5"), "group");
    assert.equal(locationFromSessionKey("agent:main:main:heartbeat"), "heartbeat");
    assert.equal(createEpisode([turn("user", "x")], { sessionKey: "agent:main:telegram:default:direct:1" }).location, "dm");
  });

  it("parseEpisodeJson nimmt Code-Zaeune und Vorspann an", () => {
    assert.deepEqual(parseEpisodeJson("```json\n{\"title\":\"A\"}\n```"), { title: "A" });
    assert.deepEqual(parseEpisodeJson("Hier ist das JSON: {\"title\":\"B\",\"topics\":[\"x\"]} fertig."), { title: "B", topics: ["x"] });
    assert.equal(parseEpisodeJson("kein json"), null);
    assert.equal(parseEpisodeJson(""), null);
  });

  it("Anreicherung feuert schon bei zwei Turns und uebernimmt nur valide topics/people/emotion", async () => {
    const names = { user: "Christian", assistant: "Bernd dasBot" };
    const turns = [
      turn("user", "Meine Schulter tut weh, ich kann nachts nicht liegen.", 0),
      turn("assistant", "Probier mal ein Kissen unter dem Arm, Diggi. Und frag Eva nach der Salbe.", 1),
    ];
    let seenPrompt = "";
    const callLlm = async (messages) => {
      seenPrompt = messages[0].content;
      return "```json\n" + JSON.stringify({
        title: "Schulterschmerzen in der Nacht",
        summary: "Christian klagt über Schulterschmerzen beim Liegen. Bernd schlägt ein Kissen und Evas Salbe vor.",
        narrativeArc: "unsinn",
        turningPoint: "",
        topics: ["Schulterschmerzen", "Kissen", "", "x".repeat(80), "Salbe", "Schulterschmerzen", "Nacht", "Sechstes"],
        people: ["Eva", "Christian", "Bernd dasBot", 42],
        emotion: "Sadness",
      }) + "\n```";
    };
    const base = createEpisode(turns, { participantNames: names, agentId: "main", mood: { dominant: "fear", intensity: "niedrig", details: { fear: 0.1 } } });
    const ep = await enrichEpisodeNarratively(base, turns, { model: "x" }, callLlm, { agentId: "main", participantNames: names });
    assert.match(seenPrompt, /\[Christian\] Meine Schulter/);
    assert.match(seenPrompt, /\[Bernd dasBot\] Probier/);
    assert.equal(ep.title, "Schulterschmerzen in der Nacht");
    assert.match(ep.summary, /Kissen/);
    assert.equal(ep.narrativeArc, "exploration", "invalid arc falls back");
    assert.deepEqual(ep.topics, ["Schulterschmerzen", "Kissen", "Salbe", "Nacht", "Sechstes"], "max 5, dedup, length bounds");
    assert.deepEqual(ep.participants, ["Christian", "Bernd dasBot", "Eva"], "speakers first, mentioned people after, no duplicates");
    assert.equal(ep.emotionalDominant, "sadness", "engine was low → LLM emotion counts");
    // Engine mittel/hoch schlaegt das Modell.
    const strong = createEpisode(turns, { participantNames: names, mood: { dominant: "joy", intensity: "hoch", details: { joy: 0.8 } } });
    const ep2 = applyEnrichment(strong, { emotion: "sadness" }, { turns, names });
    assert.equal(ep2.emotionalDominant, "joy");
  });

  it("ohne Modell bleiben Titel/Summary generisch, mit Modell kommt alles in die Karte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ep-"));
    writeFileSync(join(dir, "USER.md"), "- **Name:** Christian\n", "utf8");
    writeFileSync(join(dir, "IDENTITY.md"), "> **Name:** Bernd dasBot\n", "utf8");
    const turns = [turn("user", "Was kochen wir morgen? Milchsuppe?", 0), turn("assistant", "Milchsuppe geht immer, Diggi.", 1)];
    const plain = await extractEpisodesFromTurns(turns, { workspaceDir: dir, agentId: "main", sessionKey: "agent:main:telegram:default:direct:1" });
    assert.equal(plain.length, 1);
    assert.deepEqual(plain[0].participants, ["Christian", "Bernd dasBot"]);
    assert.match(plain[0].title, /^Gespräch vom/);
    const rich = await extractEpisodesFromTurns(turns, {
      workspaceDir: dir, agentId: "main", sessionKey: "agent:main:telegram:default:direct:1",
      llmCfg: { model: "x" },
      callLlm: async () => JSON.stringify({ title: "Milchsuppe für morgen", summary: "Christian fragt nach dem Essen, Bernd schlägt Milchsuppe vor.", narrativeArc: "decision", turningPoint: "", topics: ["Milchsuppe", "Abendessen"], people: [], emotion: "joy" }),
    });
    assert.equal(rich[0].title, "Milchsuppe für morgen");
    assert.deepEqual(rich[0].topics, ["Milchsuppe", "Abendessen"]);
    assert.equal(rich[0].emotionalDominant, "joy");
    const written = writeEpisodeToVault(rich[0], dir);
    assert.equal(written.written, true);
    const files = readdirSync(join(dir, "memory", "episodes", "2026", "09"));
    assert.ok(files.some((f) => f.includes("milchsuppe-für-morgen")), files.join(","));
    const card = readFileSync(written.path, "utf8");
    assert.match(card, /participants: \[Christian, Bernd dasBot\]/);
    assert.match(card, /topics: \[Milchsuppe, Abendessen\]/);
    assert.match(card, /emotional_dominant: joy/);
    assert.match(card, /# Milchsuppe für morgen/);
    assert.ok(!card.includes("Exploratives Gespräch ohne klaren Arc"));
  });
});
