import { describe, it } from "node:test";
import assert from "node:assert";
import { Writable } from "node:stream";
import * as pluginModule from "../index.js";
import {
  shouldRunCronBootstrap,
  featureCronsHintFromMarker,
} from "../lib/setup/feature-cron-bootstrap.js";
import { runSetupFeatureCrons } from "../scripts/setup-feature-crons.mjs";

const NOW = Date.parse("2026-07-14T12:00:00Z");
const PV = "1.2.3";
const { parseFeatureCronBootstrapLastPlanCreateCount } = pluginModule;

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

  it("hints when lastPlanCreateCount is absent but version matches", () => {
    assert.match(
      featureCronsHintFromMarker({ pluginVersion: PV }, PV),
      /setup-feature-crons/,
    );
  });
});

function createWritableBuffer() {
  let data = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        data += chunk.toString();
        callback();
      },
    }),
    read() {
      return data;
    },
  };
}

async function runJsonSetupWith(openclawImpl, argv = ["--json"]) {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const exitCode = await runSetupFeatureCrons({ argv, openclawImpl, stdout: stdout.stream, stderr: stderr.stream });
  const text = stdout.read().trim();
  return {
    exitCode,
    stdout: text,
    stderr: stderr.read(),
    parsed: JSON.parse(text),
  };
}

describe("runSetupFeatureCrons --json", () => {
  it("prints one JSON object and exit 0 when the CLI is unavailable", async () => {
    const result = await runJsonSetupWith(() => ({ ok: false, stdout: "", stderr: "missing", status: 1 }));
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.parsed.lastPlanCreateCount, 2);
    assert.strictEqual(result.parsed.reason, "cli-unavailable");
  });

  it("prints one JSON object and exit 0 when cron list fails", async () => {
    const calls = [];
    const result = await runJsonSetupWith((args) => {
      calls.push(args);
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") return { ok: false, stdout: "", stderr: "list failed", status: 1 };
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.parsed.lastPlanCreateCount, 2);
    assert.strictEqual(result.parsed.reason, "cron-list-failed");
    assert.strictEqual(calls.length, 2);
  });

  it("prints one JSON object and exit 0 when cron list JSON is unparseable", async () => {
    const result = await runJsonSetupWith((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") return { ok: true, stdout: "{not-json", stderr: "", status: 0 };
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.parsed.lastPlanCreateCount, 2);
    assert.strictEqual(result.parsed.reason, "cron-list-parse-failed");
  });

  it("prints one JSON object and exit 0 on unexpected top-level errors", async () => {
    const result = await runJsonSetupWith(() => {
      throw new Error("boom");
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.parsed.lastPlanCreateCount, 2);
    assert.strictEqual(result.parsed.reason, "unexpected-error");
    assert.match(result.parsed.message, /boom/);
  });
});

describe("parseFeatureCronBootstrapLastPlanCreateCount", () => {
  it("is exported", () => {
    assert.strictEqual(typeof parseFeatureCronBootstrapLastPlanCreateCount, "function");
  });

  it("prefers explicit lastPlanCreateCount from script JSON", () => {
    assert.strictEqual(
      parseFeatureCronBootstrapLastPlanCreateCount(JSON.stringify({ lastPlanCreateCount: 7, plan: { create: [] }, results: [] })),
      7,
    );
  });

  it("preserves failedCreates + disabledDeliveryCreates when explicit count is absent", () => {
    const stdout = JSON.stringify({
      plan: {
        create: [
          { needsDelivery: true, enabled: false },
          { needsDelivery: false, enabled: true },
          { needsDelivery: true, enabled: false },
        ],
      },
      results: [
        { ok: true },
        { ok: false },
      ],
    });
    assert.strictEqual(parseFeatureCronBootstrapLastPlanCreateCount(stdout), 3);
  });

  it("returns 1 when stdout parses but is not a JSON object", () => {
    assert.strictEqual(parseFeatureCronBootstrapLastPlanCreateCount("[]"), 1);
    assert.strictEqual(parseFeatureCronBootstrapLastPlanCreateCount('"hello"'), 1);
    assert.strictEqual(parseFeatureCronBootstrapLastPlanCreateCount("null"), 1);
  });

  it("returns 1 when stdout is unparseable", () => {
    assert.strictEqual(parseFeatureCronBootstrapLastPlanCreateCount("{not-json"), 1);
    assert.strictEqual(parseFeatureCronBootstrapLastPlanCreateCount(""), 1);
  });
});
