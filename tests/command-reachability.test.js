import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VECTOR_DIM = 384;
const OWNER = "owner-user";
const OTHER_ALLOWED_USER = "other-allowed-user";
const CHAT_ID = "owner-chat";
const WORKSPACE_KEY = "workspace-a";

function makeApi(baseDbPath) {
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

function commandContext(workspaceDir, agentId, args, overrides = {}) {
  return {
    args,
    agentId,
    workspaceDir,
    workspaceKey: WORKSPACE_KEY,
    userId: OWNER,
    chatId: CHAT_ID,
    chatType: "private",
    ...overrides,
  };
}

function confirmationToken(text, command) {
  const match = String(text).match(new RegExp(`/${command} confirm ([0-9a-f-]+)`, "i"));
  assert.ok(match, `expected /${command} confirmation token, got: ${text}`);
  return match[1];
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
    originalEmbedPassage = localProvider.prototype.embedPassage;
    localProvider.prototype.embedPassage = async () => Array(VECTOR_DIM).fill(0.125);

    api = registerApi();
  });

  after(async () => {
    for (const registeredApi of registeredApis) await shutdownApi(registeredApi);
    if (localProvider && originalEmbedPassage) {
      localProvider.prototype.embedPassage = originalEmbedPassage;
    }
    if (previousOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousOpenclawHome;
    for (const dir of [baseDbPath, workspaceDir, openclawHome]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function registerApi() {
    const registeredApi = makeApi(baseDbPath);
    plugin.register(registeredApi);
    registeredApis.push(registeredApi);
    return registeredApi;
  }

  async function shutdownApi(registeredApi) {
    if (!registeredApi || shutdownApis.has(registeredApi)) return;
    for (const shutdown of registeredApi._shutdownHandlers || []) await shutdown();
    shutdownApis.add(registeredApi);
  }

  async function store(agentId, text, registeredApi = api) {
    const tools = registeredApi._toolFactory({
      agentId,
      workspaceDir,
      workspaceKey: WORKSPACE_KEY,
      userId: OWNER,
    });
    const storeTool = tools.find((tool) => tool.name === "memory_store");
    const result = await storeTool.execute(`seed-${agentId}`, { text, category: "fact" });
    assert.equal(result.details?.action, "stored", JSON.stringify(result));
    return result.details.id;
  }

  async function run(name, ctx, registeredApi = api) {
    const command = registeredApi._commands.find((entry) => entry.name === name);
    assert.ok(command, `${name} command must be registered`);
    return command.handler(ctx);
  }

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

    const denied = await run("forget", { ...baseCtx, userId: "not-allowed" });
    assert.match(denied.text, /allowed list/i);

    const initiated = await run("forget", baseCtx);
    assert.doesNotMatch(initiated.text, /summarizer is not defined|failed/i);
    const token = confirmationToken(initiated.text, "forget");

    const wrongUser = await run("forget", { ...baseCtx, args: `confirm ${token}`, userId: OTHER_ALLOWED_USER });
    assert.match(wrongUser.text, /security\.wrong_user/);

    const completed = await run("forget", { ...baseCtx, args: `confirm ${token}` });
    assert.match(completed.text, new RegExp(memoryId));
    assert.match(completed.text, /deleted|archiviert/i);

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
      { ...baseCtx, args: `confirm ${token}`, userId: OTHER_ALLOWED_USER },
      commandApi,
    );
    assert.match(wrongUser.text, /security\.wrong_user/);

    const completed = await run("correct", { ...baseCtx, args: `confirm ${token}` }, commandApi);
    assert.match(completed.text, new RegExp(memoryId));
    assert.match(completed.text, /updated|aktualisiert/i);

    const archiveDir = join(openclawHome, ".openclaw", "memory", "_archive", agentId);
    assert.ok(readdirSync(archiveDir).some((name) => name.endsWith(`-${memoryId}.json`)));
    const recalled = await run(
      "memory",
      commandContext(workspaceDir, agentId, "B1 corrected value"),
      commandApi,
    );
    assert.match(recalled.text, /B1 corrected value/);
  });
});
