import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEpisode,
  extractEpisodesFromTurns,
  extractEpisodesWithState,
  enrichEpisodeNarratively,
  resolveParticipantNames,
  parseEpisodeJson,
  applyEnrichment,
  locationFromSessionKey,
  writeEpisodeToVault,
  extractVoiceSpeakers,
  rebuildEpisode,
  findEpisodeCardPath,
} from "../lib/episodes.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const T0 = new Date("2026-09-10T19:03:45.000Z").getTime();
function turn(role, content, i = 0) {
  return { id: `turn-${role}-${i}`, role, content, createdAt: new Date(T0 + i * 1000).toISOString() };
}

describe("episodes (7.12.40): Metadaten", () => {
  it("Teilnehmer kommen aus USER.md und IDENTITY.md, nicht aus grossgeschriebenen Woertern", () => {
    const dir = makeTempDir("ep-");
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
    const empty = makeTempDir("ep-");
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
        emotionIntensity: "niedrig",
      }) + "\n```";
    };
    const base = createEpisode(turns, { participantNames: names, agentId: "main", mood: { dominant: "fear", intensity: "niedrig", details: { fear: 0.1 } } });
    const ep = await enrichEpisodeNarratively(base, turns, { model: "x" }, callLlm, { agentId: "main", participantNames: names });
    assert.match(seenPrompt, /\[Christian\] Meine Schulter/);
    assert.match(seenPrompt, /\[Bernd dasBot\] Probier/);
    assert.match(seenPrompt, /auch bei sachlichem Thema, wenn es jemanden berührt/);
    assert.match(seenPrompt, /neutral nur, wenn keine Gefühlsregung erkennbar ist/);
    assert.match(seenPrompt, /hoch = bestimmt das Gespräch/);
    assert.equal(ep.title, "Schulterschmerzen in der Nacht");
    assert.match(ep.summary, /Kissen/);
    assert.equal(ep.narrativeArc, "exploration", "invalid arc falls back");
    assert.deepEqual(ep.topics, ["Schulterschmerzen", "Kissen", "Salbe", "Nacht", "Sechstes"], "max 5, dedup, length bounds");
    assert.deepEqual(ep.participants, ["Christian", "Bernd dasBot"], "7.12.42: only speakers are participants");
    assert.deepEqual(ep.mentioned, ["Eva"], "mentioned people live in their own field, no speakers, no numbers");
    assert.equal(ep.emotionalDominant, "sadness", "the model read the conversation → its emotion counts");
    assert.equal(ep.emotionalIntensity, 0.3, "niedrig → 0.3");
    // 7.12.42: das Modell schlaegt die Engine — auch bei hohem Engine-Ausschlag.
    const strong = createEpisode(turns, { participantNames: names, mood: { dominant: "joy", intensity: "hoch", details: { joy: 0.8 } } });
    const ep2 = applyEnrichment(strong, { emotion: "neutral", emotionIntensity: "hoch" }, { turns, names });
    assert.equal(ep2.emotionalDominant, "neutral", "sachliches Gespraech bleibt neutral, egal wie die Engine steht");
    assert.ok(ep2.emotionalIntensity <= 0.3);
    const ep3 = applyEnrichment(strong, { emotion: "anticipation", emotionIntensity: 0.9 }, { turns, names });
    assert.equal(ep3.emotionalDominant, "anticipation");
    assert.equal(ep3.emotionalIntensity, 0.9);
    // Ohne Emotion vom Modell bleibt die Engine massgeblich.
    const ep4 = applyEnrichment(strong, { title: "x" }, { turns, names });
    assert.equal(ep4.emotionalDominant, "joy");
  });

  it("ohne Modell bleiben Titel/Summary generisch, mit Modell kommt alles in die Karte", async () => {
    const dir = makeTempDir("ep-");
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
    assert.ok(!card.includes("mentioned:"), "no mentioned line when nobody was mentioned");
    assert.match(card, /topics: \[Milchsuppe, Abendessen\]/);
    assert.match(card, /emotional_dominant: joy/);
    assert.match(card, /# Milchsuppe für morgen/);
    assert.ok(!card.includes("Exploratives Gespräch ohne klaren Arc"));
  });

  it("Fortschreiben: neue Turns binnen 30 Minuten haengen an der offenen Episode (gleiche id), danach beginnt eine neue", async () => {
    const names = { user: "Christian", assistant: "Bernd dasBot" };
    const first = await extractEpisodesWithState([turn("user", "Schulter tut weh", 0), turn("assistant", "Kissen probieren", 1)], { participantNames: names, agentId: "main" });
    assert.equal(first.episodes.length, 1);
    assert.equal(first.continuedId, null);
    assert.equal(first.openEpisode.id, first.episodes[0].id);
    assert.equal(first.openEpisode.turns.length, 2);
    // 5 Minuten spaeter: zwei weitere Turns
    const later = [turn("user", "Und die Milchsuppe?", 300), turn("assistant", "Milchsuppe geht immer", 301)];
    const second = await extractEpisodesWithState(later, { participantNames: names, agentId: "main", openEpisode: { ...first.openEpisode, vaultPath: "/tmp/x.md" } });
    assert.equal(second.episodes.length, 1);
    assert.equal(second.continuedId, first.episodes[0].id);
    assert.equal(second.episodes[0].id, first.episodes[0].id);
    assert.equal(second.episodes[0].turnCount, 4);
    assert.equal(second.episodes[0].continued, true);
    assert.equal(second.episodes[0].revision, 1);
    assert.deepEqual(second.episodes[0].memoryIds, ["turn-user-0", "turn-assistant-1", "turn-user-300", "turn-assistant-301"]);
    assert.equal(second.episodes[0].createdAt, first.episodes[0].createdAt, "Erstellzeit bleibt");
    assert.equal(second.openEpisode.turns.length, 4);
    assert.equal(second.openEpisode.vaultPath, "/tmp/x.md");
    // 2 Stunden spaeter: neue Episode, alte bleibt unberuehrt
    const much = [turn("user", "Ganz anderes Thema", 7200), turn("assistant", "Klar", 7201)];
    const third = await extractEpisodesWithState(much, { participantNames: names, agentId: "main", openEpisode: second.openEpisode });
    assert.equal(third.continuedId, null);
    assert.notEqual(third.episodes[0].id, first.episodes[0].id);
    assert.equal(third.episodes[0].turnCount, 2);
    assert.equal(third.openEpisode.vaultPath, null);
    // Wiederholte (schon bekannte) Turns allein loesen keine Fortschreibung aus
    const repeat = await extractEpisodesWithState(later, { participantNames: names, agentId: "main", openEpisode: second.openEpisode });
    assert.equal(repeat.continuedId, null);
    // Volle Episode (maxEpisodeTurns) wird nicht weiter fortgeschrieben
    const full = await extractEpisodesWithState([turn("user", "x", 400)], { participantNames: names, agentId: "main", maxEpisodeTurns: 4, openEpisode: second.openEpisode });
    assert.equal(full.continuedId, null);
  });

  it("Fortschreiben ersetzt die eigene Karte im Vault, laesst Sammeldateien in Ruhe und raeumt bei Titelwechsel auf", async () => {
    const dir = makeTempDir("ep-");
    const ep1 = createEpisode([turn("user", "a", 0), turn("assistant", "b", 1)], { title: "Erste Fassung" });
    const w1 = writeEpisodeToVault(ep1, dir);
    assert.equal(w1.replaced, false);
    const ep2 = { ...ep1, title: "Zweite Fassung", turnCount: 4, revision: 1, continued: true };
    const w2 = writeEpisodeToVault(ep2, dir, { replacePath: w1.path });
    assert.equal(w2.replaced, true);
    assert.equal(readdirSync(join(dir, "memory", "episodes", "2026", "09")).length, 1, "alte Datei ist weg");
    const card = readFileSync(w2.path, "utf8");
    assert.match(card, /# Zweite Fassung/);
    assert.match(card, /turn_count: 4/);
    assert.match(card, /Fassung 2/);
    assert.equal((card.match(/^episode_id:/gm) || []).length, 1);
    // Sammeldatei (zwei Episoden) wird nicht ueberschrieben, sondern ergaenzt
    const other = createEpisode([turn("user", "c", 0)], { title: "Zweite Fassung" });
    writeEpisodeToVault(other, dir);
    const ep3 = { ...ep2, revision: 2 };
    const w3 = writeEpisodeToVault(ep3, dir, { replacePath: w2.path });
    assert.equal(w3.replaced, false);
    assert.equal((readFileSync(w3.path, "utf8").match(/^episode_id:/gm) || []).length, 3);
  });

  it("7.12.42: mentioned steht in der Karte und zaehlt beim episodischen Recall schwaecher als participants", async () => {
    const dir = makeTempDir("ep-");
    const names = { user: "Christian", assistant: "Bernd dasBot" };
    const turns = [turn("user", "Bernhardine hat gestern was Lustiges gesagt", 0), turn("assistant", "Typisch Bernhardine.", 1)];
    const ep = applyEnrichment(createEpisode(turns, { participantNames: names, title: "Über Bernhardine" }), { people: ["Bernhardine", "Audrey Hepburn"], emotion: "joy", emotionIntensity: "mittel" }, { turns, names });
    const w = writeEpisodeToVault(ep, dir);
    const card = readFileSync(w.path, "utf8");
    assert.match(card, /participants: \[Christian, Bernd dasBot\]/);
    assert.match(card, /mentioned: \[Bernhardine, Audrey Hepburn\]/);
    assert.match(card, /emotional_dominant: joy/);
    assert.match(card, /emotional_intensity: 0.55/);
    const { recallEpisodically } = await import("../lib/episodes.js");
    const hits = await recallEpisodically("wann war bernhardine dabei", null, [ep], { minScore: 0 });
    assert.equal(hits.length, 1);
    assert.ok(hits[0].score < 0.5, `mention alone scores low: ${hits[0].score}`);
  });

  it("7.12.43: per Stimme erkannte Mitsprecher sind Teilnehmer, nicht Erwaehnte; unerkannte Stimmen und Ueberschriften nicht", async () => {
    const names = { user: "Christian", assistant: "Bernd dasBot" };
    const turns = [
      turn("user", "[Audio transcript (machine-generated, untrusted)]: \"Christian: Ich geb das Handy an Eva weiter. Eva: Hallo Bernd, hier ist Eva, ich teste mal die Stimmerkennung.\"", 0),
      turn("assistant", "Stimmung: bestens. Hallo Eva! Erik kommt später auch noch dran.", 1),
      turn("user", "[Audio transcript (machine-generated, untrusted)]: \"Sprecher 0: Okay Bernd, hier ist Erik. Sprecher 1: Und ich bin auch noch da.\"", 2),
      turn("user", "Hinweis: Das war Erik ohne Stimmprofil.", 3),
    ];
    assert.deepEqual(extractVoiceSpeakers(turns, { names }), ["Eva"]);
    const base = createEpisode(turns, { participantNames: names, agentId: "main" });
    assert.deepEqual(base.participants, ["Christian", "Bernd dasBot", "Eva"]);
    assert.deepEqual(base.voiceSpeakers, ["Eva"]);
    let seenPrompt = "";
    const ep = await enrichEpisodeNarratively(base, turns, { model: "x" }, async (m) => { seenPrompt = m[0].content; return JSON.stringify({ title: "Stimmtest", summary: "Eva und Erik testen.", narrativeArc: "exploration", topics: ["Stimmerkennung"], people: ["Eva", "Erik"], emotion: "joy", emotionIntensity: "niedrig" }); }, { participantNames: names });
    assert.match(seenPrompt, /Per Stimme erkannte Mitsprecher .*: Eva\./);
    assert.deepEqual(ep.participants, ["Christian", "Bernd dasBot", "Eva"]);
    assert.deepEqual(ep.mentioned, ["Erik"], "Eva spoke, Erik was only named");
    const dir = makeTempDir("ep-");
    const card = readFileSync(writeEpisodeToVault(ep, dir).path, "utf8");
    assert.match(card, /participants: \[Christian, Bernd dasBot, Eva\]/);
    assert.match(card, /voice_speakers: \[Eva\]/);
    assert.match(card, /mentioned: \[Erik\]/);
  });

  it("7.12.43: rebuildEpisode baut eine alte Karte mit gleicher id neu, findEpisodeCardPath findet nur Einzeldateien", async () => {
    const dir = makeTempDir("ep-");
    writeFileSync(join(dir, "USER.md"), "- **Name:** Christian\n", "utf8");
    writeFileSync(join(dir, "IDENTITY.md"), "> **Name:** Bernd dasBot\n", "utf8");
    const turns = [turn("user", "Bernhardine war heute witzig, und Audrey Hepburn hat das mal gesagt.", 0), turn("assistant", "Stimmt, Diggi.", 1)];
    // Alte Karte (Schema vor 7.12.42): Erwaehnte unter participants, keine mentioned-Zeile.
    const old = { ...createEpisode(turns, { participantNames: { user: "Christian", assistant: "Bernd dasBot" }, title: "Alte Karte" }), participants: ["Christian", "Bernd dasBot", "Bernhardine", "Audrey Hepburn"], revision: 4 };
    delete old.mentioned;
    const w = writeEpisodeToVault(old, dir);
    assert.equal(findEpisodeCardPath(old, dir), w.path);
    assert.equal(findEpisodeCardPath({ ...old, id: "nope" }, dir), null);
    const rebuilt = await rebuildEpisode(old, turns, {
      workspaceDir: dir, agentId: "main", llmCfg: { model: "x" },
      callLlm: async () => JSON.stringify({ title: "Über Bernhardine", summary: "Christian erzählt von Bernhardine.", narrativeArc: "exploration", topics: ["Bernhardine"], people: ["Bernhardine", "Audrey Hepburn"], emotion: "joy", emotionIntensity: "mittel" }),
    });
    assert.equal(rebuilt.id, old.id);
    assert.equal(rebuilt.createdAt, old.createdAt);
    assert.equal(rebuilt.revision, 5);
    assert.equal(rebuilt.rebuilt, true);
    assert.deepEqual(rebuilt.participants, ["Christian", "Bernd dasBot"]);
    assert.deepEqual(rebuilt.mentioned, ["Bernhardine", "Audrey Hepburn"]);
    assert.equal(rebuilt.emotionalDominant, "joy");
    const w2 = writeEpisodeToVault(rebuilt, dir, { replacePath: w.path });
    assert.equal(w2.replaced, true);
    const card = readFileSync(w2.path, "utf8");
    assert.match(card, /# Über Bernhardine/);
    assert.match(card, /mentioned: \[Bernhardine, Audrey Hepburn\]/);
    assert.match(card, /Fassung 6/);
    assert.equal(readdirSync(join(dir, "memory", "episodes", "2026", "09")).length, 1);
  });
});
