import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { makeTempDir } from "./helpers/temp-dir.js";
import { join } from "node:path";
import { EmotionalState, createEmotionalStatePool } from "../lib/emotional-state.js";

const START = 1_800_000_000_000;
const MINUTE = 60_000;
const dimensions = ["joy", "sadness", "anger", "fear", "disgust", "surprise", "trust", "anticipation"];
const reaction = (values = {}) => Object.fromEntries(dimensions.map((dim) => [dim, values[dim] ?? 0]));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
function clock(t) {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  return (elapsed) => t.mock.timers.setTime(START + elapsed);
}
function timed(options = {}) {
  const state = new EmotionalState(options);
  state.configureTimedMood();
  return state;
}
function evidence(state, eventId, observedAt = Date.now(), values = { anger: 0.8 }) {
  return state.applyTimedEvidence(reaction(values), { eventId, observedAt });
}
function persisted(t, state) {
  const directory = makeTempDir("timed-mood-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "state.json");
  writeFileSync(file, JSON.stringify({ state }));
  return file;
}

test("continuous evidence approaches half, three quarters and seven eighths after 5/10/15 minutes", (t) => {
  const at = clock(t);
  const state = timed();
  assert.equal(evidence(state, "event-0"), true);
  near(state.snapshot().anger, 0.02);
  for (let minute = 1; minute <= 15; minute++) {
    at(minute * MINUTE);
    assert.equal(evidence(state, `event-${minute}`), true);
    if (minute === 5) near(state.snapshot().anger, 0.42);
    if (minute === 10) near(state.snapshot().anger, 0.62);
    if (minute === 15) near(state.snapshot().anger, 0.72);
  }
});

test("same target at different event and reader rates has the same elapsed-time result", (t) => {
  const at = clock(t);
  const frequent = timed();
  const sparse = timed();
  evidence(frequent, "frequent-0");
  evidence(sparse, "sparse-0");
  for (let second = 1; second <= 900; second++) {
    at(second * 1000);
    evidence(frequent, `frequent-${second}`);
    frequent.describeMood();
    frequent.computeRecallBoost({ anger: 0.8, trust: 0.5 });
    frequent.serializeState();
    if (second % 120 === 0) evidence(sparse, `sparse-${second}`);
  }
  near(frequent.snapshot().anger, 0.72);
  near(sparse.snapshot().anger, 0.72);
});

test("first evidence after idle does not integrate old idle time against the new target", (t) => {
  const at = clock(t);
  const state = timed();
  at(60 * MINUTE);
  evidence(state, "first");
  near(state.snapshot().anger, 0.02);
  at(61 * MINUTE);
  near(state.snapshot().anger, 0.1235595493631007);
});

test("long idle integrates old evidence only to expiry then passively decays", (t) => {
  const at = clock(t);
  const state = timed();
  evidence(state, "old");
  at(17 * MINUTE);
  // 2 minutes of approach: .8 * (1 - 2^(-.4)); then one anger half-life.
  const expected = 0.02 + 0.8 * (1 - 2 ** -0.4) / 2;
  near(state.snapshot().anger, expected);
  evidence(state, "new", Date.now(), { joy: 0.5 });
  near(state.snapshot().anger, expected);
  near(state.snapshot().joy, 0.25);
  assert.equal(state.serializeState().timedMood.expiresAt, START + 19 * MINUTE);
});

test("passive decay uses each new dimension half-life multiplied by temperament", (t) => {
  const at = clock(t);
  const state = timed({ decayMultiplier: 2 });
  for (const dim of dimensions) state.current[dim] = state.baseline[dim] + 0.4;
  at(4 * MINUTE);
  const halfLives = { surprise: 2, fear: 15, anger: 15, joy: 30, anticipation: 30, sadness: 45, disgust: 45, trust: 60 };
  for (const dim of dimensions) near(state.snapshot()[dim], state.baseline[dim] + 0.4 * 2 ** (-4 / (halfLives[dim] * 2)));
});

test("sensitivity and baseline determine target without an immediate blend", (t) => {
  const at = clock(t);
  const state = timed({ baseline: { anger: 0.1 }, sensitivity: 0.5, blendFactor: 1 });
  evidence(state, "first");
  near(state.snapshot().anger, 0.1);
  at(MINUTE);
  evidence(state, "refresh");
  at(2 * MINUTE);
  near(state.snapshot().anger, 0.1 + 0.4 * (1 - 2 ** -0.4));
});

test("duplicate, older, expired, future and invalid observations do not refresh evidence", (t) => {
  const at = clock(t);
  const state = timed();
  evidence(state, "accepted");
  at(MINUTE);
  assert.equal(evidence(state, "accepted"), false);
  assert.equal(evidence(state, "older", START - 1), false);
  assert.equal(evidence(state, "future", Date.now() + 1), false);
  assert.equal(evidence(state, ""), false);
  assert.equal(state.applyTimedEvidence({ anger: 0.8 }, { eventId: "partial", observedAt: Date.now() }), false);
  for (const value of [NaN, Infinity, -0.1, 1.1, "0.5"]) {
    assert.equal(state.applyTimedEvidence(reaction({ anger: value }), { eventId: "invalid", observedAt: Date.now() }), false);
  }
  assert.equal(state.applyTimedEvidence(reaction(), { eventId: "bad-time", observedAt: NaN }), false);
  at(3 * MINUTE);
  assert.equal(evidence(state, "expired", START), false);
  const afterHold = 0.02 + 0.8 * (1 - 2 ** -0.4) * 2 ** (-1 / 15);
  near(state.snapshot().anger, afterHold);
});

test("delayed observations expire relative to observation time rather than receipt", (t) => {
  const at = clock(t);
  const state = timed();
  at(MINUTE);
  assert.equal(evidence(state, "delayed", START), true);
  at(3 * MINUTE);
  near(state.snapshot().anger, 0.02 + 0.8 * (1 - 2 ** -0.2) * 2 ** (-1 / 15));
});

test("custom timing is validated and honors approach and passive half-lives", (t) => {
  const at = clock(t);
  const state = new EmotionalState();
  state.configureTimedMood({ approachHalfLifeMs: MINUTE, evidenceHoldMs: MINUTE, passiveHalfLivesMs: { anger: MINUTE } });
  evidence(state, "first");
  at(2 * MINUTE);
  near(state.snapshot().anger, 0.22);
  state.configureTimedMood({ approachHalfLifeMs: NaN, evidenceHoldMs: -1, passiveHalfLivesMs: { anger: Infinity } });
  evidence(state, "second");
  at(3 * MINUTE);
  assert.ok(Number.isFinite(state.snapshot().anger));
});

test("v3 restart continues active target and rejects persisted duplicate and older events", (t) => {
  const at = clock(t);
  const source = timed();
  evidence(source, "initial");
  at(MINUTE);
  evidence(source, "refresh");
  const saved = source.serializeState();
  assert.equal(saved.version, 3);
  const file = persisted(t, saved);
  at(2 * MINUTE);
  const restarted = timed();
  assert.equal(restarted.hydrateOnce(file), true);
  near(restarted.snapshot().anger, source.snapshot().anger);
  assert.equal(evidence(restarted, "refresh"), false);
  assert.equal(evidence(restarted, "older", START), false);
  assert.equal(restarted.hydrateOnce(file), false);
  at(4 * MINUTE);
  near(restarted.snapshot().anger, source.snapshot().anger);
});

test("v2 hydration keeps current state and configured baseline without resetting mood", (t) => {
  const at = clock(t);
  const state = timed({ baseline: { anger: 0.1 } });
  const file = persisted(t, { version: 2, current: reaction({ anger: 0.9 }), baseline: reaction(), nuanceState: { gratitude: 0.7 }, lastUpdateAt: START });
  at(15 * MINUTE);
  assert.equal(state.hydrateOnce(file), true);
  near(state.snapshot().anger, 0.5);
  assert.equal(state.baseline.anger, 0.1);
  assert.ok(state.snapshot().nuances.gratitude > 0);
  evidence(state, "new");
  near(state.snapshot().anger, 0.5);
});

test("malformed v3 additions cannot install targets or poison ordering, but preserve valid current", (t) => {
  clock(t);
  for (const addition of [
    { target: reaction({ anger: 1 }), expiresAt: START + 999999999, lastObservedAt: START + 1, eventIds: [] },
    { target: { anger: 1 }, expiresAt: START + MINUTE, lastObservedAt: START, eventIds: [] },
    { target: reaction(), expiresAt: "Infinity", lastObservedAt: START, eventIds: [] },
    { target: reaction(), expiresAt: START + MINUTE, lastObservedAt: START, eventIds: ["malformed"] },
  ]) {
    const state = timed();
    assert.equal(state.hydrateOnce(persisted(t, { version: 3, current: reaction({ anger: 0.6 }), lastUpdateAt: START, timedMood: addition })), true);
    near(state.snapshot().anger, 0.6);
    assert.equal(evidence(state, "valid-now"), true);
  }
});

test("dedupe serialization is bounded at 512 events and survives restart", (t) => {
  const at = clock(t);
  const state = timed();
  for (let index = 0; index < 600; index++) {
    at(index);
    assert.equal(evidence(state, `event-${index}`), true);
  }
  const saved = state.serializeState();
  assert.equal(saved.timedMood.eventIds.length, 512);
  const restored = timed();
  restored.hydrateOnce(persisted(t, saved));
  assert.equal(evidence(restored, "event-599"), false);
  assert.equal(evidence(restored, "event-88"), false);
});

test("unconfigured or disabled states retain legacy immediate blending and old decay", (t) => {
  const at = clock(t);
  const legacy = new EmotionalState();
  const disabled = new EmotionalState();
  disabled.configureTimedMood({ enabled: false });
  for (const state of [legacy, disabled]) {
    assert.equal(evidence(state, "ignored"), false);
    state.applyEmotionScore({ anger: 0.8, emotionalIntensity: 0.8 });
    near(state.snapshot().anger, 0.38);
  }
  at(120 * MINUTE);
  for (const state of [legacy, disabled]) near(state.snapshot().anger, 0.2);
});

test("existing pool and recall readers see the same lazily advanced timed state", (t) => {
  const at = clock(t);
  const pool = createEmotionalStatePool();
  const state = pool.get("bernhardine");
  state.configureTimedMood();
  evidence(state, "first");
  at(MINUTE);
  const value = pool.snapshot("bernhardine").anger;
  near(value, 0.1235595493631007);
  near(pool.describe("bernhardine").details.anger, value);
  near(pool.status().bernhardine.details.anger, value);
  state.computeMoodCompatibility(reaction({ anger: 0.8 }));
  state.computeRecallBoost(reaction({ anger: 0.8 }));
  near(state.serializeState().current.anger, value);
  near(pool.get("heisenberg").snapshot().anger, 0.02);
});

test("explicitly configured v3 restart resumes its configured timing and dedupe", (t) => {
  const at = clock(t);
  const timing = { approachHalfLifeMs: MINUTE, passiveHalfLivesMs: { anger: 3 * MINUTE } };
  const source = new EmotionalState();
  source.configureTimedMood(timing);
  evidence(source, "before-restart");
  const file = persisted(t, source.serializeState());
  at(MINUTE);
  const restored = new EmotionalState();
  restored.configureTimedMood(timing);
  assert.equal(restored.hydrateOnce(file), true);
  near(restored.snapshot().anger, 0.42);
  assert.equal(evidence(restored, "before-restart"), false);
  at(2 * MINUTE);
  near(restored.snapshot().anger, 0.62);
  near(restored.snapshot().anger, source.snapshot().anger);
  at(5 * MINUTE);
  near(restored.snapshot().anger, 0.32);
});

test("unconfigured v3 hydration keeps legacy behavior without integrating its timed target", (t) => {
  const at = clock(t);
  const source = timed();
  evidence(source, "persisted-active-target");
  const file = persisted(t, source.serializeState());
  at(MINUTE);
  const restored = new EmotionalState();
  assert.equal(restored.hydrateOnce(file), true);
  near(restored.snapshot().anger, 0.02);
  near(restored.describeMood().details.anger, 0.02);
  near(restored.serializeState().current.anger, 0.02);
  assert.equal(evidence(restored, "not-enabled"), false);
  at(2 * MINUTE);
  near(restored.snapshot().anger, 0.02);
});

test("hydrating v3 then disabling retains persisted mood with legacy passive decay", (t) => {
  const at = clock(t);
  const source = timed();
  source.current.anger = 0.42;
  evidence(source, "persisted-target");
  const file = persisted(t, source.serializeState());
  at(MINUTE);
  const restored = new EmotionalState();
  assert.equal(restored.hydrateOnce(file), true);
  restored.configureTimedMood({ enabled: false });
  near(restored.snapshot().anger, 0.02 + 0.4 * 2 ** (-1 / 120));
  assert.equal(evidence(restored, "disabled"), false);
  assert.equal(restored.serializeState().timedMood.target, null);
  at(120 * MINUTE);
  near(restored.snapshot().anger, 0.22);
});

test("v2 hydrate before enabling retains its existing mood and can accept evidence without jump", (t) => {
  const at = clock(t);
  const file = persisted(t, { version: 2, current: reaction({ anger: 0.82 }), nuanceState: {}, lastUpdateAt: START });
  at(120 * MINUTE);
  const state = new EmotionalState();
  assert.equal(state.hydrateOnce(file), true);
  near(state.snapshot().anger, 0.42);
  state.configureTimedMood();
  evidence(state, "after-migration");
  near(state.snapshot().anger, 0.42);
});

test("explicit disabled configuration never resumes a persisted active target", (t) => {
  const at = clock(t);
  const source = timed();
  evidence(source, "active");
  const file = persisted(t, source.serializeState());
  at(MINUTE);
  const disabled = new EmotionalState();
  disabled.configureTimedMood({ enabled: false });
  disabled.hydrateOnce(file);
  near(disabled.snapshot().anger, 0.02);
  assert.equal(evidence(disabled, "disabled"), false);
});

test("selective evidence preserves unrelated targets through their original expiry and restart", t => {
  const at = clock(t);
  const state = timed();
  const control = timed();
  evidence(state, "first", START, { anger: .8 });
  evidence(control, "first", START, { anger: .8 });
  at(MINUTE);
  assert.equal(state.applyTimedEvidence(reaction({ joy: .5, anger: 1 }), { eventId: "joy", observedAt: Date.now(), dimensions: ["joy"] }), true);
  const saved = state.serializeState();
  assert.equal(saved.timedMood.expiresAtByDimension.anger, START + 2 * MINUTE);
  assert.equal(saved.timedMood.expiresAtByDimension.joy, START + 3 * MINUTE);
  const restarted = timed();
  assert.equal(restarted.hydrateOnce(persisted(t, saved)), true);
  for (const seconds of [90, 120, 150, 180, 240, 900]) {
    at(seconds * 1000);
    near(state.snapshot().anger, control.snapshot().anger);
    near(restarted.snapshot().anger, control.snapshot().anger);
    near(restarted.snapshot().joy, state.snapshot().joy);
  }
});

test("invalid masks reject atomically without consuming the message id", t => {
  clock(t);
  const state = timed();
  const before = state.serializeState();
  for (const dimensions of [[], Array(1), ["joy", "joy"], ["unknown"], null, "joy", ["joy", 1]]) {
    assert.equal(state.applyTimedEvidence(reaction({ joy: 1 }), { eventId: "same", observedAt: START, dimensions }), false);
    assert.deepEqual(state.serializeState(), before);
  }
  assert.equal(state.applyTimedEvidence(reaction({ joy: 1 }), { eventId: "same", observedAt: START, dimensions: ["joy"] }), true);
  assert.equal(state.applyTimedEvidence(reaction({ anger: 1 }), { eventId: "same", observedAt: START, dimensions: ["anger"] }), false);
});

test("unknown dimensions are rate independent even after active expiry", t => {
  const at = clock(t);
  const frequent = timed();
  const sparse = timed();
  evidence(frequent, "first");
  evidence(sparse, "first");
  for (let second = 1; second <= 300; second++) {
    at(second * 1000);
    frequent.applyTimedEvidence(reaction({ joy: .5 }), { eventId: `f${second}`, observedAt: Date.now(), dimensions: ["joy"] });
    if (second % 60 === 0) sparse.applyTimedEvidence(reaction({ joy: .5 }), { eventId: `s${second}`, observedAt: Date.now(), dimensions: ["joy"] });
    near(frequent.snapshot().anger, sparse.snapshot().anger);
  }
  near(frequent.snapshot().anger, .02 + .8 * (1 - 2 ** -.4) * 2 ** (-3 / 15));
});

test("old v3 single expiry hydrates as all eight dimensions", t => {
  const at = clock(t);
  const source = timed();
  evidence(source, "old-v3");
  const saved = source.serializeState();
  delete saved.timedMood.expiresAtByDimension;
  at(MINUTE);
  const restored = timed();
  assert.equal(restored.hydrateOnce(persisted(t, saved)), true);
  near(restored.snapshot().anger, source.snapshot().anger);
  assert.equal(restored.serializeState().timedMood.expiresAtByDimension.anger, START + 2 * MINUTE);
});

test("malformed per-dimension expiry additions never partially install metadata", t => {
  clock(t);
  for (const patch of [{ anger: "1" }, { anger: START + 9999999 }, { anger: -1 }, { anger: START - 1 }, { bad: START }]) {
    const source = timed();
    evidence(source, "source");
    const saved = source.serializeState();
    saved.current.anger = .6;
    saved.timedMood.expiresAtByDimension = { ...Object.fromEntries(dimensions.map(d => [d, START + 2 * MINUTE])), ...patch };
    const restored = timed();
    assert.equal(restored.hydrateOnce(persisted(t, saved)), true);
    near(restored.snapshot().anger, .6);
    assert.equal(restored.serializeState().timedMood.target, null);
    assert.equal(evidence(restored, "source"), true);
  }
});

test("enabling timed mode after hydration cannot resurrect an unconfigured persisted target", t => {
  const at = clock(t);
  const source = timed();
  evidence(source, "original");
  const restored = new EmotionalState();
  assert.equal(restored.hydrateOnce(persisted(t, source.serializeState())), true);
  restored.configureTimedMood();
  at(MINUTE);
  near(restored.snapshot().anger, .02);
  assert.equal(restored.serializeState().timedMood.target, null);
});
