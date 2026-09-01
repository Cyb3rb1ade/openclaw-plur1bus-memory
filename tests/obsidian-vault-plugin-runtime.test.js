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
