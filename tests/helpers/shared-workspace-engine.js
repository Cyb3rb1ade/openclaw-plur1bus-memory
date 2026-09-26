/**
 * tests/helpers/shared-workspace-engine.js — the two-workspace engine setup
 * E2's shared-copy tests share: two agents (anna, bernd) in one real
 * workspace directory, a third (carol) in a separate workspace, a flat
 * embedder so distinct captures never collide as duplicates, and the small
 * helpers those tests use to read back what the engine wrote to disk.
 *
 * Factored out of tests/engine-memory-shared-ops.test.js (E2 Task 4) when
 * tests/engine-memory-proposals.test.js (E2 Task 5) needed the same setup.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";

import { createEngine } from "../../engine/create-engine.js";
import { createStubHost } from "../../lib/host-services.js";
import { makeTempDir } from "./temp-dir.js";

/** Nested under its own temp root so a per-agent sibling directory of baseDbPath (e.g. `_tombstones`, `_proposals`) is per test. */
export function freshBaseDbPath(prefix) {
  return join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
}

export const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: true, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
  // Distinct facts with the flat embedder below.
  duplicateThreshold: 1.01,
});

export function flatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

export const USER_PRINCIPAL = `user:v1:${"a".repeat(64)}`;

// No `workspace` claim: the canonical identity of the host's real workspace
// directory wins (see tests/e1-memory-ops-write.test.js principalForDestructive).
export function principal(agentId, { user } = {}) {
  return { agentId, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved", ...(user ? { user } : {}) };
}

// anna and bernd share one real workspace directory (one workspace pool key);
// carol lives in another workspace.
export function twoWorkspaceHost(stateDir) {
  const shared = join(stateDir, "workspaces", "shared-ws");
  const other = join(stateDir, "workspaces", "other-ws");
  mkdirSync(shared, { recursive: true });
  mkdirSync(other, { recursive: true });
  return { host: createStubHost({ stateDir, workspaceDir: async (agentId) => (agentId === "carol" ? other : shared) }), workspaceDir: shared };
}

export const userAgent = { origin: "user", background: false };
export const cronAgent = { origin: "cron", background: true };

export async function seedAndGetId(engine, agentId, text, topic) {
  const p = principal(agentId);
  const outcome = await engine.capture({
    agentId,
    principal: p,
    agent: userAgent,
    messages: [{ role: "user", content: text }, { role: "assistant", content: "noted." }],
    sessionKey: `agent:${agentId}:main`,
    incognito: false,
    signal: AbortSignal.timeout(8_000),
  }).done;
  assert.equal(outcome.reason, undefined, `capture not skipped: ${outcome.reason}`);
  assert.ok(outcome.stored >= 1);
  const listed = await engine.memory.list({ topic }, p, userAgent);
  const card = listed.items.find((c) => c.scope === "agent-private" && c.text.includes(text.slice(0, 20)));
  assert.ok(card, `seeded card for '${topic}' is listed`);
  return card.id;
}

export function setup(prefix) {
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = freshBaseDbPath(prefix);
  const { host, workspaceDir } = twoWorkspaceHost(stateDir);
  const engine = createEngine(host, config(baseDbPath), { internals: { embeddings: flatEmbedder() } });
  return { stateDir, baseDbPath, workspaceDir, engine };
}

export const code = (c) => (err) => err.name === "MemoryOpError" && err.code === c;
export const deniedWith = (message) => (err) => err.name === "MemoryOpError" && err.code === "denied" && err.message === message;

export function auditLines(workspaceDir) {
  const file = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function archiveFiles(stateDir, agentId) {
  const dir = join(stateDir, "memory", "_archive", agentId);
  return existsSync(dir) ? readdirSync(dir) : [];
}

export function archiveCount(stateDir, agentId) {
  return archiveFiles(stateDir, agentId).length;
}
