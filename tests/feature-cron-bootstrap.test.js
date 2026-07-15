import { describe, it } from "node:test";
import assert from "node:assert";
import {
  shouldRunCronBootstrap,
  featureCronsHintFromMarker,
} from "../lib/setup/feature-cron-bootstrap.js";

const NOW = Date.parse("2026-07-14T12:00:00Z");
const PV = "1.2.3";

describe("shouldRunCronBootstrap", () => {
  it("runs when marker is missing", () => {
    assert.strictEqual(shouldRunCronBootstrap(null, { now: NOW, pluginVersion: PV }), true);
    assert.strictEqual(shouldRunCronBootstrap(undefined, { now: NOW, pluginVersion: PV }), true);
  });

  it("runs when marker is malformed / unparseable lastRunAt", () => {
    assert.strictEqual(
      shouldRunCronBootstrap({ pluginVersion: PV, lastRunAt: "not-a-date" }, { now: NOW, pluginVersion: PV }),
      true,
    );
    assert.strictEqual(shouldRunCronBootstrap("garbage", { now: NOW, pluginVersion: PV }), true);
  });

  it("skips when the last run is fresh (< 20h old) and same version", () => {
    const lastRunAt = new Date(NOW - 5 * 60 * 60 * 1000).toISOString(); // 5h ago
    assert.strictEqual(
      shouldRunCronBootstrap({ pluginVersion: PV, lastRunAt }, { now: NOW, pluginVersion: PV }),
      false,
    );
  });

  it("runs when the last run is stale (>= 20h old)", () => {
    const lastRunAt = new Date(NOW - 21 * 60 * 60 * 1000).toISOString(); // 21h ago
    assert.strictEqual(
      shouldRunCronBootstrap({ pluginVersion: PV, lastRunAt }, { now: NOW, pluginVersion: PV }),
      true,
    );
  });

  it("runs right at the 20h boundary", () => {
    const lastRunAt = new Date(NOW - 20 * 60 * 60 * 1000).toISOString(); // exactly 20h ago
    assert.strictEqual(
      shouldRunCronBootstrap({ pluginVersion: PV, lastRunAt }, { now: NOW, pluginVersion: PV }),
      true,
    );
  });

  it("runs on a version bump even if the last run was recent", () => {
    const lastRunAt = new Date(NOW - 60 * 1000).toISOString(); // 1 minute ago
    assert.strictEqual(
      shouldRunCronBootstrap({ pluginVersion: "1.2.2", lastRunAt }, { now: NOW, pluginVersion: PV }),
      true,
    );
  });
});

describe("featureCronsHintFromMarker", () => {
  it("hints when marker is missing", () => {
    assert.match(featureCronsHintFromMarker(null, PV), /setup-feature-crons/);
    assert.match(featureCronsHintFromMarker(undefined, PV), /setup-feature-crons/);
  });

  it("hints when marker is from an older plugin version", () => {
    assert.match(
      featureCronsHintFromMarker({ pluginVersion: "1.2.2", lastPlanCreateCount: 0 }, PV),
      /setup-feature-crons/,
    );
  });

  it("hints when the last run still had crons left to create", () => {
    assert.match(
      featureCronsHintFromMarker({ pluginVersion: PV, lastPlanCreateCount: 3 }, PV),
      /setup-feature-crons/,
    );
  });

  it("is silent when the last run is current-version and created everything", () => {
    assert.strictEqual(
      featureCronsHintFromMarker({ pluginVersion: PV, lastPlanCreateCount: 0 }, PV),
      null,
    );
  });

  it("is silent when lastPlanCreateCount is absent but version matches (treat as nothing pending)", () => {
    assert.strictEqual(
      featureCronsHintFromMarker({ pluginVersion: PV }, PV),
      null,
    );
  });
});
