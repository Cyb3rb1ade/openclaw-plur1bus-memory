import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { MemoryDB } from "../index.js";
import { normalizeWorkspaceTarget } from "../lib/memory-request-context.js";
import { recordOwnedVaultConfirmation } from "../lib/obsidian-vault-authority.js";

const AGENT_ID = "obsidian-runtime-agent";
const WORKSPACE_ID = "obsidian-runtime-workspace";
const WORKSPACE_PRINCIPAL = normalizeWorkspaceTarget(WORKSPACE_ID);
const VECTOR_DIMENSIONS = 384;

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

function memoryRecord(id, overrides = {}) {
  return {
    id,
    type: "memory",
    text: `Runtime Obsidian fixture ${id}`,
    summary: `Runtime Obsidian fixture ${id}`,
    category: "fact",
    importance: 0.8,
    createdAt: Date.now(),
    sourceTimestamp: Date.now(),
    scope: "agent-private",
    agentId: AGENT_ID,
    storedBy: AGENT_ID,
    workspaceId: WORKSPACE_PRINCIPAL,
    workspaceKey: WORKSPACE_PRINCIPAL,
    ownerUserId: "",
    status: "active",
    ...overrides,
  };
}

function memoryFile(vaultPath, id) {
  return join(vaultPath, "plur1bus", "memories", `${id}.md`);
}

async function waitFor(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeApi(baseDbPath, vaultPath, warnings) {
  const hooks = new Map();
  const services = [];
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIMENSIONS } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
      featureCronSetup: { auto: false },
      dailyConsolidation: { enabled: false },
      skillMiner: { enabled: false },
      dreaming: { enabled: false },
      obsidianBridge: {
        enabled: true,
        watch: true,
        mode: "apply",
        dryRun: false,
        allowWrite: true,
        workspaces: [{ workspace_id: WORKSPACE_ID, agent_id: AGENT_ID, path: vaultPath }],
      },
    },
    logger: {
      info: noop,
      warn(message) { warnings.push(String(message)); },
      error: noop,
      debug: noop,
    },
    runtime: {
      agent: {
        async resolveAgentWorkspaceDir(config) { return config?.workspaceDir || baseDbPath; },
      },
    },
    resolvePath: (value) => value,
    registerCommand: noop,
    registerTool: noop,
    registerService(service) { services.push(service); },
    on(event, handler) {
      const handlers = hooks.get(event) || [];
      handlers.push(handler);
      hooks.set(event, handlers);
    },
    _hooks: hooks,
    _services: services,
  };
}

function confirmVault(baseDbPath, vaultPath) {
  recordOwnedVaultConfirmation({
    baseDbPath,
    memoryCtx: { agentId: AGENT_ID, workspaceIdentity: WORKSPACE_PRINCIPAL },
    vaultPath,
    confirmationValidated: true,
    confirmationNonce: randomUUID(),
  });
}

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

describe("registered Obsidian bridge runtime wiring", () => {
  it("loads the authoritative read-only agent DB and mirrors only ACL-visible real memories", async () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-runtime-db-"));
    const vaultPath = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-runtime-vault-"));
    const openclawHome = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-runtime-home-"));
    mkdirSync(join(baseDbPath, AGENT_ID), { recursive: true });
    const oldHome = process.env.OPENCLAW_HOME;
    const oldStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_HOME = openclawHome;
    process.env.OPENCLAW_STATE_DIR = openclawHome;

    const ids = {
      private: "11111111-1111-4111-8111-111111111111",
      workspace: "22222222-2222-4222-8222-222222222222",
      foreignWorkspace: "33333333-3333-4333-8333-333333333333",
      foreignAgent: "44444444-4444-4444-8444-444444444444",
      user: "55555555-5555-4555-8555-555555555555",
      generated: "66666666-6666-4666-8666-666666666666",
    };
    const rows = [
      memoryRecord(ids.private),
      memoryRecord(ids.workspace, { scope: "workspace" }),
      memoryRecord(ids.foreignWorkspace, {
        scope: "workspace",
        workspaceId: normalizeWorkspaceTarget("other-workspace"),
        workspaceKey: normalizeWorkspaceTarget("other-workspace"),
      }),
      memoryRecord(ids.foreignAgent, { agentId: "other-agent", storedBy: "other-agent" }),
      memoryRecord(ids.user, { scope: "user", ownerUserId: `user:v1:${"a".repeat(64)}` }),
      memoryRecord(ids.generated, { scope: "workspace", type: "duplicate_candidate" }),
    ];
    const originalInit = MemoryDB.prototype.init;
    const originalScanActive = MemoryDB.prototype.scanActive;
    let scanCount = 0;
    let observedReadOnly = false;
    MemoryDB.prototype.init = async function initFixture() {
      observedReadOnly ||= this.readOnly === true;
      return true;
    };
    MemoryDB.prototype.scanActive = async function scanActiveFixture() {
      scanCount += 1;
      observedReadOnly ||= this.readOnly === true;
      return rows;
    };

    cleanups.push(async () => {
      MemoryDB.prototype.init = originalInit;
      MemoryDB.prototype.scanActive = originalScanActive;
      if (oldHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = oldHome;
      if (oldStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = oldStateDir;
      for (const path of [baseDbPath, vaultPath, openclawHome]) rmSync(path, { recursive: true, force: true });
    });

    const warnings = [];
    const api = makeApi(baseDbPath, vaultPath, warnings);
    confirmVault(baseDbPath, vaultPath);
    plugin.register(api, { importRouting: async () => routingCapability });
    const services = api._services.filter((service) => service.id === "plur1bus-obsidian-bridge");
    assert.equal(services.length, 1, "Obsidian must register exactly one host-managed service");
    const [service] = services;

    cleanups.push(() => service.stop());

    await service.start();
    await waitFor(() => existsSync(memoryFile(vaultPath, ids.workspace)), "workspace memory mirror");

    assert.equal(scanCount, 1);
    assert.equal(observedReadOnly, true, "background mirroring must lease the authoritative read-only DB");
    assert.equal(existsSync(memoryFile(vaultPath, ids.private)), true);
    assert.equal(existsSync(memoryFile(vaultPath, ids.workspace)), true);
    assert.equal(existsSync(memoryFile(vaultPath, ids.foreignWorkspace)), false);
    assert.equal(existsSync(memoryFile(vaultPath, ids.foreignAgent)), false);
    assert.equal(existsSync(memoryFile(vaultPath, ids.user)), false);
    assert.equal(existsSync(memoryFile(vaultPath, ids.generated)), false);
    assert.deepEqual(warnings.filter((message) => /obsidian/i.test(message)), []);
  });

  it("keeps authoritative loader failures visible and writes no memory mirror", async () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-runtime-fail-db-"));
    const vaultPath = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-runtime-fail-vault-"));
    const openclawHome = mkdtempSync(join(tmpdir(), "plur1bus-obsidian-runtime-fail-home-"));
    mkdirSync(join(baseDbPath, AGENT_ID), { recursive: true });
    const oldHome = process.env.OPENCLAW_HOME;
    const oldStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_HOME = openclawHome;
    process.env.OPENCLAW_STATE_DIR = openclawHome;
    const originalInit = MemoryDB.prototype.init;
    const originalScanActive = MemoryDB.prototype.scanActive;
    MemoryDB.prototype.init = async () => true;
    MemoryDB.prototype.scanActive = async () => { throw new Error("injected authoritative scan failure"); };

    cleanups.push(async () => {
      MemoryDB.prototype.init = originalInit;
      MemoryDB.prototype.scanActive = originalScanActive;
      if (oldHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = oldHome;
      if (oldStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = oldStateDir;
      for (const path of [baseDbPath, vaultPath, openclawHome]) rmSync(path, { recursive: true, force: true });
    });

    const warnings = [];
    const api = makeApi(baseDbPath, vaultPath, warnings);
    confirmVault(baseDbPath, vaultPath);
    plugin.register(api, { importRouting: async () => routingCapability });
    const services = api._services.filter((service) => service.id === "plur1bus-obsidian-bridge");
    assert.equal(services.length, 1, "Obsidian must register exactly one host-managed service");
    const [service] = services;
    cleanups.push(() => service.stop());

    await service.start();
    await waitFor(
      () => warnings.some((message) => message.includes("injected authoritative scan failure")),
      "visible authoritative scan failure",
    );

    assert.equal(existsSync(join(vaultPath, "plur1bus", "memories")), false);
  });
});

describe("MemoryDB active scan ownership projection", () => {
  it("preserves the fields required for ACL-safe and freshness-stable memory mirroring", () => {
    const db = new MemoryDB(join(tmpdir(), "plur1bus-active-scan-projection"), 4);
    const source = memoryRecord("77777777-7777-4777-8777-777777777777", {
      memoryKind: "memory",
      updatedAt: 101,
      versionCreatedAt: 102,
      sourceTimestamp: 103,
    });
    const normalized = db.normalizeActiveScanRow(source);
    for (const field of [
      "type",
      "agentId",
      "storedBy",
      "workspaceId",
      "workspaceKey",
      "memoryKind",
      "updatedAt",
      "versionCreatedAt",
      "sourceTimestamp",
    ]) {
      assert.equal(normalized[field], source[field], `${field} must survive normalization`);
    }

    let selected = [];
    const query = {
      where() { return this; },
      select(fields) { selected = fields; return this; },
    };
    db.table = { query: () => query };
    db.buildActiveScanQuery();
    for (const field of [
      "type",
      "agentId",
      "storedBy",
      "workspaceId",
      "workspaceKey",
      "memoryKind",
      "updatedAt",
      "versionCreatedAt",
      "sourceTimestamp",
    ]) {
      assert.ok(selected.includes(field), `${field} must be selected by active scans`);
    }
  });
});
