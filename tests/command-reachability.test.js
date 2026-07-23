import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VECTOR_DIM = 384;
const OWNER = "owner-user";
const OTHER_ALLOWED_USER = "other-allowed-user";
const CHAT_ID = "owner-chat";
const WORKSPACE_KEY = "workspace-a";

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    return { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

function makeApi(baseDbPath, workspaceDir) {
  const commands = [];
  const shutdownHandlers = [];
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: false },
      emotion: { t3: { enabled: false } },
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
      security: {
        allowedUserIds: [OWNER, OTHER_ALLOWED_USER],
        allowedChatIds: [CHAT_ID],
      },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    runtime: {
      agent: {
        async resolveAgentWorkspaceDir() { return workspaceDir; },
      },
    },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool(factory) { this._toolFactory = factory; },
    registerService: noop,
    on(event, handler) {
      if (event === "gateway_stop") shutdownHandlers.push(handler);
    },
    _commands: commands,
    _shutdownHandlers: shutdownHandlers,
  };
}

function commandContext(_workspaceDir, agentId, args, {
  senderId = OWNER,
  routeChatId = CHAT_ID,
  ...overrides
} = {}) {
  return {
    args,
    agentId,
    senderId,
    channel: "telegram",
    accountId: "default",
    sessionKey: `agent:${agentId}:main`,
    from: `telegram:${routeChatId}`,
    to: `telegram:${routeChatId}`,
    config: {},
    getCurrentConversationBinding: () => null,
    ...overrides,
  };
}

function confirmationToken(text, command) {
  const match = String(text).match(new RegExp(`/${command} confirm ([0-9a-f-]+)`, "i"));
  assert.ok(match, `expected /${command} confirmation token, got: ${text}`);
  return match[1];
}

function destructiveOpEntries(workspaceDir) {
  const logPath = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("registered memory command reachability", () => {
  const registeredApis = [];
  const shutdownApis = new WeakSet();
  let api;
  let baseDbPath;
  let workspaceDir;
  let openclawHome;
  let previousOpenclawHome;
  let plugin;
  let localProvider;
  let originalEmbedQuery;
  let originalEmbedPassage;

  before(async () => {
    baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-b1-db-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b1-workspace-"));
    openclawHome = mkdtempSync(join(tmpdir(), "plur1bus-b1-home-"));
    previousOpenclawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;

    const [pluginModule, providerModule] = await Promise.all([
      import("../index.js"),
      import("../lib/providers/embedding-local-transformers.js"),
    ]);
    plugin = pluginModule.default;
    localProvider = providerModule.LocalTransformersEmbeddingProvider;
    originalEmbedQuery = localProvider.prototype.embedQuery;
    originalEmbedPassage = localProvider.prototype.embedPassage;
    localProvider.prototype.embedQuery = async () => Array(VECTOR_DIM).fill(0.125);
    localProvider.prototype.embedPassage = async () => Array(VECTOR_DIM).fill(0.125);

    api = registerApi();
  });

  after(async () => {
    for (const registeredApi of registeredApis) await shutdownApi(registeredApi);
    if (localProvider && originalEmbedQuery && originalEmbedPassage) {
      localProvider.prototype.embedQuery = originalEmbedQuery;
      localProvider.prototype.embedPassage = originalEmbedPassage;
    }
    if (previousOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousOpenclawHome;
    for (const dir of [baseDbPath, workspaceDir, openclawHome]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function registerApi() {
    const registeredApi = makeApi(baseDbPath, workspaceDir);
    plugin.register(registeredApi, { importRouting: async () => routingCapability });
    registeredApis.push(registeredApi);
    return registeredApi;
  }

  async function shutdownApi(registeredApi) {
    if (!registeredApi || shutdownApis.has(registeredApi)) return;
    for (const shutdown of registeredApi._shutdownHandlers || []) await shutdown();
    shutdownApis.add(registeredApi);
  }

  async function store(agentId, text, registeredApi = api, category = "fact") {
    const tools = registeredApi._toolFactory({
      agentId,
      workspaceDir,
      workspaceKey: WORKSPACE_KEY,
      userId: OWNER,
    });
    const storeTool = tools.find((tool) => tool.name === "memory_store");
    const result = await storeTool.execute(`seed-${agentId}`, { text, category });
    assert.equal(result.details?.action, "stored", JSON.stringify(result));
    return result.details.id;
  }

  async function run(name, ctx, registeredApi = api) {
    const command = registeredApi._commands.find((entry) => entry.name === name);
    assert.ok(command, `${name} command must be registered`);
    return command.handler(ctx);
  }

  it("validates the narrow routing importer registration seam before setup", () => {
    const rejectedApi = makeApi(baseDbPath, workspaceDir);
    assert.throws(
      () => plugin.register(rejectedApi, { importRouting: routingCapability }),
      /importRouting must be a function/,
    );
    assert.equal(rejectedApi._commands.length, 0);
  });

  it("keeps registered /memory recall working", async () => {
    const agentId = "b1-memory";
    await store(agentId, "B1 positive memory control");

    const result = await run("memory", commandContext(workspaceDir, agentId, "B1 positive memory control"));

    assert.match(result.text, /B1 positive memory control/);
    assert.doesNotMatch(result.text, /failed|summarizer is not defined/i);
  });

  it("takes registered /forget through candidate lookup and a user-bound archive-first confirmation", async () => {
    const agentId = "b1-forget";
    const memoryId = await store(agentId, "B1 forget reachability target");
    const baseCtx = commandContext(workspaceDir, agentId, "B1 forget reachability target");

    const denied = await run("forget", { ...baseCtx, senderId: "not-allowed" });
    assert.match(denied.text, /allowed list/i);

    const initiated = await run("forget", baseCtx);
    assert.doesNotMatch(initiated.text, /summarizer is not defined|failed/i);
    const token = confirmationToken(initiated.text, "forget");

    const wrongUser = await run("forget", { ...baseCtx, args: `confirm ${token}`, senderId: OTHER_ALLOWED_USER });
    assert.match(wrongUser.text, /security\.wrong_user/);

    const completed = await run("forget", { ...baseCtx, args: `confirm ${token}` });
    assert.match(completed.text, new RegExp(memoryId));
    assert.match(completed.text, /deleted|archiviert/i);
    assert.ok(destructiveOpEntries(workspaceDir).some((entry) => (
      entry.event === "memory.deleted" && entry.memoryId === memoryId
    )));

    const archiveDir = join(openclawHome, ".openclaw", "memory", "_archive", agentId);
    assert.ok(readdirSync(archiveDir).some((name) => name.endsWith(`-${memoryId}.json`)));
    const recalled = await run("memory", commandContext(workspaceDir, agentId, "B1 forget reachability target"));
    assert.match(recalled.text, /nothing found|no (?:memory|memories|matches)|keine (?:erinnerung|treffer)/i);
    assert.doesNotMatch(recalled.text, new RegExp(memoryId));
  });

  it("takes registered /correct through candidate lookup and a user-bound archive-first confirmation", async () => {
    const agentId = "b1-correct";
    const migrationApi = registerApi();
    const memoryId = await store(agentId, "B1 old correction target", migrationApi);
    const migrationRecall = await run(
      "memory",
      commandContext(workspaceDir, agentId, "B1 old correction target"),
      migrationApi,
    );
    assert.match(migrationRecall.text, /B1 old correction target/);
    await shutdownApi(migrationApi);

    const commandApi = registerApi();
    const baseCtx = commandContext(workspaceDir, agentId, "B1 old correction target -> B1 corrected value");

    const initiated = await run("correct", baseCtx, commandApi);
    assert.doesNotMatch(initiated.text, /summarizer is not defined|failed/i);
    const token = confirmationToken(initiated.text, "correct");

    const wrongUser = await run(
      "correct",
      { ...baseCtx, args: `confirm ${token}`, senderId: OTHER_ALLOWED_USER },
      commandApi,
    );
    assert.match(wrongUser.text, /security\.wrong_user/);

    const completed = await run("correct", { ...baseCtx, args: `confirm ${token}` }, commandApi);
    assert.match(completed.text, new RegExp(memoryId));
    assert.match(completed.text, /updated|aktualisiert/i);
    assert.ok(destructiveOpEntries(workspaceDir).some((entry) => (
      entry.event === "memory.updated" && entry.memoryId === memoryId
    )));

    const archiveDir = join(openclawHome, ".openclaw", "memory", "_archive", agentId);
    assert.ok(readdirSync(archiveDir).some((name) => name.endsWith(`-${memoryId}.json`)));
    const recalled = await run(
      "memory",
      commandContext(workspaceDir, agentId, "B1 corrected value"),
      commandApi,
    );
    assert.match(recalled.text, /B1 corrected value/);
  });

  it("registers /share and /teile aliases and shares a normal card without changing its source", async () => {
    const agentId = "b13-share";
    const memoryId = await store(agentId, "B13 workspace share target");
    const baseCtx = commandContext(workspaceDir, agentId, memoryId);
    const share = await run("share", baseCtx);
    assert.match(share.text, /shared|geteilt/i);
    assert.ok(share.text.includes(memoryId) === false, "the result exposes only the shared copy id");
    const teile = await run("teile", { ...baseCtx, args: memoryId });
    assert.match(teile.text, /shared|geteilt/i);
    const userShare = await run("share", { ...baseCtx, args: `${memoryId} --user` });
    assert.match(userShare.text, /shared|geteilt/i);
    const sourceStillActive = await run("memory", commandContext(workspaceDir, agentId, "B13 workspace share target"));
    assert.match(sourceStillActive.text, /B13 workspace share target/);
  });

  it("binds sensitive /share confirmation to the exact user and conversation", async () => {
    const agentId = "b13-share-sensitive";
    const memoryId = await store(agentId, "B13 sensitive share target", api, "secret");
    const baseCtx = commandContext(workspaceDir, agentId, memoryId);
    const initiated = await run("share", { ...baseCtx, args: `${memoryId} --user` });
    const token = confirmationToken(initiated.text, "share");
    assert.match(token, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    const colonSyntax = await run("share", { ...baseCtx, args: `confirm:${token}` });
    assert.match(colonSyntax.text, /usage|failed|fehlgeschlagen/i);
    assert.doesNotMatch(colonSyntax.text, /shared|geteilt/i);
    const extraSyntax = await run("share", { ...baseCtx, args: `confirm ${token} extra` });
    assert.match(extraSyntax.text, /usage|failed|fehlgeschlagen/i);
    assert.doesNotMatch(extraSyntax.text, /shared|geteilt/i);
    const wrongUser = await run("share", { ...baseCtx, args: `confirm ${token}`, senderId: OTHER_ALLOWED_USER });
    assert.match(wrongUser.text, /failed|fehlgeschlagen/i);
    const shortened = await run("share", { ...baseCtx, args: `confirm ${token.slice(0, 6)}` });
    assert.match(shortened.text, /failed|fehlgeschlagen/i);
    const completed = await run("teile", { ...baseCtx, args: `confirm ${token}` });
    assert.match(completed.text, /shared|geteilt/i);
    const replay = await run("share", { ...baseCtx, args: `confirm ${token}` });
    assert.match(replay.text, /failed|fehlgeschlagen/i);
  });
});
