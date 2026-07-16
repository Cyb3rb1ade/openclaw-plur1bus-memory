import { describe, it } from "node:test";
import assert from "node:assert";
import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as pluginModule from "../index.js";
import {
  shouldRunCronBootstrap,
  featureCronsHintFromMarker,
} from "../lib/setup/feature-cron-bootstrap.js";
import { runSetupFeatureCrons } from "../scripts/setup-feature-crons.mjs";

const NOW = Date.parse("2026-07-14T12:00:00Z");
const PV = "1.2.3";
const { parseFeatureCronBootstrapLastPlanCreateCount, runDeferredFeatureCronBootstrap } = pluginModule;

function fakeChild({ stdout = "", closeCode = 0, emitError = false }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.resume = () => {};
  // Defer emission so listeners registered by runDeferredFeatureCronBootstrap
  // are attached first (mirrors real async child_process timing).
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (emitError) child.emit("error", new Error("spawn failed"));
    else child.emit("close", closeCode);
  });
  return child;
}

function makeApi() {
  const logs = [];
  return {
    logger: {
      debug: (msg) => logs.push(["debug", msg]),
      info: (msg) => logs.push(["info", msg]),
      warn: (msg) => logs.push(["warn", msg]),
    },
    logs,
  };
}

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

  it("does not emit announce args for automatic disabled afterthought jobs without delivery", async () => {
    const cronAdds = [];
    const result = await runJsonSetupWith((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ jobs: [] }), stderr: "", status: 0 };
      if (args[0] === "agents" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify({
            agents: [
              { id: "main", bindings: 2, isDefault: true, workspace: "/ws/main" },
            ],
          }),
          stderr: "",
          status: 0,
        };
      }
      if (args[0] === "cron" && args[1] === "add") {
        cronAdds.push(args);
        return { ok: true, stdout: "{}", stderr: "", status: 0 };
      }
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });

    assert.strictEqual(result.exitCode, 0);
    const afterthoughtAdd = cronAdds.find((args) => args.includes("--name") && args.includes("plur1bus afterthought main"));
    assert.ok(afterthoughtAdd, "afterthought cron add call must be present");
    assert.ok(!afterthoughtAdd.includes("--announce"), "automatic disabled afterthought must not wire --announce");
    assert.ok(!afterthoughtAdd.includes("--channel"), "automatic disabled afterthought must not wire --channel");
    assert.ok(!afterthoughtAdd.includes("--to"), "automatic disabled afterthought must not wire --to");
  });

  it("emits --announce/--channel/--to/--account (no --disabled) for automatic afterthought when delivery is derivable", async () => {
    const cronAdds = [];
    const result = await runJsonSetupWith((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify({
            jobs: [
              {
                agentId: "main",
                name: "plur1bus-morning-review-main",
                delivery: { mode: "announce", channel: "telegram", to: "55736530", accountId: "telegram-main" },
              },
            ],
          }),
          stderr: "",
          status: 0,
        };
      }
      if (args[0] === "agents" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify({ agents: [{ id: "main", bindings: 2, isDefault: true, workspace: "/ws/main" }] }),
          stderr: "",
          status: 0,
        };
      }
      if (args[0] === "cron" && args[1] === "add") {
        cronAdds.push(args);
        return { ok: true, stdout: "{}", stderr: "", status: 0 };
      }
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });

    assert.strictEqual(result.exitCode, 0);
    const afterthoughtAdd = cronAdds.find((args) => args.includes("--name") && args.includes("plur1bus afterthought main"));
    assert.ok(afterthoughtAdd, "automatic afterthought cron add call for main must be present");
    assert.ok(afterthoughtAdd.includes("--announce"), "derivable delivery should announce");
    assert.deepStrictEqual(afterthoughtAdd.slice(afterthoughtAdd.indexOf("--channel"), afterthoughtAdd.indexOf("--channel") + 2), ["--channel", "telegram"]);
    assert.deepStrictEqual(afterthoughtAdd.slice(afterthoughtAdd.indexOf("--to"), afterthoughtAdd.indexOf("--to") + 2), ["--to", "55736530"]);
    assert.deepStrictEqual(afterthoughtAdd.slice(afterthoughtAdd.indexOf("--account"), afterthoughtAdd.indexOf("--account") + 2), ["--account", "telegram-main"]);
    assert.ok(!afterthoughtAdd.includes("--disabled"), "derivable delivery must not be created disabled");
  });

  it("preserves legacy explicit --agent setup by emitting --announce for enabled afterthought jobs", async () => {
    const cronAdds = [];
    const result = await runJsonSetupWith((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ jobs: [] }), stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "add") {
        cronAdds.push(args);
        return { ok: true, stdout: "{}", stderr: "", status: 0 };
      }
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    }, ["--json", "--agent", "main"]);

    assert.strictEqual(result.exitCode, 0);
    const afterthoughtAdd = cronAdds.find((args) => args.includes("--name") && args.includes("plur1bus afterthought"));
    assert.ok(afterthoughtAdd, "legacy explicit-agent afterthought cron add call must be present");
    assert.ok(afterthoughtAdd.includes("--announce"), "legacy explicit-agent afterthought should still announce");
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

describe("runDeferredFeatureCronBootstrap marker gating", () => {
  it("is exported", () => {
    assert.strictEqual(typeof runDeferredFeatureCronBootstrap, "function");
  });

  it("writes the marker on a successful run (close code 0)", async () => {
    const baseDbPath = mkdtempSync(path.join(tmpdir(), "feature-cron-bootstrap-ok-"));
    const markerPath = path.join(baseDbPath, ".feature-crons-setup.json");
    const api = makeApi();

    await runDeferredFeatureCronBootstrap(api, {
      cfg: {},
      baseDbPath,
      spawnImpl: () => fakeChild({ stdout: JSON.stringify({ lastPlanCreateCount: 0 }), closeCode: 0 }),
    });

    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.strictEqual(marker.lastPlanCreateCount, 0);
    assert.ok(marker.lastRunAt, "marker should carry a fresh lastRunAt");
  });

  it("does not overwrite a previous marker when the spawned run fails (close code != 0)", async () => {
    const baseDbPath = mkdtempSync(path.join(tmpdir(), "feature-cron-bootstrap-fail-"));
    const markerPath = path.join(baseDbPath, ".feature-crons-setup.json");
    const previousMarker = { pluginVersion: PV, lastRunAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString(), lastPlanCreateCount: 0 };
    writeFileSync(markerPath, JSON.stringify(previousMarker, null, 2));
    const api = makeApi();

    await runDeferredFeatureCronBootstrap(api, {
      cfg: {},
      baseDbPath,
      spawnImpl: () => fakeChild({ stdout: "", closeCode: 1 }),
    });

    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.deepStrictEqual(marker, previousMarker, "marker must be untouched after a failed run");
  });

  it("does not write a marker at all when the spawned run fails and no marker existed before", async () => {
    const baseDbPath = mkdtempSync(path.join(tmpdir(), "feature-cron-bootstrap-fail-nomarker-"));
    const markerPath = path.join(baseDbPath, ".feature-crons-setup.json");
    const api = makeApi();

    await runDeferredFeatureCronBootstrap(api, {
      cfg: {},
      baseDbPath,
      spawnImpl: () => fakeChild({ stdout: "", emitError: true }),
    });

    assert.throws(() => readFileSync(markerPath, "utf8"), /ENOENT/);
  });
});

describe("runSetupFeatureCrons Message-Contract-Migration", () => {
  const OLD_CONTRACT =
    "/plur1bus internal afterthought\n\n" +
    "Delivery contract: the job returns JSON. If it has a `text` field, " +
    "send exactly that text as the message, verbatim, with no additional " +
    "commentary. If `skipped` is true, output NOTHING at all.";

  function implWithExistingOldContract({ editResult } = {}) {
    const cronEdits = [];
    const impl = (args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify({
            jobs: [
              { id: "at-main", agentId: "main", name: "plur1bus afterthought main", payload: { message: OLD_CONTRACT } },
              { id: "pe-main", agentId: "main", name: "plur1bus persona-evolve main", payload: { message: "/plur1bus internal persona-evolve" } },
            ],
          }),
          stderr: "",
          status: 0,
        };
      }
      if (args[0] === "agents" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify({ agents: [{ id: "main", bindings: 2, isDefault: true, workspace: "/ws/main" }] }),
          stderr: "",
          status: 0,
        };
      }
      if (args[0] === "cron" && args[1] === "edit") {
        cronEdits.push(args);
        return editResult ?? { ok: true, stdout: "{}", stderr: "", status: 0 };
      }
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    };
    return { impl, cronEdits };
  }

  it("führt cron edit für Jobs mit altem 'output NOTHING'-Contract aus (keine Creates nötig)", async () => {
    const { impl, cronEdits } = implWithExistingOldContract();
    const result = await runJsonSetupWith(impl);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(cronEdits.length, 1, "genau ein cron edit für den Alt-Contract-Job");
    assert.strictEqual(cronEdits[0][2], "at-main");
    const msgIdx = cronEdits[0].indexOf("--message");
    assert.ok(msgIdx > 0);
    assert.match(cronEdits[0][msgIdx + 1], /reply with exactly NO_REPLY/);
    assert.strictEqual(result.parsed.lastPlanCreateCount, 0);
  });

  it("dry-run plant das Update, ruft aber kein cron edit auf", async () => {
    const { impl, cronEdits } = implWithExistingOldContract();
    const result = await runJsonSetupWith(impl, ["--json", "--dry-run"]);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(cronEdits.length, 0);
    assert.strictEqual(result.parsed.plan.update.length, 1);
  });

  it("fehlgeschlagenes Update erhöht lastPlanCreateCount (Retry beim nächsten Lauf)", async () => {
    const { impl } = implWithExistingOldContract({ editResult: { ok: false, stdout: "", stderr: "edit failed", status: 1 } });
    const result = await runJsonSetupWith(impl);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.parsed.lastPlanCreateCount >= 1, "failed update zählt als pending");
  });
});
