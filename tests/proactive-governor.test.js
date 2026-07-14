import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createGovernorState, applyOutcomeAdjustments, evaluateGovernor, recordProactiveSend,
} from "../lib/proactive-governor.js";

const H = 3600000, D = 86400000;
const T0 = 1750000000000;

describe("proactive-governor", () => {
  it("Startzustand: Budget 2, erlaubt", () => {
    const s = createGovernorState(T0);
    assert.strictEqual(s.budgetPerWeek, 2);
    assert.strictEqual(evaluateGovernor(s, T0).allowed, true);
  });

  it("blockt, wenn Wochenbudget verbraucht", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    s = recordProactiveSend(s, "afterthought", T0 + D);
    assert.strictEqual(evaluateGovernor(s, T0 + 2 * D).allowed, false);
  });

  it("Wochenfenster-Rollover: alte Sends zählen nicht mehr", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    s = recordProactiveSend(s, "dream-echo", T0 + D);
    assert.strictEqual(evaluateGovernor(s, T0 + 8 * D).allowed, true);
  });

  it("positive attribuierte Outcomes heben das Budget (+0.25, Cap 4)", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    const outcomes = Array.from({ length: 20 }, (_, i) => ({
      timestamp: T0 + H + i, outcome: "confirmed_or_continued",
    }));
    s = applyOutcomeAdjustments(s, outcomes, { now: T0 + 2 * H });
    assert.strictEqual(s.budgetPerWeek, 4); // 2 + 20*0.25 geclampt auf 4
  });

  it("negative attribuierte Outcomes senken das Budget (Floor 1)", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    const outcomes = Array.from({ length: 20 }, (_, i) => ({
      timestamp: T0 + H + i, outcome: "ignored_or_topic_shifted",
    }));
    s = applyOutcomeAdjustments(s, outcomes, { now: T0 + 2 * H });
    assert.strictEqual(s.budgetPerWeek, 1);
  });

  it("Outcomes außerhalb des 6h-Attribution-Fensters zählen nicht", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    s = applyOutcomeAdjustments(s, [{ timestamp: T0 + 7 * H, outcome: "confirmed_or_continued" }], { now: T0 + 8 * H });
    assert.strictEqual(s.budgetPerWeek, 2);
  });

  it("Outcomes ohne vorherigen Send zählen nicht", () => {
    let s = createGovernorState(T0);
    s = applyOutcomeAdjustments(s, [{ timestamp: T0 + H, outcome: "confirmed_or_continued" }], { now: T0 + 2 * H });
    assert.strictEqual(s.budgetPerWeek, 2);
  });

  it("adjustedAt verhindert Doppelzählung bei erneutem Aufruf", () => {
    let s = createGovernorState(T0);
    s = recordProactiveSend(s, "dream-echo", T0);
    const outcomes = [{ timestamp: T0 + H, outcome: "confirmed_or_continued" }];
    s = applyOutcomeAdjustments(s, outcomes, { now: T0 + 2 * H });
    const budget = s.budgetPerWeek;
    s = applyOutcomeAdjustments(s, outcomes, { now: T0 + 3 * H });
    assert.strictEqual(s.budgetPerWeek, budget);
  });

  it("höheres Budget erlaubt mehr Sends pro Woche", () => {
    let s = createGovernorState(T0);
    s.budgetPerWeek = 4;
    s = recordProactiveSend(s, "a", T0);
    s = recordProactiveSend(s, "b", T0 + 1);
    s = recordProactiveSend(s, "c", T0 + 2);
    assert.strictEqual(evaluateGovernor(s, T0 + 3).allowed, true);
    s = recordProactiveSend(s, "d", T0 + 3);
    assert.strictEqual(evaluateGovernor(s, T0 + 4).allowed, false);
  });

  it("fail-open bei kaputtem State/Outcomes", () => {
    assert.strictEqual(evaluateGovernor(null, T0).allowed, true);
    const s = applyOutcomeAdjustments(createGovernorState(T0), null, { now: T0 });
    assert.strictEqual(s.budgetPerWeek, 2);
  });
});
