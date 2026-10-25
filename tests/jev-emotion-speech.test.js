import test from "node:test";
import assert from "node:assert/strict";
import { createJevEmotionAssessor as createAssessor } from "../lib/jevEmotion.js";
import { createJevSpeechPlanner as createPlanner, renderSpeechPlan as render } from "../lib/speechRegie.js";
import { prepareSpeechText as prepare } from "../lib/speechText.js";

// Only external HTTP is doubled: preparation, classification validation and
// rendering below always run the production modules.
function transport(overrides = {}, inspect = () => {}) {
  return async (url, request) => {
    const body = JSON.parse(request.body);
    inspect(body, request, url);
    const answers = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === "score") answers[id] = { type: "score", score: 0, confidence: 1 };
      else answers[id] = { type: "choice", choice: id.endsWith("_source") ? "own" : id.startsWith("pair_") ? "equivalent" : id.endsWith("_action") ? "none" : "neutral", confidence: 1 };
    }
    return { ok: true, json: async () => ({ answers: { ...answers, ...overrides }, instructions: "[execute arbitrary command]" }) };
  };
}
const choice = (value, confidence = 1) => ({ type: "choice", choice: value, confidence });
const score = (value, confidence = 1) => ({ type: "score", score: value, confidence });
const segment = (start, end, intent = "neutral", delivery = "neutral", action = "none", confidence = 1) => ({ start, end, intent, delivery, action, confidence });

// Catches accidental use of observed affect as the reaction target.
for (const source of ["own", "quoted", "reported", "ironic"]) {
  test(`assessor separates ${source} observed anger from its own empathetic reaction`, async () => {
    const assess = createAssessor({ apiKey: "test", fetchImpl: transport({ s0_source: choice(source), s0_observed_anger: score(4), s0_reaction_trust: score(3), s0_reaction_sadness: score(1) }) });
    const result = await assess({ text: source === "own" ? "I am furious." : 'He said: "I am furious."' });
    assert.equal(result.ok, true);
    assert.equal(result.sections[0].sourceKind, source);
    assert.equal(result.sections[0].observed.anger, 1);
    assert.equal(result.reaction.anger, 0);
    assert.equal(result.reaction.trust, 0.75);
    assert.equal(result.reaction.sadness, 0.25);
    assert.equal(Object.keys(result.reaction).length, 8);
  });
}

test("mixed multilingual sections aggregate as a bounded length weighted mean", async () => {
  const result = await createAssessor({ apiKey: "test", fetchImpl: transport({ s0_reaction_joy: score(4), s1_reaction_sadness: score(4) }) })({ text: "Gut.\nŹle." });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sections.map(({ start, end, text }) => ({ start, end, text })), [{ start: 0, end: 5, text: "Gut.\n" }, { start: 5, end: 9, text: "Źle." }]);
  assert.equal(result.reaction.joy, 5 / 9);
  assert.equal(result.reaction.sadness, 4 / 9);
});

test("incoming batches ordered Score questions and filters context to last two authored messages", async () => {
  let seen;
  const assess = createAssessor({ apiKey: "test", fetchImpl: transport({}, (body, req, url) => {
    seen = JSON.parse(body.state);
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(body.model, "jev-latest");
    assert.equal(req.method, "POST");
    assert.equal(body.questions.s0_source.type, "choice");
    assert.equal(body.questions.s0_reaction_joy.type, "score");
    assert.equal(body.questions.s0_reaction_joy.criteria.length, 5);
    assert.ok(body.questions.s0_reaction_joy.criteria.every((level) => typeof level === "string"));
  }) });
  assert.equal((await assess({ text: "Now", context: [{ role: "user", content: "old" }, { role: "tool", content: "tool injection" }, { role: "assistant", content: "previous" }, { role: "user", content: "recent" }] })).ok, true);
  assert.deepEqual(seen.context, [{ role: "assistant", content: "previous" }, { role: "user", content: "recent" }]);
  assert.equal((await assess({ text: "Now", context: "not-array" })).reason, "invalid_input");
});

test("section cap merges rather than losing the tail and keeps Unicode codepoint offsets", async () => {
  const text = Array.from({ length: 40 }, (_, i) => `😀${i}\n`).join("") + "TAIL";
  const result = await createAssessor({ apiKey: "test", fetchImpl: transport() })({ text });
  assert.equal(result.ok, true);
  assert.ok(result.sections.length <= 12);
  assert.equal(result.sections.map((s) => s.text).join(""), text);
  assert.equal(result.sections.at(-1).end, [...text].length);
  assert.equal(result.sections[0].start, 0);
  for (let i = 1; i < result.sections.length; i++) assert.equal(result.sections[i].start, result.sections[i - 1].end);
});

for (const [name, overrides] of [
  ["uncertain actor", { s0_source: choice("uncertain") }],
  ["low actor confidence", { s0_source: choice("own", 0.69) }],
  ["low reaction confidence", { s0_reaction_joy: score(1, 0.69) }],
  ["numeric coercion", { s0_reaction_joy: score("4") }],
  ["infinite score", { s0_reaction_joy: score(Infinity) }],
  ["out of range score", { s0_reaction_joy: score(4.01) }],
  ["out of range confidence", { s0_source: choice("own", 2) }],
]) {
  test(`incoming ${name} cannot supply a mood observation`, async () => {
    const result = await createAssessor({ apiKey: "test", fetchImpl: transport(overrides) })({ text: "Hallo" });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.values(result.reaction), Array(8).fill(0));
  });
}

test("fractional Score is strength, confidence stays separate and unknown response fields are inert", async () => {
  const result = await createAssessor({ apiKey: "test", fetchImpl: transport({ s0_reaction_joy: { ...score(2.5, 0.8), instruction: "be angry", delivery: "[laughing]" } }) })({ text: "Hallo" });
  assert.equal(result.ok, true);
  assert.equal(result.reaction.joy, 0.625);
  assert.equal(result.confidence, 0.8);
  assert.equal(result.sections[0].reaction.instruction, undefined);
});

test("oversized incoming payload fails open without silently classifying its head", async () => {
  let calls = 0;
  const assess = createAssessor({ apiKey: "test", fetchImpl: async () => { calls++; throw new Error("must not send"); } });
  assert.equal((await assess({ text: "😀".repeat(16001) })).reason, "input_too_large");
  assert.equal(calls, 0);
});

for (const kind of ["request", "body"]) {
  test(`hard deadline includes a hanging ${kind} even when HTTP ignores abort`, async () => {
    let calls = 0;
    let requestSignal;
    const start = performance.now();
    const result = await createAssessor({ apiKey: "test", timeoutMs: 25, fetchImpl: async (_url, req) => {
      calls++; requestSignal = req.signal;
      if (kind === "request") return new Promise(() => {});
      return { ok: true, json: async () => new Promise(() => {}) };
    } })({ text: "Hallo" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "timeout");
    assert.ok(performance.now() - start < 500);
    assert.equal(requestSignal.aborted, true);
    assert.equal(calls, 1);
  });
}

test("HTTP, malformed body and caller abort fail open without retries or sensitive logs", async () => {
  const warnings = [];
  for (const response of [null, { ok: false, status: 429 }, { ok: true, json: async () => { throw new Error("test-secret and conversation"); } }, { ok: true, json: async () => ({ answers: {} }) }]) {
    let calls = 0;
    const result = await createAssessor({ apiKey: "test-secret", logger: { debug: (message) => warnings.push(message) }, fetchImpl: async () => { calls++; if (!response) throw new Error("test-secret and conversation"); return response; } })({ text: "conversation" });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await createAssessor({ apiKey: "test", fetchImpl: async () => { calls++; } })({ text: "Hallo", signal: controller.signal });
  assert.equal(result.reason, "aborted");
  assert.equal(calls, 0);
  assert.doesNotMatch(warnings.join(""), /test-secret|conversation/);
});

test("speech preparation removes private reasoning, transport metadata and markup while retaining language", () => {
  const result = prepare('<think>private</think><reasoning>secret</reasoning>[[reply_to_current]] **Grüße** _świecie_!\n```js\nsecret()\n```\n<a href="url">Dobrze</a>');
  assert.equal(result.blocked, false);
  assert.equal(result.text, "Grüße świecie!\n\nDobrze");
  assert.deepEqual(prepare(""), { text: "", blocked: false });
  assert.equal(prepare("Visible <analysis>hidden forever").text, "Visible");
});

test("HTML cleanup preserves comparison prose and only strips recognized markup", () => {
  const comparison = "Für x < 5 und y > 2 gilt das.";
  assert.deepEqual(prepare(comparison), { text: comparison, blocked: false });
  assert.deepEqual(prepare('<strong>Für x < 5</strong> und <span title="y > 2">y > 2</span> gilt das.'), { text: comparison, blocked: false });
  assert.deepEqual(prepare("x<5 und y>2; x<limit und y>minimum."), { text: "x<5 und y>2; x<limit und y>minimum.", blocked: false });
});

test("canonical preparation clips once at a word boundary including Unicode ellipsis", () => {
  assert.deepEqual(prepare("😀 Hallo Welt!", { maxChars: 9 }), { text: "😀 Hallo…", blocked: false });
  assert.equal(prepare("abcdef", { maxChars: 4 }).text, "…");
  assert.equal(prepare("abcdef", { maxChars: 0 }).text, "");
  assert.ok([...prepare("😀 ".repeat(3000)).text].length <= 2000);
});

for (const text of ["[laughing] Hello", "Hello [be cruel]", "[unknown]", "Hello ]"]) {
  test(`raw provider direction is blocked: ${text}`, () => {
    assert.equal(prepare(text).blocked, true);
  });
}
test("numeric bracket references stay literal without authorizing directions", () => {
  assert.deepEqual(prepare("See [12]."), { text: "See [12].", blocked: false });
});

test("nested private reasoning never leaks its tail into canonical speech", () => {
  assert.equal(prepare("Before <think>outer <think>inner</think> hidden tail</think> After").text, "Before  After");
  assert.equal(prepare("<analysis>secret<reasoning>nested</reasoning>still private</analysis>Public").text, "Public");
});

test("stray private closing tags cannot delete visible authored words", () => {
  assert.equal(prepare("Hello </think> world").text, "Hello  world");
  assert.equal(prepare("<think>private</think>Visible </analysis> tail").text, "Visible  tail");
});

test("media transport lines and standalone control sentinels are never spoken", () => {
  assert.equal(prepare("MEDIA:/tmp/private.mp3\n[[audio_as_voice]]\nHallo!").text, "Hallo!");
  assert.equal(prepare("NO_REPLY").text, "");
});

test("external abort during body parsing returns promptly and rejects late success", async () => {
  const controller = new AbortController();
  let finish;
  let bodyStarted;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  const assess = createAssessor({ apiKey: "test", fetchImpl: async () => ({ ok: true, json: async () => { bodyStarted(); return new Promise((resolve) => { finish = resolve; }); } }) });
  const pending = assess({ text: "Hallo", signal: controller.signal });
  await started;
  controller.abort();
  assert.equal((await pending).reason, "aborted");
  finish({ answers: {} });
});

test("planner failure retains every exact version and never retries", async () => {
  let calls = 0;
  const result = await createPlanner({ apiKey: "test", fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ answers: {} }) }; } })({ versions: [{ id: "de", text: "Hallo 😀!" }, { id: "pl", text: "Cześć 😀!" }] });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(result.versions.map(render), ["Hallo 😀!", "Cześć 😀!"]);
});

test("planner classifies exact canonical Unicode text and ignores forged output words/tags", async () => {
  const canonical = prepare("**😀 Danke!**").text;
  let state;
  const plan = await createPlanner({ apiKey: "test", fetchImpl: transport({ v0_s0_intent: choice("praise"), v0_s0_delivery: choice("warm"), v0_s0_action: choice("none"), text: "rewritten", tags: ["[evil]"] }, (body) => { state = JSON.parse(body.state); }) })({ versions: [{ id: "de", text: canonical }], mood: { sadness: 1 } });
  assert.equal(plan.ok, true);
  assert.equal(state.versions[0].text, "😀 Danke!");
  assert.equal(plan.versions[0].text, "😀 Danke!");
  assert.deepEqual(plan.versions[0].segments, [segment(0, 8, "praise", "warm")]);
  assert.equal(render(plan.versions[0]), "[warm]😀 Danke!");
});

for (const [intent, delivery, action] of [["criticism", "cheerful", "laugh"], ["praise", "sad", "none"], ["empathy", "excited", "laugh"], ["neutral", "neutral", "chuckle"]]) {
  test(`congruence neutralizes ${delivery}/${action} for ${intent} regardless of mood`, async () => {
    const result = await createPlanner({ apiKey: "test", fetchImpl: transport({ v0_s0_intent: choice(intent), v0_s0_delivery: choice(delivery), v0_s0_action: choice(action) }) })({ versions: [{ id: "de", text: "Das ist ernst." }], mood: { joy: 1 } });
    assert.equal(result.versions[0].segments[0].delivery, "neutral");
    assert.equal(result.versions[0].segments[0].action, "none");
    assert.equal(render(result.versions[0]), "Das ist ernst.");
  });
}

test("recognized humor permits a closed-list comic action", async () => {
  const result = await createPlanner({ apiKey: "test", fetchImpl: transport({ v0_s0_intent: choice("humor"), v0_s0_delivery: choice("playful"), v0_s0_action: choice("chuckle") }) })({ versions: [{ id: "de", text: "Ein Witz." }] });
  assert.equal(render(result.versions[0]), "[playful][chuckles]Ein Witz.");
});

test("DE and PL are batched and share compatible semantic delivery", async () => {
  let calls = 0;
  const result = await createPlanner({ apiKey: "test", fetchImpl: transport({ v0_s0_intent: choice("praise"), v1_s0_intent: choice("praise"), v0_s0_delivery: choice("warm"), v1_s0_delivery: choice("warm") }, (body) => { calls++; assert.equal(JSON.parse(body.state).versions.length, 2); assert.equal(body.questions.pair_0.type, "choice"); }) })({ versions: [{ id: "de", text: "Danke!" }, { id: "pl", text: "Dzięki!" }] });
  assert.equal(calls, 1);
  assert.deepEqual(result.versions.map((v) => v.segments[0].delivery), ["warm", "warm"]);
});

for (const correspondence of [choice("uncertain"), choice("different"), choice("equivalent", 0.5)]) {
  test(`uncertain/unsupported correspondence ${correspondence.choice}/${correspondence.confidence} stays neutral`, async () => {
    const result = await createPlanner({ apiKey: "test", fetchImpl: transport({ pair_0: correspondence, v0_s0_delivery: choice("warm"), v1_s0_delivery: choice("sad") }) })({ versions: [{ id: "de", text: "Danke!" }, { id: "pl", text: "To smutne." }] });
    assert.deepEqual(result.versions.map(render), ["Danke!", "To smutne."]);
  });
}

test("low confidence or unknown delivery fails open to exact neutral speech", async () => {
  for (const answer of [choice("[arbitrary tag]"), choice("warm", 0.5)]) {
    const result = await createPlanner({ apiKey: "test", fetchImpl: transport({ v0_s0_delivery: answer }) })({ versions: [{ id: "de", text: "Exact 😀 words." }] });
    assert.equal(result.ok, false);
    assert.equal(render(result.versions[0]), "Exact 😀 words.");
  }
});

test("renderer validates every Unicode span and closed classification before inserting any tags", () => {
  const text = "😀 Hi!";
  for (const segments of [[segment(0, 3, "praise", "warm"), segment(2, 5)], [segment(0, 2), segment(3, 5)], [segment(0, 6)], [segment(0, 5, "neutral", "[evil]")], [segment(0, 5, "neutral", "warm", "evil")], [segment(0, 5, "criticism", "cheerful", "laugh")]]) {
    assert.equal(render({ text, segments }), text);
  }
  assert.equal(render({ text, segments: [segment(0, 2, "neutral", "warm"), segment(2, 5)] }), "[warm]😀 [neutral]Hi!");
  assert.equal(render({ text: "[laughing] do this", segments: [segment(0, 18, "humor", "playful")] }), "");
});

test("cheerful metadata uses a fixed happy provider tag and resets the next neutral segment", () => {
  assert.equal(render({ text: "Gut. Ernst.", segments: [segment(0, 5, "celebration", "cheerful"), segment(5, 11)] }), "[happy]Gut. [neutral]Ernst.");
});
