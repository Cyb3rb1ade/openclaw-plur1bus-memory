import { strict as assert } from "node:assert";
import test from "node:test";

import { describeFeatureCronBootstrapResult } from "../lib/setup/feature-cron-bootstrap.js";

test("nennt geplante, geaenderte und gescheiterte Jobs beim Namen", () => {
  const line = describeFeatureCronBootstrapResult({
    plan: {
      create: [{ name: "plur1bus rem-dream main", payload: { argv: ["/secret/path"] } }],
      update: [{ name: "plur1bus consolidate-daily main" }],
    },
    results: [
      { job: "plur1bus rem-dream main", ok: false, stderr: "token=abc timeout" },
      { job: "plur1bus consolidate-daily main", ok: true },
    ],
  });
  assert.equal(line, "create=[plur1bus rem-dream main] update=[plur1bus consolidate-daily main] failed=[plur1bus rem-dream main]");
  assert.doesNotMatch(line, /secret|token/);
});

test("nennt den Abbruchgrund und schweigt ohne offene Arbeit", () => {
  assert.equal(describeFeatureCronBootstrapResult({ reason: "agent-discovery-failed", lastPlanCreateCount: 11 }), "reason=agent-discovery-failed");
  assert.equal(describeFeatureCronBootstrapResult({ plan: { create: [], update: [] }, results: [] }), null);
  assert.equal(describeFeatureCronBootstrapResult(null), null);
  assert.equal(describeFeatureCronBootstrapResult({ plan: { create: [{ name: "evil\nname" }] } }), null);
});
