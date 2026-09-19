import { describe, it } from "node:test";
import assert from "node:assert";
import {
  BATCH_SIZE,
  CONCURRENCY,
  DEFAULT_MODEL,
  buildBackfillRow,
  chunk,
  createEncodingCall,
  parseArgs,
} from "../scripts/importance-backfill.mjs";
import { AGENT_BAND_MIN } from "../lib/memory-dynamics.js";
import { IMPORTANCE_STATUS } from "../lib/importance-status.js";

const encoding = (importance, extra = {}) => ({
  ok: true,
  importance,
  emotion: { emotionalDominant: "neutral", emotionalIntensity: 0, ...extra },
  reason: "",
});

describe("backfill batching", () => {
  it("cuts rows into batches of the given size", () => {
    assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepStrictEqual(chunk([], 500), []);
  });

  it("never lowers an existing strength", () => {
    const row = { id: "x", memoryStrength: 0.9, halfLifeDays: 180, importance: 0.7 };
    const patched = buildBackfillRow(row, encoding(0.2), Date.now());
    assert.ok(patched.memoryStrength >= 0.9);
  });

  it("keeps the previous value for rollback", () => {
    const row = { id: "x", memoryStrength: 0.9, halfLifeDays: 180, importance: 0.7 };
    const patched = buildBackfillRow(row, encoding(0.2), Date.now());
    assert.strictEqual(JSON.parse(patched.updateEvidence).previousImportance, 0.7);
    assert.strictEqual(patched.updateSource, "importance-v2");
  });
});

describe("backfill row shape", () => {
  // mergeInsert schreibt die GANZE Zeile zurück. Was hier verlorengeht, ist in
  // der Datenbank weg — deshalb prüft dieser Test die Felder, die der Patch
  // gar nicht kennt, und die Vektorspalte, die LanceDB als iterierbares
  // Arrow-Objekt liefert (siehe toPlainRow in importance-phase1-reset.mjs).
  it("carries every untouched field and unpacks the vector", () => {
    const row = {
      id: "x",
      text: "Ein langer Erinnerungstext",
      importance: 0.7,
      memoryStrength: 0.5,
      vector: { *[Symbol.iterator]() { yield 0.25; yield -0.5; } },
      someLegacyColumn: "unberührt",
    };
    const patched = buildBackfillRow(row, encoding(0.3), Date.now());
    assert.strictEqual(patched.text, "Ein langer Erinnerungstext");
    assert.strictEqual(patched.someLegacyColumn, "unberührt");
    assert.ok(Array.isArray(patched.vector));
    assert.deepStrictEqual(patched.vector, [0.25, -0.5]);
  });

  it("marks the row final so a second run skips it", () => {
    const patched = buildBackfillRow({ id: "x", importance: 0.7 }, encoding(0.3), Date.now());
    assert.strictEqual(patched.importanceStatus, IMPORTANCE_STATUS.FINAL);
  });

  // Das Band 0,95–1,00 gehört der Entscheidung des Agenten. buildRefinePatch
  // fasst Importance und Halbwertszeit dort nicht an — der Backfill darf die
  // Ausnahme nicht aushebeln, indem er den alten Wert selbst überschreibt.
  it("leaves importance alone inside the agent band", () => {
    const row = { id: "x", importance: AGENT_BAND_MIN + 0.02, halfLifeDays: 36500 };
    const patched = buildBackfillRow(row, encoding(0.2), Date.now());
    assert.strictEqual(patched.importance, AGENT_BAND_MIN + 0.02);
  });

  it("refuses to build a row from a failed judgement", () => {
    assert.strictEqual(buildBackfillRow({ id: "x" }, { ok: false }, Date.now()), null);
  });
});

describe("kimi encoding call", () => {
  const okBody = (content, finish = "stop") => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content }, finish_reason: finish }] }),
  });

  it("sends the configured model and budget, and no temperature", async () => {
    const seen = [];
    const call = createEncodingCall({
      apiKey: "sk-test", model: "kimi-for-coding-highspeed", maxTokens: 1500,
      fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body), headers: init.headers }); return okBody("{}"); },
    });
    await call([{ role: "user", content: "x" }], {});
    assert.strictEqual(seen.length, 1);
    assert.match(seen[0].url, /api\.kimi\.com\/coding\/v1\/chat\/completions$/);
    assert.strictEqual(seen[0].body.model, "kimi-for-coding-highspeed");
    assert.strictEqual(seen[0].body.max_tokens, 1500);
    // Gemessen am 19.09.2026: die API lehnt jede andere Temperatur ab
    // ("invalid temperature: only 1 is allowed for this model"). Wir setzen
    // deshalb gar keine.
    assert.ok(!("temperature" in seen[0].body), "temperature darf nicht mitgeschickt werden");
    assert.strictEqual(seen[0].headers["User-Agent"], "gsd/2.77.0");
  });

  // Der teure Fehler ist der stumme: HTTP 200, plausibles JSON, keine
  // schließende Klammer. Statt die Zeile zu verlieren, wird der Aufruf einmal
  // mit größerem Budget wiederholt.
  it("retries once with a larger budget when the answer was cut off", async () => {
    const budgets = [];
    const call = createEncodingCall({
      apiKey: "sk-test", model: "m", maxTokens: 1500,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        budgets.push(body.max_tokens);
        return budgets.length === 1 ? okBody('{"importance": 0.', "length") : okBody('{"importance":0.4}');
      },
    });
    const answer = await call([{ role: "user", content: "x" }], {});
    assert.deepStrictEqual(budgets, [1500, 3000]);
    assert.strictEqual(answer, '{"importance":0.4}');
  });

  it("gives up after the retry instead of looping", async () => {
    let calls = 0;
    const call = createEncodingCall({
      apiKey: "sk-test", model: "m", maxTokens: 100,
      fetchImpl: async () => { calls += 1; return okBody("{", "length"); },
    });
    await call([{ role: "user", content: "x" }], {});
    assert.strictEqual(calls, 2);
  });

  it("returns empty on an http error so the row stays pending", async () => {
    const call = createEncodingCall({
      apiKey: "sk-test", model: "m", maxTokens: 100,
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => "rate limited" }),
    });
    assert.strictEqual(await call([{ role: "user", content: "x" }], {}), "");
  });

  // Ohne eigenen Zaehler sieht ein abgebrochener Lauf gleich aus, egal ob das
  // Modell Unsinn geantwortet hat oder die Route mit 429 dichtgemacht hat —
  // und genau daran haengt, ob die Breite 8 traegt.
  it("reports http errors separately from unusable answers", async () => {
    const seen = [];
    const call = createEncodingCall({
      apiKey: "sk-test", model: "m", maxTokens: 100,
      onHttpError: (status) => seen.push(status),
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => "rate limited" }),
    });
    await call([{ role: "user", content: "x" }], {});
    assert.deepStrictEqual(seen, [429]);
  });
});

describe("backfill arguments", () => {
  it("is a dry run unless --apply is given", () => {
    assert.strictEqual(parseArgs([]).apply, false);
    assert.strictEqual(parseArgs(["--apply"]).apply, true);
  });

  it("takes agents, limit, model and batch size", () => {
    const args = parseArgs(["main", "bernhardine", "--limit", "50", "--model", "k3", "--batch-size", "200"]);
    assert.deepStrictEqual(args.agents, ["main", "bernhardine"]);
    assert.strictEqual(args.limit, 50);
    assert.strictEqual(args.model, "k3");
    assert.strictEqual(args.batchSize, 200);
  });

  it("defaults to kimi highspeed and the plan's batching", () => {
    const args = parseArgs([]);
    assert.strictEqual(args.model, DEFAULT_MODEL);
    assert.strictEqual(DEFAULT_MODEL, "kimi-for-coding-highspeed");
    assert.strictEqual(args.batchSize, BATCH_SIZE);
    assert.strictEqual(BATCH_SIZE, 500);
    assert.strictEqual(CONCURRENCY, 8);
  });
});
