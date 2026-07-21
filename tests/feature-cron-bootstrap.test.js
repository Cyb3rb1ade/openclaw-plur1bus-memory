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
import { buildAddArgs, runSetupFeatureCrons } from "../scripts/setup-feature-crons.mjs";

const NOW = Date.parse("2026-07-14T12:00:00Z");
const PV = "1.2.3";
const { parseFeatureCronBootstrapLastPlanCreateCount, runDeferredFeatureCronBootstrap } = pluginModule;

describe("featureCronSetup manifest documentation", () => {
  it("names every owner gate and the fail-closed delivery source contract", () => {
    const manifestPath = path.join(import.meta.dirname, "..", "openclaw.plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const description = manifest.configSchema.properties.featureCronSetup.description;

    for (const required of [
      "personaVoice.enabled && skillMiner.enabled",
      "afterthought.enabled && (skillMiner.enabled || merging.enabled)",
      "dailyConsolidation.enabled",
      "criticalPush.enabled",
      "rem-dream: merging.enabled",
      "skillMiner.enabled",
      "obsidianBridge.enabled && obsidianBridge.graphLinks.semanticDiscovery.enabled",
      "peer.id/defaultTo",
      "never allowFrom",
    ]) {
      assert.ok(description.includes(required), `manifest description must include ${required}`);
    }
  });
});

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
  const wrappedOpenClaw = (args, timeout) => {
    if (args.join(" ") === "gateway call config.get --json") {
      return {
        ok: true,
        stdout: JSON.stringify(validCronConfigSnapshot({
          pluginConfig: {
            personaVoice: { enabled: true },
            afterthought: { enabled: true },
            skillMiner: { enabled: true },
          },
          runtimeConfig: {},
        })),
        stderr: "",
        status: 0,
      };
    }
    return openclawImpl(args, timeout);
  };
  const exitCode = await runSetupFeatureCrons({ argv, openclawImpl: wrappedOpenClaw, stdout: stdout.stream, stderr: stderr.stream });
  const text = stdout.read().trim();
  return {
    exitCode,
    stdout: text,
    stderr: stderr.read(),
    parsed: JSON.parse(text),
  };
}

function validCronConfigSnapshot({ pluginConfig = {}, runtimeConfig = {} } = {}) {
  return {
    valid: true,
    sourceConfig: {
      plugins: {
        entries: {
          "memory-lancedb-namespaced": { config: pluginConfig },
        },
      },
    },
    runtimeConfig,
  };
}

describe("buildAddArgs delivery boundary", () => {
  it("pins delivery off when the plan has no validated delivery object", () => {
    const args = buildAddArgs({
      name: "plur1bus afterthought main",
      message: "/plur1bus internal afterthought",
      schedule: { kind: "every", everyMs: 30 * 60 * 1000 },
      needsDelivery: true,
      enabled: true,
      agent: "main",
      account: "legacy-account",
      delivery: null,
    });

    assert.ok(args.includes("--no-deliver"));
    assert.ok(!args.includes("--announce"));
    assert.ok(!args.includes("--account"));
    for (const forbidden of ["--model", "--fallbacks", "--token", "--auth", "--api-key", "--apiKey"]) {
      assert.ok(!args.includes(forbidden));
    }
  });
});

async function runJsonSetupDirect(openclawImpl, argv = ["--json"]) {
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const exitCode = await runSetupFeatureCrons({ argv, openclawImpl, stdout: stdout.stream, stderr: stderr.stream });
  const output = stdout.read().trim();
  return { exitCode, stdout: output, stderr: stderr.read(), parsed: JSON.parse(output) };
}

describe("runSetupFeatureCrons effective config snapshot", () => {
  it("loads exactly one redacted config snapshot before planning and separates source gates from runtime routing", async () => {
    const calls = [];
    const cronAdds = [];
    const snapshot = validCronConfigSnapshot({
      pluginConfig: { dailyConsolidation: { enabled: true } },
      runtimeConfig: {
        bindings: [{ agentId: "main", match: { channel: "telegram", peer: { kind: "group", id: "-100123" } } }],
        channels: { telegram: { defaultAccount: "default", accounts: { default: { enabled: true } } } },
      },
    });
    const result = await runJsonSetupDirect((args, timeout) => {
      calls.push({ args, timeout });
      if (args[0] === "--version") return { ok: true, stdout: "ok", stderr: "", status: 0 };
      if (args.join(" ") === "gateway call config.get --json") {
        return { ok: true, stdout: JSON.stringify(snapshot), stderr: "", status: 0 };
      }
      if (args[0] === "cron" && args[1] === "list") return { ok: true, stdout: '{"jobs":[]}', stderr: "", status: 0 };
      if (args[0] === "agents" && args[1] === "list") {
        return { ok: true, stdout: '{"agents":[{"id":"main","bindings":1,"isDefault":true,"workspace":"/ws/main"}]}', stderr: "", status: 0 };
      }
      if (args[0] === "cron" && args[1] === "add") {
        cronAdds.push(args);
        return { ok: true, stdout: "{}", stderr: "", status: 0 };
      }
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });

    assert.strictEqual(result.exitCode, 0);
    const configCalls = calls.filter(({ args }) => args.join(" ") === "gateway call config.get --json");
    assert.strictEqual(configCalls.length, 1);
    assert.strictEqual(configCalls[0].timeout, 15000);
    assert.strictEqual(cronAdds.length, 1);
    assert.ok(cronAdds[0].includes("plur1bus consolidate-daily main"));
  });

  it("fails closed and never reflects loader secrets for every invalid snapshot class", async () => {
    const secret = "SECRET_CANARY_B5";
    const failures = [
      { ok: false, stdout: secret, stderr: secret, status: 9, error: new Error(secret) },
      { ok: true, stdout: `{${secret}`, stderr: secret, status: 0 },
      { ok: true, stdout: JSON.stringify({ valid: false, issues: [{ message: secret }] }), stderr: secret, status: 0 },
      { ok: true, stdout: JSON.stringify({ valid: true, sourceConfig: [], runtimeConfig: { secret } }), stderr: secret, status: 0 },
    ];

    for (const configResult of failures) {
      const mutations = [];
      const result = await runJsonSetupDirect((args) => {
        if (args[0] === "--version") return { ok: true, stdout: "ok", stderr: "", status: 0 };
        if (args.join(" ") === "gateway call config.get --json") return configResult;
        if (args[0] === "cron") mutations.push(args);
        return { ok: false, stdout: secret, stderr: secret, status: 1 };
      });
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.parsed.reason, "config-load-failed");
      assert.deepStrictEqual(mutations, []);
      assert.ok(!result.stdout.includes(secret));
      assert.ok(!result.stderr.includes(secret));
    }
  });

  it("creates the exact seven per-agent jobs without model, auth, token, or API overrides", async () => {
    const cronAdds = [];
    const snapshot = validCronConfigSnapshot({
      pluginConfig: {
        personaVoice: { enabled: true },
        afterthought: { enabled: true },
        dailyConsolidation: { enabled: true },
        criticalPush: { enabled: true },
        merging: { enabled: true },
        skillMiner: { enabled: true, cron: "7 6 * * 2", timezone: null },
        obsidianBridge: {
          enabled: true,
          graphLinks: { semanticDiscovery: { enabled: true } },
        },
      },
      runtimeConfig: {
        bindings: [{
          agentId: "main",
          match: { channel: "telegram", accountId: "primary", peer: { kind: "group", id: "-100123" } },
        }],
        channels: { telegram: { accounts: { primary: { enabled: true, allowFrom: ["99999"] } } } },
      },
    });
    const result = await runJsonSetupDirect((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok", stderr: "", status: 0 };
      if (args.join(" ") === "gateway call config.get --json") return { ok: true, stdout: JSON.stringify(snapshot), stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") return { ok: true, stdout: '{"jobs":[]}', stderr: "", status: 0 };
      if (args[0] === "agents" && args[1] === "list") {
        return { ok: true, stdout: '{"agents":[{"id":"main","bindings":1,"isDefault":true,"workspace":"/ws/main"}]}', stderr: "", status: 0 };
      }
      if (args[0] === "cron" && args[1] === "add") {
        cronAdds.push(args);
        return { ok: true, stdout: "{}", stderr: "", status: 0 };
      }
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(cronAdds.length, 7);
    const byName = new Map(cronAdds.map((args) => [args[args.indexOf("--name") + 1], args]));
    assert.deepStrictEqual([...byName.keys()], [
      "plur1bus persona-evolve main",
      "plur1bus afterthought main",
      "plur1bus consolidate-daily main",
      "plur1bus classify-recent main",
      "plur1bus rem-dream main",
      "plur1bus skill-miner main",
      "plur1bus discover-semantic-links main",
    ]);
    for (const args of cronAdds) {
      assert.deepStrictEqual(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2), ["--agent", "main"]);
      assert.deepStrictEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), ["--session", "isolated"]);
      for (const forbidden of ["--model", "--fallbacks", "--token", "--auth", "--api-key", "--apiKey"]) {
        assert.ok(!args.includes(forbidden), `${byName.get(args)?.[0] || "job"} must not carry ${forbidden}`);
      }
    }

    const schedule = (name, flag) => {
      const args = byName.get(name);
      return args[args.indexOf(flag) + 1];
    };
    assert.strictEqual(schedule("plur1bus persona-evolve main", "--cron"), "15 4 * * 0");
    assert.strictEqual(schedule("plur1bus afterthought main", "--every"), "1800s");
    assert.strictEqual(schedule("plur1bus consolidate-daily main", "--cron"), "0 3 * * *");
    assert.strictEqual(schedule("plur1bus classify-recent main", "--every"), "1800s");
    assert.strictEqual(schedule("plur1bus rem-dream main", "--cron"), "15 1 * * *");
    assert.strictEqual(schedule("plur1bus rem-dream main", "--tz"), "Europe/Berlin");
    assert.strictEqual(schedule("plur1bus skill-miner main", "--cron"), "7 6 * * 2");
    assert.ok(!byName.get("plur1bus skill-miner main").includes("--tz"));
    assert.strictEqual(schedule("plur1bus discover-semantic-links main", "--cron"), "0 2 * * *");
    assert.strictEqual(schedule("plur1bus discover-semantic-links main", "--tz"), "Europe/Berlin");

    for (const name of ["plur1bus afterthought main", "plur1bus classify-recent main"]) {
      const args = byName.get(name);
      assert.ok(args.includes("--announce"));
      assert.deepStrictEqual(args.slice(args.indexOf("--to"), args.indexOf("--to") + 2), ["--to", "-100123"]);
      assert.deepStrictEqual(args.slice(args.indexOf("--account"), args.indexOf("--account") + 2), ["--account", "primary"]);
      assert.match(args[args.indexOf("--message") + 1], /NO_REPLY/);
    }
    for (const [name, args] of byName) {
      if (name.includes("afterthought") || name.includes("classify-recent")) continue;
      assert.ok(args.includes("--no-deliver"));
      assert.ok(!args.includes("--announce"));
    }
  });

  it("never provisions from feature flags that exist only in runtimeConfig", async () => {
    const unexpected = [];
    const runtimeOnlyFeatures = {
      plugins: {
        entries: {
          "memory-lancedb-namespaced": {
            config: {
              personaVoice: { enabled: true },
              afterthought: { enabled: true },
              dailyConsolidation: { enabled: true },
              criticalPush: { enabled: true },
              merging: { enabled: true },
              skillMiner: { enabled: true },
              obsidianBridge: {
                enabled: true,
                graphLinks: { semanticDiscovery: { enabled: true } },
              },
            },
          },
        },
      },
    };
    const result = await runJsonSetupDirect((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok", stderr: "", status: 0 };
      if (args.join(" ") === "gateway call config.get --json") {
        return {
          ok: true,
          stdout: JSON.stringify(validCronConfigSnapshot({ runtimeConfig: runtimeOnlyFeatures })),
          stderr: "",
          status: 0,
        };
      }
      unexpected.push(args);
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(unexpected, []);
    assert.deepStrictEqual(result.parsed.plan, { create: [], skip: [], update: [] });
  });

  it("rejects --account without --agent before any cron read or mutation", async () => {
    const unexpected = [];
    const result = await runJsonSetupDirect((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok", stderr: "", status: 0 };
      if (args.join(" ") === "gateway call config.get --json") {
        return {
          ok: true,
          stdout: JSON.stringify(validCronConfigSnapshot({ pluginConfig: { criticalPush: { enabled: true } } })),
          stderr: "",
          status: 0,
        };
      }
      unexpected.push(args);
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    }, ["--json", "--account", "primary"]);
    assert.strictEqual(result.parsed.reason, "agent-required");
    assert.deepStrictEqual(unexpected, []);
  });

  it("rejects missing, option-like, or invalid explicit agent/account values without cron access", async () => {
    const invalidArgv = [
      ["--json", "--agent"],
      ["--json", "--agent", "--account", "primary"],
      ["--json", "--agent", "../main"],
      ["--json", "--account"],
      ["--json", "--agent", "main", "--account", "--dry-run"],
      ["--json", "--agent", "main", "--account", "__OPENCLAW_REDACTED__"],
    ];

    for (const argv of invalidArgv) {
      const calls = [];
      const result = await runJsonSetupDirect((args) => {
        calls.push(args);
        if (args[0] === "--version") return { ok: true, stdout: "ok", stderr: "", status: 0 };
        return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
      }, argv);
      assert.strictEqual(result.parsed.reason, "invalid-arguments");
      assert.deepStrictEqual(calls, [["--version"]]);
    }
  });
});

describe("runSetupFeatureCrons --json", () => {
  it("prints one JSON object and exit 0 when the CLI is unavailable", async () => {
    const result = await runJsonSetupWith(() => ({ ok: false, stdout: "", stderr: "missing", status: 1 }));
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.parsed.lastPlanCreateCount, 7);
    assert.strictEqual(result.parsed.reason, "cli-unavailable");
  });

  it("prints one JSON object and exit 0 when cron list fails", async () => {
    const calls = [];
    const secret = "CRON_LIST_SECRET_B5";
    const result = await runJsonSetupWith((args) => {
      calls.push(args);
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") return { ok: false, stdout: secret, stderr: secret, status: 1 };
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.parsed.lastPlanCreateCount, 3);
    assert.strictEqual(result.parsed.reason, "cron-list-failed");
    assert.strictEqual(calls.length, 2);
    assert.ok(!result.stdout.includes(secret));
  });

  it("prints one JSON object and exit 0 when cron list JSON is unparseable", async () => {
    const secret = "CRON_PARSE_SECRET_B5";
    const result = await runJsonSetupWith((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") return { ok: true, stdout: `{${secret}`, stderr: "", status: 0 };
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.parsed.lastPlanCreateCount, 3);
    assert.strictEqual(result.parsed.reason, "cron-list-parse-failed");
    assert.ok(!result.stdout.includes(secret));
  });

  it("prints one JSON object and exit 0 on unexpected top-level errors", async () => {
    const secret = "UNEXPECTED_SECRET_B5";
    const result = await runJsonSetupWith(() => {
      throw new Error(secret);
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.parsed.lastPlanCreateCount, 7);
    assert.strictEqual(result.parsed.reason, "unexpected-error");
    assert.strictEqual(result.parsed.message, "unexpected setup failure");
    assert.ok(!result.stdout.includes(secret));
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

  it("emits --no-deliver for jobs planned without a delivery target (persona-evolve, disabled afterthought)", async () => {
    // Without an explicit delivery flag, `openclaw cron add` defaults the job
    // to announce -> channel "last". Isolated cron sessions have no "last
    // active chat", so that delivery fail-closes at runtime (observed on the
    // 2026-07-16 install: all three persona-evolve jobs were created with
    // "announce -> last (no route, will fail-closed)").
    const cronAdds = [];
    const result = await runJsonSetupWith((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") return { ok: true, stdout: JSON.stringify({ jobs: [] }), stderr: "", status: 0 };
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
    const personaAdd = cronAdds.find((args) => args.includes("plur1bus persona-evolve main"));
    assert.ok(personaAdd, "persona-evolve cron add call must be present");
    assert.ok(personaAdd.includes("--no-deliver"), "persona-evolve (needsDelivery: false) must pin delivery off");
    assert.ok(!personaAdd.includes("--announce"), "persona-evolve must not announce");
    const afterthoughtAdd = cronAdds.find((args) => args.includes("plur1bus afterthought main"));
    assert.ok(afterthoughtAdd, "afterthought cron add call must be present");
    assert.ok(afterthoughtAdd.includes("--no-deliver"), "disabled afterthought without target must pin delivery off");
  });

  it("does not emit --no-deliver when a delivery target is present", async () => {
    const cronAdds = [];
    await runJsonSetupWith((args) => {
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

    const afterthoughtAdd = cronAdds.find((args) => args.includes("plur1bus afterthought main"));
    assert.ok(afterthoughtAdd.includes("--announce"), "derivable delivery should announce");
    assert.ok(!afterthoughtAdd.includes("--no-deliver"), "announce jobs must not also pass --no-deliver");
  });

  it("repairs existing persona-evolve jobs with announce->last via cron edit --no-deliver", async () => {
    const cronEdits = [];
    const result = await runJsonSetupWith((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify({
            jobs: [
              {
                id: "job-p1",
                name: "plur1bus persona-evolve main",
                agentId: "main",
                payload: { message: "/plur1bus internal persona-evolve" },
                delivery: { mode: "announce", channel: "last" },
              },
              {
                id: "job-a1",
                name: "plur1bus afterthought main",
                agentId: "main",
                payload: { message: "/plur1bus internal afterthought" },
                delivery: { mode: "announce", channel: "telegram", to: "55736530" },
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
      if (args[0] === "cron" && args[1] === "edit") {
        cronEdits.push(args);
        return { ok: true, stdout: "{}", stderr: "", status: 0 };
      }
      if (args[0] === "cron" && args[1] === "add") return { ok: true, stdout: "{}", stderr: "", status: 0 };
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });

    assert.strictEqual(result.exitCode, 0);
    const noDeliverEdit = cronEdits.find((args) => args.includes("job-p1"));
    assert.ok(noDeliverEdit, "cron edit for the broken persona-evolve job must be issued");
    assert.ok(noDeliverEdit.includes("--no-deliver"), "edit must pin delivery off");
    assert.ok(!noDeliverEdit.includes("--message"), "delivery-only migration must not touch the message");
  });

  it("disables and removes delivery from an owned delivery job with an unsafe target", async () => {
    const cronEdits = [];
    const result = await runJsonSetupWith((args) => {
      if (args[0] === "--version") return { ok: true, stdout: "ok\n", stderr: "", status: 0 };
      if (args[0] === "cron" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify({
            jobs: [{
              id: "job-a2",
              name: "plur1bus afterthought main",
              agentId: "main",
              enabled: true,
              payload: { message: "/plur1bus internal afterthought" },
              delivery: { mode: "announce", channel: "last" },
            }],
          }),
          stderr: "",
          status: 0,
        };
      }
      if (args[0] === "agents" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify({ agents: [{ id: "main", bindings: 1, isDefault: true, workspace: "/ws/main" }] }),
          stderr: "",
          status: 0,
        };
      }
      if (args[0] === "cron" && args[1] === "edit") {
        cronEdits.push(args);
        return { ok: true, stdout: "{}", stderr: "", status: 0 };
      }
      if (args[0] === "cron" && args[1] === "add") return { ok: true, stdout: "{}", stderr: "", status: 0 };
      return { ok: false, stdout: "", stderr: "unexpected", status: 1 };
    });

    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(cronEdits, [["cron", "edit", "job-a2", "--disable", "--no-deliver"]]);
  });

  it("keeps explicit --agent afterthought disabled without a concrete delivery target", async () => {
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
    const afterthoughtAdd = cronAdds.find((args) => args.includes("--name") && args.includes("plur1bus afterthought main"));
    assert.ok(afterthoughtAdd, "explicit-agent afterthought cron add call must be present");
    assert.ok(afterthoughtAdd.includes("--disabled"));
    assert.ok(afterthoughtAdd.includes("--no-deliver"));
    assert.ok(!afterthoughtAdd.includes("--announce"));
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
              { id: "sm-main", agentId: "main", name: "plur1bus skill-miner main", payload: { message: "/plur1bus internal skill-miner" }, delivery: { mode: "none" } },
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
