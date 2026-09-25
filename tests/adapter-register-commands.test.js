/**
 * tests/adapter-register-commands.test.js — PR-03g.
 *
 * The registered command set and its channel list are a published contract
 * (openclaw.plugin.json cliCommands, docs/compatibility-openclaw.md). This
 * pins the 15 plur1bus_* commands and the three top-level ones.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerChatCommands } from "../adapter/openclaw/register-commands.js";
import { t } from "../lib/i18n.js";
import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { readTombstonesFromRegistry } from "../lib/tombstone.js";
import { CORRECTION_PREVIEW_CHARS } from "../engine/runtime/constants.js";
import { makeQuerySummarizer } from "../engine/runtime/env-config.js";
import { applyEpistemicStatusToLanceDb } from "../engine/store/memory-db.js";
import {
  completePendingConfirmation, parseConfirmationCommand, rememberPendingConfirmation, resolveConfirmationIdentity,
} from "../engine/commands/command-helpers.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "adapter", "openclaw", "register-commands.js"), "utf8");

const PLUR1BUS_COMMANDS = [
  "plur1bus", "plur1bus_start", "plur1bus_temperament", "plur1bus_persona",
  "plur1bus_status", "plur1bus_doctor", "plur1bus_state", "plur1bus_enable",
  "plur1bus_disable", "plur1bus_memory", "plur1bus_forget", "plur1bus_correct",
  "plur1bus_critical", "plur1bus_dashboards", "plur1bus_conflicts",
];

describe("adapter/openclaw/register-commands", () => {
  it("exports a factory", () => {
    assert.equal(typeof registerChatCommands, "function");
  });

  it("registers every plur1bus_* command name", () => {
    for (const name of PLUR1BUS_COMMANDS) {
      assert.match(source, new RegExp(`name: "${name}"`), `${name} must survive the move`);
    }
  });

  it("keeps /state, /enable and /disable, and never registers /status", () => {
    assert.match(source, /name: "state"/);
    assert.match(source, /name: "enable"/);
    assert.match(source, /name: "disable"/);
    assert.doesNotMatch(source, /name: "status"/, "/status is reserved by OpenClaw");
  });

  it("returns the six command bodies the runner calls back into", () => {
    assert.match(source, /return \{[\s\S]*runMemoryCommand[\s\S]*runForgetCommand[\s\S]*runCorrectCommand[\s\S]*runCriticalCommand[\s\S]*runStatusCommand[\s\S]*runFeatureToggle[\s\S]*\}/);
  });

  it("also returns the four auth/locale helpers the runner thunks", () => {
    // PR-03f left ten thunks in index.js, not six: `checkAuth`,
    // `checkArgsLength`, `resolveDenialLocale` and
    // `resolveRegisteredMemoryContext` are declared inside the moved range
    // too, so index.js has to rebind all ten or the runner's thunks resolve
    // to `undefined` at command time.
    const returned = source.slice(source.lastIndexOf("  return {"));
    for (const name of [
      "runMemoryCommand", "runForgetCommand", "runCorrectCommand", "runCriticalCommand",
      "runStatusCommand", "runFeatureToggle", "checkArgsLength", "checkAuth",
      "resolveDenialLocale", "resolveRegisteredMemoryContext",
    ]) {
      assert.match(returned, new RegExp(`^\\s{4}${name},$`, "m"), `${name} must be rebindable by index.js`);
    }
  });
});

// ─── E1 Task 8: /forget, /correct and /share run their final effect through Engine.memory ───

const E1_AGENT = "agent-a";
const E1_OWNER = "owner-1";

const e1Routing = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    const match = /^(.*):thread:([^:]+)$/.exec(value);
    return match ? { baseSessionKey: match[1], threadId: match[2] } : { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

// A fixed 384-dimension vector: nothing ever loads a real model.
function e1FlatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

/** A direct Telegram chat, as the host hands it to a registered command handler. */
function e1DirectCommand(args) {
  return {
    args,
    agentId: E1_AGENT,
    accountId: "account-a",
    channel: "telegram",
    config: {},
    from: "telegram:direct:chat-a",
    senderId: E1_OWNER,
    sessionId: "session-a",
    sessionKey: `agent:${E1_AGENT}:telegram:account-a:direct:chat-a`,
    lang: "en",
  };
}

/**
 * A real engine (stub host, real LanceDB store under a fresh temp root, flat
 * embedder) and registerChatCommands wired from its internals — the same
 * objects adapter/openclaw/plugin.js hands over — with `engineMemory`
 * replaced by spies that record each call and then delegate to the real
 * engine.memory member.
 */
async function e1Harness() {
  const tmpRoot = makeTempDir("e1-t8-root-");
  const stateDir = join(tmpRoot, "state");
  const workspaceDir = join(tmpRoot, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const baseDbPath = join(tmpRoot, "lancedb-namespaced");
  const host = createStubHost({
    stateDir,
    workspaceDir: async () => workspaceDir,
    runtime: { agent: { resolveAgentWorkspaceDir: async () => workspaceDir } },
    routing: async () => e1Routing,
  });
  const engine = createEngine(host, {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: 384 } },
    autoCapture: false, autoRecall: false,
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
    duplicateThreshold: 1.01,
    security: { allowedUserIds: [E1_OWNER], allowedChatIds: ["chat-a"] },
  }, { internals: { embeddings: e1FlatEmbedder() } });
  const internals = internalsOf(engine);
  const calls = { forget: [], correct: [], share: [] };
  const engineMemory = Object.freeze({
    ...engine.memory,
    forget: async (...args) => { calls.forget.push(args); return engine.memory.forget(...args); },
    correct: async (...args) => { calls.correct.push(args); return engine.memory.correct(...args); },
    share: async (...args) => { calls.share.push(args); return engine.memory.share(...args); },
  });
  const commands = new Map();
  const api = { config: {}, registerCommand(spec) { commands.set(spec.name, spec); } };
  registerChatCommands({
    ...internals,
    CORRECTION_PREVIEW_CHARS,
    api,
    applyEpistemicStatusToLanceDb,
    completePendingConfirmation,
    engineMemory,
    host,
    makeQuerySummarizer,
    parseConfirmationCommand,
    registerPluginCommand: (spec) => api.registerCommand(spec),
    registeredShareCard: null,
    rememberPendingConfirmation,
    resolveConfirmationIdentity,
    runOperatorCommand: async () => ({ text: "" }),
    runPlur1busCommand: async () => ({ text: "" }),
  });
  const run = (name, args) => commands.get(name).handler(e1DirectCommand(args));
  const seed = async (text, topic) => {
    const principal = { agentId: E1_AGENT, channel: "telegram", accountId: "account-a", chat: { id: "chat-a", kind: "direct" }, trust: "proved" };
    const outcome = await engine.capture({
      agentId: E1_AGENT,
      principal,
      agent: { origin: "user", background: false },
      messages: [{ role: "user", content: text }, { role: "assistant", content: "noted." }],
      sessionKey: `agent:${E1_AGENT}:main`,
      incognito: false,
      signal: AbortSignal.timeout(8_000),
    }).done;
    assert.ok(outcome.stored >= 1, `seed stored a card (${outcome.reason ?? "ok"})`);
    const listed = await engine.memory.list({ topic }, principal, { origin: "user", background: false });
    assert.ok(listed.items.length >= 1, `seeded card is listed for topic ${topic}`);
    return listed.items[0].id;
  };
  const rawCard = (id) => internals.pool.withDb(E1_AGENT, (db) => db.getById(id));
  return { engine, internals, calls, run, seed, rawCard, baseDbPath, stateDir };
}

const tokenOf = (text, command) => {
  const match = String(text).match(new RegExp(`/${command} confirm ([0-9a-f-]+)`, "i"));
  assert.ok(match, `expected a /${command} confirmation token, got: ${text}`);
  return match[1];
};

describe("E1 Task 8: slash commands run their final effect through Engine.memory", () => {
  it("/forget confirm calls engine.memory.forget once with the command's principal and a user AgentContext", async () => {
    const { calls, run, seed, rawCard, baseDbPath } = await e1Harness();
    const id = await seed("My favourite tea is a smoky lapsang souchong.", "tea");
    const initiated = await run("forget", "favourite tea lapsang");
    const token = tokenOf(initiated.text, "forget");
    assert.equal(calls.forget.length, 0, "initiation must not forget anything");

    const done = await run("forget", `confirm ${token}`);
    assert.equal(done.text, t("plur1bus.forget_done", { lang: "en", vars: { id } }));
    assert.equal(calls.forget.length, 1);
    const [targetId, principal, agentContext] = calls.forget[0];
    assert.equal(targetId, id);
    assert.equal(principal.agentId, E1_AGENT);
    assert.equal(principal.trust, "proved", "a host-resolved command context is the proved identity");
    assert.equal(agentContext.origin, "user");
    assert.equal(agentContext.background, false);
    assert.equal((await rawCard(id)).status, "deleted");
    assert.ok(readTombstonesFromRegistry(baseDbPath, E1_AGENT).some((row) => row.status === "committed"), "a committed tombstone exists");
  });

  it("/correct confirm runs through engine.memory.correct and keeps the safeUpdate write (summary, evidence, reinforcement)", async () => {
    const { calls, run, seed, rawCard } = await e1Harness();
    const id = await seed("The office wifi password rotates every Monday morning.", "wifi");
    const initiated = await run("correct", "office wifi rotates -> The office wifi password rotates every Friday evening.");
    const token = tokenOf(initiated.text, "correct");

    const done = await run("correct", `confirm ${token}`);
    assert.equal(done.text, t("plur1bus.correct_done", { lang: "en", vars: { id } }));
    assert.equal(calls.correct.length, 1);
    const [targetId, newText, principal, agentContext] = calls.correct[0];
    assert.equal(targetId, id);
    assert.equal(newText, "The office wifi password rotates every Friday evening.");
    assert.equal(principal.agentId, E1_AGENT);
    assert.equal(agentContext.origin, "user");

    const old = await rawCard(id);
    assert.equal(old.status, "superseded");
    const replacement = await rawCard(old.supersededBy);
    assert.equal(replacement.status, "active");
    assert.equal(replacement.text, "The office wifi password rotates every Friday evening.");
    assert.equal(replacement.summary, "The office wifi password rotates every Friday evening.", "safeUpdate re-derives the summary from the new text");
    assert.match(replacement.updateEvidence, /^User corrected "The office wifi password rotates every Monday morning\.?" to "The office wifi password rotates every Friday evening\."$/);
    assert.ok(Number(replacement.retrievalCount) >= 1, "the corrected card is reinforced");
  });

  it("/forget confirm maps a not-found refusal to the forget_not_found reply", async () => {
    const { run, seed, rawCard, internals } = await e1Harness();
    const id = await seed("Parking is on level minus two, spot forty one.", "parking");
    const token = tokenOf((await run("forget", "parking level spot")).text, "forget");
    // The card becomes non-live between initiation and confirmation.
    await internals.pool.withDb(E1_AGENT, (db) => db.update(id, { status: "superseded" }));
    const reply = await run("forget", `confirm ${token}`);
    assert.equal(reply.text, t("plur1bus.forget_not_found", { lang: "en", vars: { query: id } }));
    assert.equal((await rawCard(id)).status, "superseded", "nothing was forgotten");
  });

  it("/share runs through engine.memory.share with the command's proved principal", async () => {
    const { calls, run, seed } = await e1Harness();
    const id = await seed("The team standup moved to half past nine.", "standup");
    const shared = await run("share", id);
    assert.match(shared.text, /^✅ Shared\. ID: [0-9a-f-]{36}$/);
    assert.equal(calls.share.length, 1);
    const [sourceId, target, principal, agentContext, opts] = calls.share[0];
    assert.equal(sourceId, id);
    assert.equal(target, "workspace");
    assert.equal(principal.trust, "proved");
    assert.equal(agentContext.origin, "user");
    assert.equal(opts?.allowSensitive, false);

    const missing = await run("share", "66666666-6666-4666-8666-666666666666");
    assert.equal(missing.text, t("plur1bus.share_not_found", { lang: "en" }));
  });
});
