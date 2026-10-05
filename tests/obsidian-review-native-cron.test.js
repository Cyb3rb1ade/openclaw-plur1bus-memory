// Obsidian-Reviews als native Command-Crons (7.18.11).
//
// Bis 7.18.10 entstanden morning-review/evening-review als agentTurn mit
// "/plur1bus obsidian …-review" im Prompt. Das Modell kann Plugin-Kommandos
// nicht ausfuehren; es improvisierte jeden Abend ein eigenes "Review"
// (date, df, ls), der Cron meldete trotzdem ok. Die Texte waren zudem fest
// deutsch und das Datum UTC ohne Wochentag.
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  OBSIDIAN_REVIEW_FEATURES,
  buildNativeFeatureCommandArgv,
  commandFromNativeFeaturePayload,
  featureCronCommand,
} from "../lib/setup/feature-cron-native.js";
import { findFeatureCronDelivery, planObsidianReviewCronMigrations } from "../lib/setup/feature-cron-plan.js";
import {
  createFeatureCronGatewayHandler,
  reviewCronSessionKey,
  validateFeatureCronRequest,
} from "../lib/setup/feature-cron-plugin-runtime.js";
import {
  eveningReviewSummary,
  handleObsidianBridgeCommand,
  reviewBundleSummary,
} from "../lib/obsidian-control-room.js";
import {
  buildWorkspaceReviewCronJobs,
  printMorningReviewCronCommand,
} from "../adapter/openclaw/obsidian-review-cron-commands.js";
import { runSetupFeatureCrons } from "../scripts/setup-feature-crons.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";

function responseCapture() {
  const calls = [];
  return { calls, respond: (...args) => calls.push(args) };
}

function nativeJob(agentId, feature, delivery = { mode: "announce", channel: "telegram", to: "10000001" }) {
  return {
    id: `job-${agentId}-${feature}`,
    agentId,
    enabled: true,
    payload: { kind: "command", argv: buildNativeFeatureCommandArgv({ agentId, feature, command: featureCronCommand(feature) }) },
    delivery,
  };
}

function agentTurnJob(overrides = {}) {
  return {
    id: "ed554412",
    name: "plur1bus-evening-review-main",
    agentId: "main",
    enabled: true,
    payload: { kind: "agentTurn", message: "Führe /plur1bus obsidian evening-review aus.\n\nWICHTIG: Formatiere …" },
    delivery: { mode: "announce", channel: "telegram", to: "10000001" },
    ...overrides,
  };
}

describe("native review feature crons", () => {
  it("maps review features to their obsidian command and back", () => {
    assert.deepStrictEqual([...OBSIDIAN_REVIEW_FEATURES], ["morning-review", "evening-review"]);
    assert.equal(featureCronCommand("evening-review"), "/plur1bus obsidian evening-review");
    assert.equal(featureCronCommand("gc-run"), "/plur1bus internal gc-run");
    const argv = buildNativeFeatureCommandArgv({ agentId: "main", feature: "evening-review", command: "/plur1bus obsidian evening-review" });
    assert.deepStrictEqual(argv.slice(-4), ["--agent", "main", "--feature", "evening-review"]);
    assert.equal(commandFromNativeFeaturePayload({ kind: "command", argv }, "main"), "/plur1bus obsidian evening-review");
    assert.throws(() => buildNativeFeatureCommandArgv({ agentId: "main", feature: "evening-review", command: "/plur1bus internal evening-review" }));
    assert.deepStrictEqual(validateFeatureCronRequest({ agentId: "main", feature: "morning-review" }), { agentId: "main", feature: "morning-review" });
  });

  it("binds the review to the direct chat of the job's delivery target", () => {
    const config = { bindings: [{ agentId: "bernhardine", match: { channel: "telegram", accountId: "bernhardine" } }] };
    assert.equal(reviewCronSessionKey("main", { channel: "telegram", to: "10000001" }, config), "agent:main:telegram:default:direct:10000001");
    assert.equal(reviewCronSessionKey("bernhardine", { channel: "telegram", to: "10000002" }, config), "agent:bernhardine:telegram:bernhardine:direct:10000002");
    assert.equal(reviewCronSessionKey("main", { channel: "telegram", to: "1", accountId: "ops" }, config), "agent:main:telegram:ops:direct:1");
    assert.equal(reviewCronSessionKey("main", null, config), null);
    assert.equal(reviewCronSessionKey("main", { channel: "telegram", to: "1:topic:2" }, config), null);
  });

  it("runs the review through the operator path in the name of that chat", async () => {
    const seen = [];
    const capture = responseCapture();
    const handler = createFeatureCronGatewayHandler({
      runFeatureCommand: async () => { throw new Error("internal path must not run reviews"); },
      runOperatorCommand: async (request) => { seen.push(request); return { text: "🌙 Evening review" }; },
      config: {},
    });
    const context = { cron: { list: async () => [nativeJob("main", "evening-review")] } };
    await handler({ params: { agentId: "main", feature: "evening-review" }, respond: capture.respond, context });
    assert.deepStrictEqual(seen, [{
      agentId: "main",
      sessionKey: "agent:main:telegram:default:direct:10000001",
      command: "/plur1bus obsidian evening-review",
    }]);
    assert.deepStrictEqual(capture.calls, [[true, { reply: { text: "🌙 Evening review" } }]]);
  });

  it("fails loudly instead of improvising when the review has no direct chat target", async () => {
    const capture = responseCapture();
    const handler = createFeatureCronGatewayHandler({
      runFeatureCommand: async () => ({ text: "x" }),
      runOperatorCommand: async () => ({ text: "x" }),
      config: {},
    });
    const context = { cron: { list: async () => [nativeJob("main", "morning-review", null)] } };
    await handler({ params: { agentId: "main", feature: "morning-review" }, respond: capture.respond, context });
    assert.equal(capture.calls[0][0], false);
    assert.match(capture.calls[0][2].message, /direct chat delivery target/);
  });
});

describe("agentTurn review migration", () => {
  it("migrates a prompt that names exactly one review command and has a direct target", () => {
    const [migration] = planObsidianReviewCronMigrations([agentTurnJob()]);
    assert.equal(migration.id, "ed554412");
    assert.deepStrictEqual(migration.commandArgv.slice(-4), ["--agent", "main", "--feature", "evening-review"]);
    const bare = planObsidianReviewCronMigrations([agentTurnJob({ payload: { kind: "agentTurn", message: "/plur1bus obsidian morning-review\n\nLies vorab …" } })]);
    assert.deepStrictEqual(bare[0].commandArgv.slice(-2), ["--feature", "morning-review"]);
  });

  it("leaves everything else untouched", () => {
    const jobs = [
      agentTurnJob({ delivery: { mode: "none" } }),
      agentTurnJob({ delivery: { mode: "announce", channel: "telegram", to: "last" } }),
      agentTurnJob({ agentId: "" }),
      agentTurnJob({ payload: { kind: "agentTurn", message: "/plur1bus obsidian morning-review und /plur1bus obsidian evening-review" } }),
      agentTurnJob({ payload: { kind: "agentTurn", message: "/plur1bus obsidian evening-reviewer" } }),
      agentTurnJob({ payload: { kind: "agentTurn", message: "Erstelle den Gas-Status" } }),
      nativeJob("main", "evening-review"),
    ];
    assert.deepStrictEqual(planObsidianReviewCronMigrations(jobs), []);
  });

  it("the bootstrap edits existing review jobs of the planned agents to the native runner", async () => {
    const calls = [];
    const jobs = [
      agentTurnJob(),
      agentTurnJob({ id: "foreign", name: "plur1bus-evening-review-other", agentId: "other" }),
    ];
    await runSetupFeatureCrons({
      argv: ["--json", "--agent", "main"],
      stdout: { write: () => true },
      probeNativeCronCommandDispatchImpl: () => ({ ready: true, status: "native-command" }),
      openclawImpl: (args) => {
        calls.push(args);
        if (args.join(" ") === "gateway call config.get --json") {
          return {
            ok: true,
            stdout: JSON.stringify({ valid: true, sourceConfig: { plugins: { entries: { "memory-lancedb-namespaced": { config: {} } } } }, runtimeConfig: {} }),
            stderr: "",
            status: 0,
          };
        }
        if (args.join(" ") === "cron list --json --all") return { ok: true, stdout: JSON.stringify({ jobs }), stderr: "", status: 0 };
        return { ok: true, stdout: "{}", stderr: "", status: 0 };
      },
    });
    const edits = calls.filter((args) => args[0] === "cron" && args[1] === "edit");
    const reviewEdits = edits.filter((args) => args[2] === "ed554412" || args[2] === "foreign");
    assert.equal(reviewEdits.length, 1);
    assert.equal(reviewEdits[0][2], "ed554412");
    const argv = JSON.parse(reviewEdits[0][reviewEdits[0].indexOf("--command-argv") + 1]);
    assert.deepStrictEqual(argv.slice(-4), ["--agent", "main", "--feature", "evening-review"]);
    assert.equal(reviewEdits[0].includes("--message"), false);
  });

  it("finds the delivery of the migrated job for the runtime", () => {
    const [migration] = planObsidianReviewCronMigrations([agentTurnJob()]);
    const migrated = { ...agentTurnJob(), payload: { kind: "command", argv: migration.commandArgv } };
    assert.deepStrictEqual(findFeatureCronDelivery([migrated], "main", "evening-review"), { channel: "telegram", to: "10000001" });
  });

  it("finds a native review job whose runner path uses Windows separators", () => {
    const migrated = {
      ...agentTurnJob(),
      payload: {
        kind: "command",
        argv: [
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Users\\ops\\.openclaw\\extensions\\memory-lancedb-namespaced\\scripts\\run-feature-cron.mjs",
          "--agent",
          "main",
          "--feature",
          "evening-review",
        ],
      },
    };
    assert.deepStrictEqual(findFeatureCronDelivery([migrated], "main", "evening-review"), { channel: "telegram", to: "10000001" });
  });

  it("generates native cron commands for new installations", () => {
    const plan = buildWorkspaceReviewCronJobs({}, {
      workspaces: [{ workspaceId: "main", agentId: "main", label: "Main" }],
      channel: "telegram",
      to: "10000001",
    });
    assert.equal(plan.jobs.length, 2);
    for (const job of plan.jobs) {
      assert.match(job.command, /--command-argv /);
      assert.match(job.command, /--feature\\",\\"(morning|evening)-review/);
      assert.doesNotMatch(job.command, /--message/);
    }
    assert.match(printMorningReviewCronCommand({}, { agentId: "heisenberg" }), /\\"--agent\\",\\"heisenberg\\",\\"--feature\\",\\"morning-review\\"/);
  });
});

describe("review summaries are localized", () => {
  const evening = {
    createdAt: "2026-10-03T16:00:00.000Z",
    pendingItems: 1,
    status: { maintenance: { label: "ok", count: 860 }, duplicates: { label: "warning", count: 14 } },
    blockedOrWarningItems: [{ severity: "warning", code: "generated_link_review" }],
  };

  it("renders German with weekday and local time by default", () => {
    const text = eveningReviewSummary(evening, { timeZone: "Europe/Berlin" });
    assert.match(text, /^🌙 Abend-Review — Samstag, 3\. Oktober 2026 um 18:00/);
    assert.match(text, /✅ Systemprüfung \(860\)/);
    assert.match(text, /⚠️ Duplikate \(14\)/);
    assert.match(text, /Dashboard-Link zu prüfen/);
    assert.match(text, /📋 1 Vorschlag wartet/);
  });

  it("renders English, falls back to English for unknown languages", () => {
    const text = eveningReviewSummary(evening, { lang: "en", timeZone: "Europe/Berlin" });
    assert.match(text, /^🌙 Evening review — Saturday, October 3, 2026/);
    assert.match(text, /Preview only · nothing saved yet/);
    assert.match(text, /✅ System check \(860\)/);
    assert.match(text, /📋 1 proposal waiting/);
    assert.doesNotMatch(text, /Bitte|Vorschlag|Abend/);
    const fr = eveningReviewSummary({ ...evening, pendingItems: 0 }, { lang: "fr-FR", timeZone: "Europe/Paris" });
    assert.match(fr, /Evening review — samedi 3 octobre 2026/);
    assert.match(fr, /No proposals pending/);
    assert.doesNotThrow(() => eveningReviewSummary(evening, { lang: "en", timeZone: "Not/AZone" }));
  });

  it("localizes the morning ReviewBundle summary", () => {
    const result = { status: "skipped_cooldown", createdAt: "2026-10-03T07:00:00.000Z", cooldownRemainingMs: 90_000, latestBundleId: "b1" };
    assert.match(reviewBundleSummary(result, "PLUR1BUS Morning Review", { lang: "en" }), /🌅 Morning review — .*\nShort pause: next bundle possible in 1m 30s\.\nExisting bundle/);
    assert.match(reviewBundleSummary(result, "PLUR1BUS Morning Review"), /🌅 Morgen-Review — .*\nKurze Pause/);
  });

  it("the command handler answers in the context language", async () => {
    const vault = makeTempDir("plur1bus-review-i18n-");
    mkdirSync(join(vault, "plur1bus"), { recursive: true });
    const identity = "workspace:v1:main";
    const result = await handleObsidianBridgeCommand(["evening-review"], {
      config: { vaultPath: vault, reviewRoot: "plur1bus", mode: "apply", allowWrite: true },
      baseDbPath: vault,
      memoryCtx: { agentId: "main", workspaceIdentity: identity, workspaceId: identity, userId: "owner", conversationPrincipal: "c", chatId: "owner", chatKind: "private" },
      commandCtx: { agentId: "main", userId: "owner", senderId: "owner", chatId: "owner", chatType: "private", chatKind: "private", lang: "en" },
      pluginConfig: { baseDbPath: vault, security: { allowedUserIds: ["owner"] }, language: "de" },
      vaultConfirmed: true,
      records: [],
      items: [],
    });
    assert.match(result.text, /Evening review/);
    assert.doesNotMatch(result.text, /Abend-Review/);
  });
});
