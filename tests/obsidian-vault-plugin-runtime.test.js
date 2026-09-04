import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  OBSIDIAN_VAULT_CLI_COMMAND,
  OBSIDIAN_VAULT_GATEWAY_METHODS,
  adoptExistingVault,
  createObsidianVaultHandlers,
  createVault,
  describeVaultCandidates,
  isObsidianVault,
  normalizeVaultPath,
  registerObsidianVaultRuntime,
} from "../lib/setup/obsidian-vault-plugin-runtime.js";
import { DEFAULT_WS_SUFFIXES, detectObsidianVaults, listWorkspaceDirectories } from "../lib/setup/feature-profiles.js";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-vault-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeVault(base, name) {
  const vaultPath = join(base, name);
  mkdirSync(join(vaultPath, ".obsidian"), { recursive: true });
  writeFileSync(join(vaultPath, ".obsidian", "app.json"), "{}\n");
  return vaultPath;
}

describe("Obsidian vault path handling", () => {
  it("rejects empty, relative-only, and root-like paths", () => {
    assert.throws(() => normalizeVaultPath(""), /vault path is required/);
    assert.throws(() => normalizeVaultPath("   "), /vault path is required/);
    assert.throws(() => normalizeVaultPath("/"), /filesystem root/);
    assert.throws(() => normalizeVaultPath("/tmp"), /filesystem root/);
  });

  it("recognises a vault only by its Obsidian marker files", (t) => {
    const base = tempDir(t);
    const plain = join(base, "plain");
    mkdirSync(plain, { recursive: true });
    assert.equal(isObsidianVault(plain), false);
    assert.equal(isObsidianVault(makeVault(base, "real")), true);
  });

  it("creates a vault Obsidian recognises and stays idempotent", (t) => {
    const base = tempDir(t);
    const target = join(base, "Neu");
    const first = createVault(target);
    assert.equal(first.created, true);
    assert.equal(existsSync(join(target, ".obsidian", "app.json")), true);
    assert.equal(isObsidianVault(target), true);

    // Running the installer twice must not overwrite an existing vault.
    const second = createVault(target);
    assert.equal(second.created, false);
    assert.equal(second.vaultPath, first.vaultPath);
  });

  it("refuses to adopt a directory that is not a vault", (t) => {
    const base = tempDir(t);
    const plain = join(base, "notavault");
    mkdirSync(plain, { recursive: true });
    assert.throws(() => adoptExistingVault(plain), /no Obsidian vault at/);
    assert.throws(() => adoptExistingVault(join(base, "missing")), /does not exist/);
    const real = makeVault(base, "real");
    assert.deepEqual(adoptExistingVault(real), { vaultPath: real, created: false });
  });

  it("reports whether the operator has to choose or only to create", (t) => {
    const base = tempDir(t);
    const vault = makeVault(base, "Bestand");
    const withVault = describeVaultCandidates({ workspaces: [{ path: vault }] });
    assert.equal(withVault.obsidianDetected, true);
    assert.deepEqual(withVault.vaultPaths, [vault]);
    assert.equal(withVault.nextAction, "choose_existing_or_create");

    const without = describeVaultCandidates({ workspaces: [{ path: join(base, "leer") }] });
    assert.equal(without.obsidianDetected, false);
    assert.equal(without.nextAction, "create");
  });
});

describe("Obsidian vault confirmation handlers", () => {
  const memoryCtx = {
    userId: "u-1",
    conversationPrincipal: "chat-1",
    agentId: "agent-1",
    workspaceIdentity: "workspace:v1:agent-1",
  };

  function handlersFor(t, base) {
    return createObsidianVaultHandlers({
      baseDbPath: base,
      confirmationStore: new Map(),
      resolveSessionMemoryContext: async () => memoryCtx,
      getObsidianBridgeConfig: () => ({ workspaces: [{ path: join(base, "Bestand") }] }),
    });
  }

  it("hands out a one-time confirmation instead of writing a receipt", async (t) => {
    const base = tempDir(t);
    const vault = makeVault(base, "Bestand");
    const handlers = handlersFor(t, base);
    const prepared = await handlers.prepare({ vaultPath: vault });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.created, false);
    assert.equal(prepared.vaultPath, vault);
    assert.ok(prepared.callbackData, "prepare returns the callback the confirm step needs");
  });

  it("creates the vault when asked to and reports that it did", async (t) => {
    const base = tempDir(t);
    const handlers = handlersFor(t, base);
    const target = join(base, "Frisch");
    const prepared = await handlers.prepare({ vaultPath: target, create: true });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.created, true);
    assert.equal(isObsidianVault(target), true);
  });

  it("rejects a confirmation that was never prepared", async (t) => {
    const base = tempDir(t);
    const vault = makeVault(base, "Bestand");
    const handlers = handlersFor(t, base);
    const result = await handlers.confirm({ vaultPath: vault, callbackData: "nonsense" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /invalid_format|not_found_or_expired/);
  });

  it("detects candidates without touching the filesystem state", async (t) => {
    const base = tempDir(t);
    makeVault(base, "Bestand");
    const handlers = handlersFor(t, base);
    const detected = await handlers.detect();
    assert.equal(detected.obsidianDetected, true);
    assert.equal(detected.nextAction, "choose_existing_or_create");
  });
});

describe("Obsidian vault runtime registration", () => {
  it("registers three scoped gateway methods and one operator CLI", () => {
    const gatewayMethods = [];
    const clis = [];
    registerObsidianVaultRuntime({
      api: {
        registerGatewayMethod: (...args) => gatewayMethods.push(args),
        registerCli: (builder, options) => clis.push({ builder, options }),
        logger: { warn() {} },
      },
      baseDbPath: "/tmp",
      confirmationStore: new Map(),
      resolveSessionMemoryContext: async () => ({}),
      getObsidianBridgeConfig: () => ({}),
      loadGatewayRuntime: async () => ({ callGatewayFromCli: async () => ({}) }),
    });

    assert.deepEqual(
      gatewayMethods.map(([name]) => name),
      [
        OBSIDIAN_VAULT_GATEWAY_METHODS.detect,
        OBSIDIAN_VAULT_GATEWAY_METHODS.prepare,
        OBSIDIAN_VAULT_GATEWAY_METHODS.confirm,
      ],
    );
    // Detection is a read; adopting or creating a vault writes a receipt.
    assert.deepEqual(gatewayMethods.map(([, , opts]) => opts.scope),
      ["operator.read", "operator.write", "operator.write"]);
    assert.equal(clis.length, 1);
    assert.equal(clis[0].options.descriptors[0].name, OBSIDIAN_VAULT_CLI_COMMAND);
  });

  it("refuses to register without the Gateway and CLI capabilities", () => {
    assert.throws(
      () => registerObsidianVaultRuntime({ api: { registerCli() {} }, baseDbPath: "/tmp" }),
      /registerGatewayMethod capability unavailable/,
    );
    assert.throws(
      () => registerObsidianVaultRuntime({ api: { registerGatewayMethod() {} }, baseDbPath: "/tmp" }),
      /registerCli capability unavailable/,
    );
  });
});

describe("vault detection across agent workspaces", () => {
  it("probes every workspace directory under the OpenClaw home when nothing is configured", (t) => {
    const base = tempDir(t);
    makeVault(base, "workspace");
    makeVault(base, "workspace-bernhardine");
    mkdirSync(join(base, "workspace-heisenberg"), { recursive: true });
    mkdirSync(join(base, "workspaces-not-an-agent"), { recursive: true });
    const previous = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = base;
    try {
      assert.deepEqual(listWorkspaceDirectories(base), ["workspace", "workspace-bernhardine", "workspace-heisenberg"]);
      const detected = detectObsidianVaults({});
      assert.deepEqual(detected.vaultPaths, [join(base, "workspace"), join(base, "workspace-bernhardine")]);
      assert.equal(detected.detected, true);
      // An explicit list still wins over the directory probe.
      const explicit = detectObsidianVaults({ workspaces: [{ path: join(base, "workspace-bernhardine") }] });
      assert.deepEqual(explicit.vaultPaths, [join(base, "workspace-bernhardine")]);
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_HOME; else process.env.OPENCLAW_HOME = previous;
    }
    assert.deepEqual(listWorkspaceDirectories(join(base, "missing")), DEFAULT_WS_SUFFIXES, "an unreadable home falls back to the default suffix");
  });
});

describe("Obsidian vault gateway parameter shapes", () => {
  it("unwraps the host's method context and maps the CLI's `session` to a session key with its agent", async (t) => {
    const base = tempDir(t);
    const vault = makeVault(base, "Bestand");
    const seen = [];
    const handlers = createObsidianVaultHandlers({
      baseDbPath: base,
      confirmationStore: new Map(),
      resolveSessionMemoryContext: async (params) => {
        seen.push({ sessionKey: params.sessionKey, agentId: params.agentId });
        return { userId: "u-1", conversationPrincipal: "chat-1", agentId: params.agentId, workspaceIdentity: `workspace:v1:${params.agentId}` };
      },
      getObsidianBridgeConfig: () => ({ workspaces: [{ path: vault }] }),
    });
    // The host calls a gateway method with one context object, the CLI names the key `session`.
    const prepared = await handlers.prepare({ params: { session: "agent:heisenberg:main:heartbeat", vaultPath: vault }, respond() {} });
    assert.equal(prepared.ok, true);
    assert.deepEqual(seen.at(-1), { sessionKey: "agent:heisenberg:main:heartbeat", agentId: "heisenberg" });
    const confirmed = await handlers.confirm({ params: { session: "agent:heisenberg:main:heartbeat", vaultPath: vault, callbackData: prepared.callbackData } });
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    assert.deepEqual(seen.at(-1), { sessionKey: "agent:heisenberg:main:heartbeat", agentId: "heisenberg" });
    // Plain params with an explicit agent id keep working.
    await handlers.prepare({ sessionKey: "agent:main:main:heartbeat", agentId: "main", vaultPath: vault });
    assert.deepEqual(seen.at(-1), { sessionKey: "agent:main:main:heartbeat", agentId: "main" });
  });
});
