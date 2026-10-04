// 7.18.18: Jev entscheidet je Nachricht, ob die Aufteilung sinnvoll ist.
// Ein gespeichertes Rezept war in 14 Zeilen wie "1 Prise Salz" zerlegt worden.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JEV_ENDPOINT, createJevChunkDecider, storageForJevAnswer } from "../lib/jev-chunk-decider.js";
import { expandForCaptureDecided } from "../lib/memory-chunking.js";
import { activeCaptureChunkingId, CAPTURE_CHUNKING_CHOICES } from "../lib/setup/control-ui-write.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";

const RECIPE = [
  "Ammonplaetzchen DDR 1959",
  "- 250 g Mehl\n- 125 g weiche Butter\n- 125 g Zucker\n- 2 Eier\n- 1 Prise Salz",
  "- 7 g Hirschhornsalz\n- 2 EL kaltes Wasser",
  "1. Butter, Zucker, Salz cremig schlagen, Eier einzeln unterruehren, Mehl unterheben.\n2. Hirschhornsalz in den 2 EL kaltem Wasser aufloesen und zum Teig geben.\n3. Haeufchen auf ein gefettetes Blech setzen.\n4. 180 Grad, 12 bis 15 Minuten.\n5. Auskuehlen lassen, Unterseite glasieren.",
].join("\n\n");

function fakeFetch(answer, { status = 200, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    return { ok: status >= 200 && status < 300, status, json: async () => ({ answers: { structure: answer } }) };
  };
}

describe("storageForJevAnswer", () => {
  it("maps confident verdicts and keeps both when unsure", () => {
    assert.equal(storageForJevAnswer({ choice: "coherent", confidence: 1 }), "whole");
    assert.equal(storageForJevAnswer({ choice: "independent", confidence: 0.95 }), "parts");
    assert.equal(storageForJevAnswer({ choice: "mixed", confidence: 1 }), "both");
    assert.equal(storageForJevAnswer({ choice: "coherent", confidence: 0.6 }), "both");
    assert.equal(storageForJevAnswer(null), "both");
    assert.equal(storageForJevAnswer({ choice: "independent", confidence: 0.7 }, 0.6), "parts");
  });
});

describe("createJevChunkDecider", () => {
  it("is off without a key", () => {
    assert.equal(createJevChunkDecider({ apiKey: "" }), null);
  });

  it("asks one choice question with bearer auth and the message as state", async () => {
    const calls = [];
    const decide = createJevChunkDecider({ apiKey: "k-test", fetchImpl: fakeFetch({ choice: "coherent", confidence: 1 }, { calls }) });
    assert.deepEqual(await decide(RECIPE), { storage: "whole", choice: "coherent", confidence: 1 });
    assert.equal(calls[0].url, JEV_ENDPOINT);
    assert.equal(calls[0].init.headers.Authorization, "Bearer k-test");
    assert.equal(calls[0].init.body.model, "jev-latest");
    assert.equal(calls[0].init.body.state, RECIPE);
    assert.equal(calls[0].init.body.questions.structure.type, "choice");
  });

  it("falls back to both on HTTP errors and exceptions, without logging the text", async () => {
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args.join(" ")) };
    const failing = createJevChunkDecider({ apiKey: "k", fetchImpl: fakeFetch(null, { status: 429 }), logger });
    assert.deepEqual(await failing(RECIPE), { storage: "both", reason: "http_429" });
    const throwing = createJevChunkDecider({ apiKey: "k", fetchImpl: async () => { throw new Error("socket hang up"); }, logger });
    assert.equal((await throwing(RECIPE)).storage, "both");
    assert.ok(!warnings.join("\n").includes("Hirschhornsalz"));
  });
});

describe("expandForCaptureDecided", () => {
  const prep = { it: { role: "assistant" }, text: RECIPE, ok: true };
  let n = 0;
  const makeGroupId = () => `g${++n}`;

  it("keeps a coherent message whole", async () => {
    const plan = await expandForCaptureDecided([prep], { makeGroupId, decide: async () => ({ storage: "whole" }) });
    assert.deepEqual(plan.items.map((i) => i.chunkGroupId ?? ""), [""]);
    assert.deepEqual(plan.decisions, { whole: 1, parts: 0, both: 0 });
  });

  it("stores only parts for independent points and whole plus parts when unsure", async () => {
    const parts = await expandForCaptureDecided([prep], { makeGroupId, decide: async () => ({ storage: "parts" }) });
    assert.ok(parts.items.length >= 2 && parts.items.every((i) => i.chunkGroupId));
    const both = await expandForCaptureDecided([prep], { makeGroupId, decide: async () => ({ storage: "both" }) });
    assert.equal(both.items.filter((i) => !i.chunkGroupId).length, 1);
    assert.equal(both.items.length, parts.items.length + 1);
  });

  it("treats a throwing decider as unsure", async () => {
    const plan = await expandForCaptureDecided([prep], { makeGroupId, decide: async () => { throw new Error("down"); } });
    assert.deepEqual(plan.decisions, { whole: 0, parts: 0, both: 1 });
  });

  it("does not ask for short messages that would not be split", async () => {
    let asked = 0;
    const plan = await expandForCaptureDecided([{ it: {}, text: "Kurze Notiz.", ok: true }], { decide: async () => { asked += 1; return { storage: "parts" }; } });
    assert.equal(asked, 0);
    assert.equal(plan.items.length, 1);
  });
});

describe("dashboard", () => {
  it("offers Automatic (Jev) and reports key presence without the value", () => {
    assert.ok(CAPTURE_CHUNKING_CHOICES.some((choice) => choice.id === "automatisch"));
    assert.equal(activeCaptureChunkingId({ captureChunkingMode: "automatisch" }), "automatisch");
    const withKey = buildControlPlaneProjection({ config: { captureChunkingMode: "automatisch" }, env: { TYPESAFE_API_KEY: "secret-value" } });
    assert.deepEqual(withKey.captureChunking, { mode: "automatisch", jevKey: true });
    assert.ok(!JSON.stringify(withKey).includes("secret-value"));
    const custom = buildControlPlaneProjection({ config: { captureChunkingMode: "automatisch", captureChunkingJev: { apiKeyEnv: "JEV_KEY" } }, env: {} });
    assert.equal(custom.captureChunking.jevKey, false);
  });
});
