import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { checkAccess } from "../lib/acl-middleware.js";
import { createStubHost } from "../lib/host-services.js";
import { memoryContextFromPrincipal } from "../engine/identity/principal.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const AGENT = "lens-reader";
const WORKSPACE = "workspace:v1:lens-reader";
const user = (label) => `user:v1:${createHash("sha256").update(label).digest("hex")}`;
const OWNER = user("synthetic-lens-owner");
const FOREIGN_OWNER = user("synthetic-other-owner");
const vector = (axis = 0) => Array.from({ length: 384 }, (_, i) => Number(i === axis));
const roleFields = {
  bridge: "bridgeMemoryIds",
  representative: "representativeMemoryIds",
  faded: "fadedCandidateMemoryIds",
};

function ownershipCases(scope) {
  if (scope === "user") return {
    allowed: { scope, storedBy: AGENT, ownerUserId: OWNER },
    denied: [
      { scope, storedBy: AGENT, ownerUserId: FOREIGN_OWNER },
      { scope, storedBy: AGENT },
      { scope, storedBy: AGENT, ownerUserId: "malformed-user" },
      { scope, agentId: AGENT, storedBy: "other-agent", ownerUserId: OWNER },
    ],
  };
  if (scope === "workspace") return {
    allowed: { scope, storedBy: AGENT, workspaceId: WORKSPACE, workspaceKey: WORKSPACE },
    denied: [
      { scope, storedBy: AGENT, workspaceId: "workspace:v1:other" },
      { scope, storedBy: AGENT },
      { scope, storedBy: AGENT, workspaceId: "unmapped-workspace" },
      { scope, storedBy: AGENT, workspaceId: WORKSPACE, workspaceKey: "workspace:v1:other" },
    ],
  };
  return {
    allowed: { scope, agentId: AGENT, storedBy: AGENT },
    denied: [
      { scope, agentId: "other-agent", storedBy: "other-agent" },
      { scope },
      { scope, agentId: AGENT, storedBy: "../invalid-agent" },
      { scope, agentId: AGENT, storedBy: "other-agent" },
    ],
  };
}

async function fixture(t, scope, role, mode) {
  const root = makeTempDir("engine-lens-acl-");
  const workspaceDir = join(root, "workspace");
  mkdirSync(join(workspaceDir, ".plur1bus"), { recursive: true });
  const logs = [];
  const logger = Object.fromEntries(["info", "warn", "error", "debug"].map((level) => [level, (message) => logs.push(String(message))]));
  const embeddings = {
    embed: async () => vector(), embedQuery: async () => vector(),
    embedPassage: async () => vector(), embedBatch: async (texts) => texts.map(() => vector()),
    shutdown: async () => {},
  };
  const engine = createEngine(createStubHost({
    stateDir: join(root, "state"), workspaceDir: async () => workspaceDir, logger,
  }), {
    baseDbPath: join(root, "db"),
    embedding: { provider: "local-transformers", local: { dimensions: 384 } },
    autoCapture: false, autoRecall: true, autoRecallMinScore: 0.8,
    neo: { enabled: false, workspaces: [{ path: workspaceDir, workspaceKey: WORKSPACE }] },
    gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    personaVoice: { enabled: false }, temporalContext: { enabled: false },
    conversationReactivationRecall: { enabled: false }, replyOutcomeTracking: { enabled: false },
    reranker: { enabled: false },
    recall: { semanticCompression: { enabled: false }, decisionTrace: { enabled: true, includeInPrompt: true } },
    semanticLens: {
      ...(mode === "default" ? {} : { enabled: mode === "on" }),
      maxLensMemories: 1, maxBridgeMemories: 1, maxFadedMemories: 1, timeoutMs: 2_000,
    },
    runtime: { recallTimeoutMs: 10_000 },
  }, { internals: { embeddings } });
  t.after(() => engine.close({ budgetMs: 5_000 }));
  const principal = { agentId: AGENT, workspace: WORKSPACE, user: OWNER, channel: "telegram", accountId: "default", chat: { id: "lens-chat", kind: "direct" }, trust: "proved" };
  const internals = internalsOf(engine);
  const memoryCtx = memoryContextFromPrincipal(principal, { workspaceDir, workspaceAliases: internals.memoryWorkspaceAliases });
  const base = { id: randomUUID(), text: "Orchard irrigation planning uses the northern reservoir.", storedBy: AGENT, scope: "agent-private", vector: vector() };
  const ownership = ownershipCases(scope);
  const denied = ownership.denied.map((binding, index) => ({
    id: randomUUID(), text: `Orchard irrigation forbidden-detail-${index}.`, vector: vector(1), ...binding,
  }));
  const allowed = { id: randomUUID(), text: "Orchard irrigation authorized-detail uses drip hoses.", vector: vector(1), ...ownership.allowed };
  await internals.pool.withWriteDb(AGENT, async (db) => {
    await db.init();
    for (const row of [base, ...denied, allowed]) {
      await db.store({ category: "fact", createdAt: Date.now(), ...row });
      const stored = await db.getById(row.id);
      assert.equal(checkAccess(memoryCtx, stored).allowed, row === base || row === allowed, "fixture exercises canonical ACL on persisted raw rows");
    }
  });
  const ids = [...denied, allowed].map((row) => row.id);
  writeFileSync(join(workspaceDir, ".plur1bus", "semantic-lens-index.json"), JSON.stringify({
    version: 1, memoryToCommunity: { [base.id]: "orchard" },
    communities: { orchard: { id: "orchard", [roleFields[role]]: ids } },
  }));
  const result = await engine.recall({ query: "How was orchard irrigation planning arranged?", principal, agent: { origin: "user", background: false }, signal: AbortSignal.timeout(10_000) });
  const ledger = internals.getNeoStore({ agentId: AGENT, workspaceDir }, {}).readRetrievalLedger();
  return { result, ledger, logs, base, allowed, denied };
}

describe("Engine.recall Semantic Lens ownership boundary (#276)", () => {
  for (const mode of ["default", "on", "off"]) {
    for (const scope of ["user", "agent-private", "workspace"]) {
      for (const role of Object.keys(roleFields)) {
        it(`${mode}: ${scope} ${role} hydration rejects denied rows before consuming the single slot`, async (t) => {
          const { result, ledger, logs, base, allowed, denied } = await fixture(t, scope, role, mode);
          assert.equal(result.degraded, null);
          const context = result.blocks.map((block) => block.text).join("\n");
          assert.ok(context.includes(base.id), "normal authorized recall remains present");
          for (const row of denied) {
            for (const visible of [context, JSON.stringify(ledger), logs.join("\n")]) {
              assert.ok(!visible.includes(row.id), "denied IDs never reach context, trace, ledger or logs");
              assert.ok(!visible.includes(row.text), "denied content never reaches observable output");
            }
          }
          assert.equal(context.includes(allowed.id), mode !== "off", "denials preserve the role and total allowance for the next authorized row");
          assert.equal(context.includes("authorized-detail"), mode !== "off");
          assert.ok(ledger.some((entry) => entry.selectedIds.includes(base.id)), "the real retrieval ledger records the authorized base recall");
        });
      }
    }
  }
});
