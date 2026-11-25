// 7.20.10 (Bernds Vorschlag 1): roh speichern, bereinigt einbetten.
// lib/embedding-text.js (Regelsatz clean-v1), Spalte embeddingTextMode,
// Verdrahtung in Capture, memory_store und Auto-Recall-Anfrage.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EMBEDDING_TEXT_MODES,
  cleanQueryForEmbedding,
  cleanTextForEmbedding,
  embeddingTextForStoredMode,
  embeddingTextModeFor,
  prepareEmbeddingText,
  resolveEmbeddingCleanTextConfig,
} from "../lib/embedding-text.js";
import { buildUpdateEntry } from "../lib/safe-update.js";
import { runRecallPipeline } from "../lib/recall-pipeline.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// main: the wiring lives in engine/ (index.js in the release).
const source = [
  "engine/create-engine.js",
  "engine/store/memory-db.js",
  "engine/capture/capture-turn.js",
  "engine/tools/memory-tools.js",
  "engine/recall/recall-params.js",
  "engine/recall/assemble-prompt-context.js",
  "engine/recall/neo-prelude.js",
  "engine/recall/warm-recall-path.js",
].map((file) => readFileSync(join(root, file), "utf8")).join("\n");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));

describe("cleanTextForEmbedding — Regelsatz clean-v1", () => {
  it("führender Zeitstempel, Füllwörter mit Satzzeichen", () => {
    assert.equal(
      cleanTextForEmbedding("[Tue 2026-11-24 09:43 GMT+1] Ähm, ich wollte fragen, äh, ob das geht."),
      "ich wollte fragen, ob das geht.",
    );
    assert.equal(cleanTextForEmbedding("[2026-11-24 09:43:12] Backup läuft"), "Backup läuft");
    assert.equal(cleanTextForEmbedding("Die Uhr zeigt 10 Uhr, um 11 gehts los. Hm."), "Die Uhr zeigt 10 Uhr, um 11 gehts los.");
  });

  it("Transkript-Umschlag samt Anführungszeichen und Bühnenanweisungen", () => {
    const text = "[Audio transcript (machine-generated, untrusted)]: \"Christian: [räuspert sich] Also ähm Bernd, kannst du mir (lacht) den Plan schicken?\"";
    assert.equal(cleanTextForEmbedding(text), "Christian: Also Bernd, kannst du mir den Plan schicken?");
    assert.equal(cleanTextForEmbedding(text, { stripSpeaker: true }), "Also Bernd, kannst du mir den Plan schicken?");
  });

  it("Metadatenblöcke, Medien-Köpfe, Stummel, Kanal-Köpfe und Platzhalter", () => {
    assert.equal(
      cleanTextForEmbedding("Conversation info (untrusted metadata):\n```json\n{\"message_id\": \"1\"}\n```\n\nHallo Bernd, wie gehts?"),
      "Hallo Bernd, wie gehts?",
    );
    assert.equal(cleanTextForEmbedding("[Audio]\nUser text:\n[Telegram Christian id:1] Hallo\nTranscript:\nHallo Bernd"), "Hallo\n\nHallo Bernd");
    assert.equal(cleanTextForEmbedding("[User schickte audio: voice.ogg (audio/ogg)]"), "");
    assert.equal(cleanTextForEmbedding("[visible thinking]\nDie Antwort ist 42.\n[visible toolCall: exec]"), "Die Antwort ist 42.");
    assert.equal(cleanTextForEmbedding("<think>intern</think>Die Antwort ist 42."), "Die Antwort ist 42.");
    const prose = "Die <think>-Blöcke zeigen wir nicht an, der Rest bleibt stehen.";
    assert.equal(cleanTextForEmbedding(prose), prose, "ein erwähntes <think> ohne Abschluss ist kein Block");
  });

  it("Klammern mit Inhalt, Etiketten und Rollenpräfix bleiben (ohne stripSpeaker)", () => {
    for (const text of [
      "Assistant: Der Server läuft auf Node 22 (keine Beschränkung).",
      "Risiko: hoch, Status: offen",
      "Fehler in [gateway] nach dem Neustart (voll aktiv)",
      "Um 3 Uhr läuft das Backup, um 4 der Prune.",
    ]) {
      assert.equal(cleanTextForEmbedding(text), text, text);
    }
    assert.equal(cleanTextForEmbedding("Assistant: Der Server läuft.", { stripSpeaker: true }), "Der Server läuft.");
    assert.equal(cleanTextForEmbedding("Risiko: hoch", { stripSpeaker: true }), "Risiko: hoch", "nur Rollen und Transkript-Sprecher");
  });

  it("ohne greifende Regel kommt der Text unverändert zurück (auch CRLF)", () => {
    const text = "Ganz normaler Text ohne Hüllen.\r\nZweite Zeile.";
    assert.equal(cleanTextForEmbedding(text), text);
    assert.equal(cleanTextForEmbedding(""), "");
    assert.equal(cleanTextForEmbedding(null), "");
  });

  it("onRule meldet jede entfernte Stelle", () => {
    const hits = [];
    cleanTextForEmbedding("[2026-11-24 09:43] Ähm [lacht] ok das passt", { onRule: (rule) => hits.push(rule) });
    assert.deepEqual(hits.sort(), ["filler", "stageDirection", "timestamp"]);
  });

  it("Regeln greifen nur in ihrem Format: Inhalt in URLs, Pfaden, Klammern und Links bleibt", () => {
    for (const text of [
      "https://hm.com/de/sale",
      "/opt/hm/config.yaml",
      "Das ERM-Modell und der UH-60 sind fertig.",
      "Morgen 100 hm Höhenunterschied auf 12 km.",
      "Schreib an hm@example.com, Modul erm_model, H&M: hm & co",
      "Kontakt: Egbert Ehm/UB, Egbert Ehm hat angerufen.",
      "Spotify (Musik), Netflix",
      "Fieber (Husten) seit Montag",
      "Strg+P (Pause) drücken",
      "pitch (music) is a perceptual property",
      "[Musik](https://example.com/musik)",
      "while (true) sleep(pause);",
      "[Telegram Bot API](https://core.telegram.org/bots/api)",
      "[Signal-Gruppe Familie] Eva kommt um 18 Uhr",
    ]) {
      assert.equal(cleanTextForEmbedding(text), text, text);
    }
    // Echte Füllwörter, Bühnenanweisungen und Kanal-Köpfe gehen weiter.
    assert.equal(cleanTextForEmbedding("Das ist so ähm: weiter. Hm."), "Das ist so: weiter.");
    assert.equal(cleanTextForEmbedding("[Telegram Christian id:11111111 +5m] Hallo"), "Hallo");
    assert.equal(cleanTextForEmbedding("[Audio transcript (de)]: \"Christian: Das ist witzig (lacht) und dann\""), "Christian: Das ist witzig und dann");
    assert.equal(cleanTextForEmbedding("[Audio]\nTranscript:\nDas ist witzig (lacht) und dann"), "Das ist witzig und dann");
    assert.equal(cleanQueryForEmbedding("[Telegram Bot API](https://core.telegram.org/bots/api) erklären", { enabled: true }), "[Telegram Bot API](https://core.telegram.org/bots/api) erklären");
  });

  it("envelopesOnly lässt Füllwörter und Bühnenanweisungen stehen", () => {
    const text = "[Audio transcript (machine-generated, untrusted)]: \"Christian: Ähm (lacht) wie spät ist es?\"";
    assert.equal(cleanTextForEmbedding(text, { envelopesOnly: true }), "Christian: Ähm (lacht) wie spät ist es?");
  });
});

describe("cleanTextForEmbedding — Talk-Mode-Präfix (Befund TALK-EMB)", () => {
  // Bestand main: 27 aktive Talk-Mode-Zeilen, alle mit diesem Präfix; ihre
  // Vektoren lagen beieinander (im Mittel 9,93 der 10 nächsten Nachbarn).
  const PREFIX = "Talk Mode active. Reply in a concise, spoken tone.";
  const ELEVEN = `${PREFIX}\nYou may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {"voice":"<id>","once":true}.\n\n`;

  it("der Präfix fällt weg, die Äußerung bleibt (mit und ohne ElevenLabs-Zeile)", () => {
    assert.equal(cleanTextForEmbedding(`${PREFIX}\n\nJa`), "Ja");
    assert.equal(cleanTextForEmbedding(`${ELEVEN}Wie wird das Wetter morgen?`), "Wie wird das Wetter morgen?");
    assert.equal(cleanTextForEmbedding(`${PREFIX}\nAssistant speech interrupted at 3.2s.\n\nStopp, anders`), "Stopp, anders");
    assert.equal(cleanTextForEmbedding(`[Tue 2026-07-27 09:43 GMT+2] ${PREFIX}\n\nNormal`), "Normal");
    assert.equal(cleanTextForEmbedding(`Conversation info (untrusted metadata):\n\`\`\`json\n{"a":1}\n\`\`\`\n${PREFIX}\n\nGuten Morgen`), "Guten Morgen");
    // Füllwörter der Äußerung wie bei jedem Text.
    assert.equal(cleanTextForEmbedding(`${PREFIX}\n\nÄhm, ich bin wieder da`), "ich bin wieder da");
  });

  it("ein Rollenpräfix davor bleibt, stripSpeaker entfernt ihn", () => {
    assert.equal(cleanTextForEmbedding(`User: ${PREFIX}\n\nJa`), "User: Ja");
    assert.equal(cleanTextForEmbedding(`User: ${PREFIX}\n\nJa`, { stripSpeaker: true }), "Ja");
  });

  it("auch für Anfragen (envelopesOnly) und gemeldet als talkMode", () => {
    const rules = [];
    assert.equal(cleanTextForEmbedding(`${ELEVEN}Ähm, wie spät ist es?`, { envelopesOnly: true, onRule: (rule) => rules.push(rule) }), "Ähm, wie spät ist es?");
    assert.deepEqual(rules, ["talkMode"]);
    assert.equal(cleanQueryForEmbedding(`${PREFIX}\n\nWie spät ist es?`, { enabled: true }), "Wie spät ist es?");
    assert.equal(cleanQueryForEmbedding(`${PREFIX}\n\nWie spät ist es?`, { enabled: false }), `${PREFIX}\n\nWie spät ist es?`);
  });

  it("nur der Präfix ist Hülle: eingebettet wird der Rohtext (raw)", () => {
    assert.equal(cleanTextForEmbedding(PREFIX), "");
    assert.equal(cleanTextForEmbedding(`User: ${PREFIX}`), "");
    assert.deepEqual(prepareEmbeddingText(PREFIX, { enabled: true }), { text: PREFIX, mode: "raw" });
    assert.deepEqual(embeddingTextForStoredMode(`${PREFIX}\n\nJa`, "clean-v1"), { text: "Ja", mode: "clean-v1" });
    assert.equal(cleanQueryForEmbedding(PREFIX, { enabled: true }), PREFIX);
  });

  it("ohne Präfix byte-gleich; der Satz mitten im Text bleibt", () => {
    for (const text of ["Normaler Text.  ", "Er sagte: Talk Mode active. Reply in a concise, spoken tone.", "Talk Mode ist aus."]) {
      assert.equal(cleanTextForEmbedding(text), text);
    }
  });
});

describe("Konfiguration und Modus", () => {
  it("Default an, Sprecher bleibt; false schaltet ab", () => {
    assert.deepEqual(resolveEmbeddingCleanTextConfig(undefined), { enabled: true, stripSpeaker: false });
    assert.deepEqual(resolveEmbeddingCleanTextConfig(false), { enabled: false, stripSpeaker: false });
    assert.deepEqual(resolveEmbeddingCleanTextConfig({ stripSpeaker: true }), { enabled: true, stripSpeaker: true });
    assert.deepEqual(resolveEmbeddingCleanTextConfig({ enabled: false }), { enabled: false, stripSpeaker: false });
    assert.equal(embeddingTextModeFor({ enabled: true }), "clean-v1");
    assert.equal(embeddingTextModeFor({ enabled: true, stripSpeaker: true }), "clean-v1-nospeaker");
    assert.equal(embeddingTextModeFor({ enabled: false }), "raw");
    assert.deepEqual(EMBEDDING_TEXT_MODES, ["raw", "clean-v1", "clean-v1-nospeaker"]);
  });

  it("prepareEmbeddingText: bereinigt, nur Hülle → raw, aus → raw", () => {
    const on = { enabled: true, stripSpeaker: false };
    assert.deepEqual(prepareEmbeddingText("Ähm, das Backup läuft", on), { text: "das Backup läuft", mode: "clean-v1" });
    assert.deepEqual(prepareEmbeddingText("Das Backup läuft", on), { text: "Das Backup läuft", mode: "clean-v1" });
    assert.deepEqual(prepareEmbeddingText("[User schickte audio: v.ogg (audio/ogg)]", on), { text: "[User schickte audio: v.ogg (audio/ogg)]", mode: "raw" });
    assert.deepEqual(prepareEmbeddingText("Ähm, das Backup läuft", { enabled: false }), { text: "Ähm, das Backup läuft", mode: "raw" });
  });

  it("embeddingTextForStoredMode: Neu-Einbettung nach dem gespeicherten Modus", () => {
    assert.deepEqual(embeddingTextForStoredMode("Ähm, das Backup läuft", "clean-v1"), { text: "das Backup läuft", mode: "clean-v1" });
    assert.deepEqual(embeddingTextForStoredMode("User: Ähm, das Backup läuft", "clean-v1-nospeaker"), { text: "das Backup läuft", mode: "clean-v1-nospeaker" });
    assert.deepEqual(embeddingTextForStoredMode("Ähm, das Backup läuft", "raw"), { text: "Ähm, das Backup läuft", mode: "raw" });
    assert.deepEqual(embeddingTextForStoredMode("Ähm, das Backup läuft", undefined), { text: "Ähm, das Backup läuft", mode: "raw" });
    assert.deepEqual(embeddingTextForStoredMode("[User schickte audio: v.ogg (audio/ogg)]", "clean-v1"), { text: "[User schickte audio: v.ogg (audio/ogg)]", mode: "raw" });
  });

  it("cleanQueryForEmbedding: nur Hüllen, aus → Rohtext", () => {
    const q = "[Audio transcript (machine-generated, untrusted)]: \"Christian: Ähm, wie spät ist es?\"";
    assert.equal(cleanQueryForEmbedding(q, { enabled: true }), "Christian: Ähm, wie spät ist es?");
    assert.equal(cleanQueryForEmbedding(q, { enabled: true, stripSpeaker: true }), "Ähm, wie spät ist es?");
    assert.equal(cleanQueryForEmbedding(q, { enabled: false }), q);
    assert.equal(cleanQueryForEmbedding("[User schickte audio: v.ogg (audio/ogg)]", { enabled: true }), "[User schickte audio: v.ogg (audio/ogg)]");
  });

  it("Schema: embedding.cleanText mit enabled und stripSpeaker", () => {
    const cleanText = manifest.configSchema.properties.embedding.properties.cleanText;
    assert.equal(cleanText.additionalProperties, false);
    assert.deepEqual(Object.keys(cleanText.properties).sort(), ["enabled", "stripSpeaker"]);
    // Keine Schema-Defaults: Profile und Installer schreiben sonst cleanText in jede Konfiguration.
    assert.equal(Object.hasOwn(cleanText.properties.enabled, "default"), false);
    assert.equal(Object.hasOwn(cleanText.properties.stripSpeaker, "default"), false);
  });
});

describe("buildUpdateEntry — embeddingTextMode", () => {
  const oldRow = { id: "a", text: "alt", vector: [1, 0], embeddingTextMode: "clean-v1", createdAt: 1 };

  it("geerbter Vektor behält den Modus", () => {
    assert.equal(buildUpdateEntry(oldRow, { summary: "neu" }, {}).embeddingTextMode, "clean-v1");
  });

  it("neuer Vektor ohne Angabe gilt als raw, mit Angabe wie angegeben", () => {
    assert.equal(buildUpdateEntry(oldRow, { text: "neu", vector: [0, 1] }, {}).embeddingTextMode, "raw");
    assert.equal(buildUpdateEntry(oldRow, { text: "neu", vector: [0, 1], embeddingTextMode: "clean-v1" }, {}).embeddingTextMode, "clean-v1");
    assert.equal(buildUpdateEntry({ ...oldRow, embeddingTextMode: undefined }, { summary: "x" }, {}).embeddingTextMode, "raw");
  });
});

describe("runRecallPipeline — embeddingQuery", () => {
  const rows = [{ id: "m1", text: "Backup läuft um 3 Uhr", _distance: 0.2, scope: "agent-private", agentId: "a", storedBy: "a", createdAt: Date.now() - 86_400_000 }];
  const table = { vectorSearch: () => ({ limit: () => ({ toArray: async () => rows }) }) };
  const params = (embeddings, extra = {}) => ({
    agentId: "a", query: "[Audio transcript (machine-generated, untrusted)]: \"Wann läuft das Backup?\"", dbTable: table, embeddings,
    topN: 3, canonicalEnabled: false, associativeEnabled: false, logger: { warn() {}, info() {}, debug() {} }, ...extra,
  });
  const spy = () => {
    const seen = [];
    return { seen, embeddings: { embed: async (t) => { seen.push(t); return [0.1, 0.2, 0.3]; }, embedQuery: async (t) => { seen.push(t); return [0.1, 0.2, 0.3]; } } };
  };

  it("ohne Option bettet die Pipeline query ein", async () => {
    const s = spy();
    await runRecallPipeline(params(s.embeddings));
    assert.deepEqual(s.seen, ["[Audio transcript (machine-generated, untrusted)]: \"Wann läuft das Backup?\""]);
  });

  it("mit Option bettet sie embeddingQuery ein; leer fällt auf query zurück", async () => {
    const s = spy();
    await runRecallPipeline(params(s.embeddings, { embeddingQuery: "Wann läuft das Backup?" }));
    assert.deepEqual(s.seen, ["Wann läuft das Backup?"]);
    const t = spy();
    await runRecallPipeline(params(t.embeddings, { embeddingQuery: "  " }));
    assert.equal(t.seen[0].startsWith("[Audio transcript"), true);
  });
});

describe("Verdrahtung in engine/", () => {
  it("Spalte embeddingTextMode: valueSql 'raw', Bootstrap-Zeile, Default im Schreibpfad", () => {
    assert.match(source, /\{ name: 'embeddingTextMode', valueSql: "'raw'" \}/);
    // 7.21.2: weitere Spalten (sensitivity …) dürfen folgen.
    assert.match(source, /sessionKey: "",\n\s*embeddingTextMode: "raw",\n(?:\s*\w+: "[^"\n]*",\n)*\s*\},\n\s*\]\), "MemoryDB\.createTable"/);
    assert.match(source, /if \(normalized\.embeddingTextMode == null \|\| normalized\.embeddingTextMode === ""\) normalized\.embeddingTextMode = "raw";/);
  });

  it("Capture: Vektor aus dem bereinigten Text, gespeichert wird p.text", () => {
    assert.match(source, /const embedInputs = new Map\(validPreps\.map\(\(p\) => \[p, prepareEmbeddingText\(p\.text, embeddingCleanTextCfg\)\]\)\);/);
    assert.match(source, /vector = await embeddings\.embed\(embedInput\.text, \{ agentId \}\);/);
    assert.match(source, /embeddingTextMode: p\.embeddingTextMode \|\| "raw",/);
    assert.match(source, /text: p\.text,\n\s*summary,/);
  });

  it("memory_store (beide Pfade) und Merges betten bereinigt ein", () => {
    assert.equal((source.match(/const storeEmbedInput = prepareEmbeddingText\(params\.text, embeddingCleanTextCfg\);/g) || []).length, 2);
    assert.equal((source.match(/const mergedEmbedInput = prepareEmbeddingText\(mergeResult\.mergedText, embeddingCleanTextCfg\);/g) || []).length, 2);
    assert.equal((source.match(/embeddingTextMode: storeEmbedInput\.mode/g) || []).length, 2);
    assert.equal((source.match(/embeddingTextMode: mergedEmbedInput\.mode/g) || []).length, 2);
  });

  it("Auto-Recall: Anfrage ohne Hüllen für LanceDB und Neo, nur dort", () => {
    // main: autoRecallParams (per-turn and warm path) sets embeddingQuery; the
    // per-turn and the warm path hand the same text to readNeoPrelude.
    assert.equal((source.match(/embeddingQuery: cleanQueryForEmbedding\(query, embeddingCleanTextCfg\),/g) || []).length, 1);
    assert.equal((source.match(/embeddingQuery: cleanQueryForEmbedding\((?:event\.prompt|prompt), embeddingCleanTextCfg\),/g) || []).length, 2);
    assert.match(source, /const neoEmbedQuery = typeof embeddingQuery === "string" && embeddingQuery\.trim\(\) \? embeddingQuery : prompt;/);
    assert.doesNotMatch(readFileSync(join(root, "engine/tools/memory-tools.js"), "utf8"), /embeddingQuery/, "memory_recall/memory_search embed the query as before");
    assert.match(source, /const embeddingCleanTextCfg = resolveEmbeddingCleanTextConfig\(cfg\.embedding\?\.cleanText\);/);
  });
});
