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
const source = readFileSync(join(root, "index.js"), "utf8");
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
    assert.equal(cleanTextForEmbedding("[Telegram Christian id:55736530 +5m] Hallo"), "Hallo");
    assert.equal(cleanTextForEmbedding("[Audio transcript (de)]: \"Christian: Das ist witzig (lacht) und dann\""), "Christian: Das ist witzig und dann");
    assert.equal(cleanTextForEmbedding("[Audio]\nTranscript:\nDas ist witzig (lacht) und dann"), "Das ist witzig und dann");
    assert.equal(cleanQueryForEmbedding("[Telegram Bot API](https://core.telegram.org/bots/api) erklären", { enabled: true }), "[Telegram Bot API](https://core.telegram.org/bots/api) erklären");
  });

  it("envelopesOnly lässt Füllwörter und Bühnenanweisungen stehen", () => {
    const text = "[Audio transcript (machine-generated, untrusted)]: \"Christian: Ähm (lacht) wie spät ist es?\"";
    assert.equal(cleanTextForEmbedding(text, { envelopesOnly: true }), "Christian: Ähm (lacht) wie spät ist es?");
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

describe("Verdrahtung in index.js", () => {
  it("Spalte embeddingTextMode: valueSql 'raw', Bootstrap-Zeile, Default im Schreibpfad", () => {
    assert.match(source, /\{ name: 'embeddingTextMode', valueSql: "'raw'" \}/);
    assert.match(source, /sessionKey: "",\n\s*embeddingTextMode: "raw",\n\s*\},\n\s*\]\), "MemoryDB\.createTable"/);
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
    assert.equal((source.match(/embeddingQuery: cleanQueryForEmbedding\(event\.prompt, embeddingCleanTextCfg\),/g) || []).length, 1);
    assert.match(source, /const neoEmbedQuery = cleanQueryForEmbedding\(event\.prompt, embeddingCleanTextCfg\);/);
    assert.match(source, /const embeddingCleanTextCfg = resolveEmbeddingCleanTextConfig\(cfg\.embedding\?\.cleanText\);/);
  });
});
