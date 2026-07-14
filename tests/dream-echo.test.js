import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  distillDreamEcho, appendDreamEcho, loadFreshDreamEcho, formatDreamEchoContext,
} from "../lib/dream-echo.js";

const T0 = 1750000000000;
const D = 86400000;

describe("distillDreamEcho", () => {
  it("nutzt das LLM, wenn konfiguriert", async () => {
    const callLlm = async () => JSON.stringify({ sentence: "Mir ging nochmal das Serverthema durch den Kopf.", topics: ["server"] });
    const echo = await distillDreamEcho({ narrative: "…", insights: [] }, { llmCfg: { model: "x" }, callLlm, now: T0 });
    assert.strictEqual(echo.sentence, "Mir ging nochmal das Serverthema durch den Kopf.");
    assert.deepStrictEqual(echo.topics, ["server"]);
    assert.strictEqual(echo.createdAt, T0);
  });

  it("Fallback auf ersten Insight, wenn LLM fehlt oder wirft", async () => {
    const echo = await distillDreamEcho({ narrative: "irrelevant", insights: ["das Backup-Problem"] }, { now: T0 });
    assert.match(echo.sentence, /Backup-Problem/);
  });

  it("null ohne Narrative und Insights", async () => {
    assert.strictEqual(await distillDreamEcho({ narrative: null, insights: [] }, { now: T0 }), null);
  });

  it("kürzt Sätze auf 200 Zeichen", async () => {
    const callLlm = async () => JSON.stringify({ sentence: "x".repeat(500), topics: [] });
    const echo = await distillDreamEcho({ narrative: "…" }, { llmCfg: { model: "x" }, callLlm, now: T0 });
    assert.ok(echo.sentence.length <= 200);
  });
});

describe("dream-echo store + format", () => {
  it("append + load: liefert das jüngste frische Echo", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-"));
    appendDreamEcho(dir, { sentence: "alt", topics: [], createdAt: T0 - 5 * D });
    appendDreamEcho(dir, { sentence: "frisch", topics: ["a"], createdAt: T0 - 1000 });
    const echo = loadFreshDreamEcho(dir, { now: T0 });
    assert.strictEqual(echo.sentence, "frisch");
  });

  it("zu alte Echos werden ignoriert", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-"));
    appendDreamEcho(dir, { sentence: "alt", topics: [], createdAt: T0 - 3 * D });
    assert.strictEqual(loadFreshDreamEcho(dir, { now: T0, maxAgeDays: 2 }), null);
  });

  it("Store bleibt auf 20 Zeilen begrenzt", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-"));
    for (let i = 0; i < 30; i++) appendDreamEcho(dir, { sentence: `s${i}`, topics: [], createdAt: T0 + i });
    const lines = readFileSync(join(dir, ".dream-echoes.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 20);
  });

  it("loadFreshDreamEcho fail-open bei kaputter Datei", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-"));
    writeFileSync(join(dir, ".dream-echoes.jsonl"), "{kaputt\n", "utf8");
    assert.strictEqual(loadFreshDreamEcho(dir, { now: T0 }), null);
  });

  it("formatDreamEchoContext: Block ≤400 Zeichen, enthält den Satz, null bei null", () => {
    const block = formatDreamEchoContext({ sentence: "Mir ging X durch den Kopf.", topics: [], createdAt: T0 });
    assert.ok(block.includes("Mir ging X durch den Kopf."));
    assert.ok(block.length <= 400);
    assert.match(block, /natürlich passt/);
    assert.strictEqual(formatDreamEchoContext(null), null);
  });
});
