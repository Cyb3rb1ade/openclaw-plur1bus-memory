/**
 * tests/engine-close-neo-worker.test.js — E5 Task 5: Engine.close() releases
 * the shared neo worker, so a host process can exit after close().
 *
 * The engine takes a ref-counted lease on the process-wide neo worker
 * (acquireSharedNeoWorkerRuntime); the last release closes it. A runtime the
 * OpenClaw adapter closed directly (gateway_stop) makes later releases no-ops.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createResourceCloser } from "../engine/lifecycle/close-resources.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: false, autoRecall: true,
  neo: { enabled: true }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
});

// A fixed 384-dimension vector: the stub-host engine never loads a real model.
function flatEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts) => texts.map(vector), shutdown: async () => {} };
}

function newEngine(prefix) {
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
  const host = createStubHost({
    stateDir,
    workspaceDir: async (agentId) => {
      const dir = join(stateDir, "workspaces", agentId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  return createEngine(host, config(baseDbPath), { internals: { embeddings: flatEmbedder() } });
}

const messagePorts = () => process.getActiveResourcesInfo().filter((r) => r === "MessagePort").length;

async function pollUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

describe("Engine.close() and the shared neo worker (E5 Task 5)", () => {
  it("close() terminates the neo worker", async () => {
    const baseline = messagePorts();
    const engine = newEngine("e5-neo-a-");
    const rt = internalsOf(engine).neoWorkerRuntime;
    assert.ok(rt, "neo is enabled, so the engine holds a runtime");
    rt.warmUp();
    assert.ok(messagePorts() > baseline, "the warmed worker holds a MessagePort");
    await engine.close({ budgetMs: 5_000 });
    assert.equal(rt.isClosed(), true);
    assert.ok(await pollUntil(() => messagePorts() <= baseline), `MessagePort count back to ${baseline} (now ${messagePorts()})`);
  });

  it("two engines share one worker until the last closes", async () => {
    const a = newEngine("e5-neo-b1-");
    const b = newEngine("e5-neo-b2-");
    const rt = internalsOf(a).neoWorkerRuntime;
    assert.equal(internalsOf(b).neoWorkerRuntime, rt, "one process-wide runtime");
    await a.close({ budgetMs: 5_000 });
    assert.equal(rt.isClosed(), false, "B still holds a lease");
    assert.equal(rt.warmUp(), true);
    await a.close({ budgetMs: 5_000 });
    assert.equal(rt.isClosed(), false, "a second close() of A does not release twice");
    await b.close({ budgetMs: 5_000 });
    assert.equal(rt.isClosed(), true, "the last lease closed the runtime");
  });

  it("a runtime closed by the adapter is not closed twice", async () => {
    const a = newEngine("e5-neo-c1-");
    const rtA = internalsOf(a).neoWorkerRuntime;
    await rtA.close(); // what the adapter's gateway_stop does
    const b = newEngine("e5-neo-c2-");
    const rtB = internalsOf(b).neoWorkerRuntime;
    assert.notEqual(rtB, rtA, "B gets a fresh runtime");
    assert.equal(rtB.isClosed(), false);
    await a.close({ budgetMs: 5_000 });
    assert.equal(rtB.isClosed(), false, "A's release does not touch B's runtime");
    await b.close({ budgetMs: 5_000 });
    assert.equal(rtB.isClosed(), true);
  });

  it("a failing neo worker release is logged like the other resources", async () => {
    const warned = [];
    const ok = { shutdown: async () => {} };
    const close = createResourceCloser({
      logger: { warn: (m) => warned.push(String(m)) },
      memoryDbAdapter: ok,
      pool: ok,
      flushMetrics: async () => {},
      llmResultCache: { close: async () => {} },
      neoWorker: { release: async () => { throw new Error("neo broke"); } },
    });
    await close();
    assert.deepEqual(warned, ["plur1bus-neo: worker release failed: neo broke"]);
  });

  it("the process exits after close with neo enabled", async () => {
    const dir = makeTempDir("e5-neo-exit-");
    const engineUrl = pathToFileURL(join(process.cwd(), "engine", "create-engine.js")).href;
    const hostUrl = pathToFileURL(join(process.cwd(), "lib", "host-services.js")).href;
    const file = join(dir, "exit-after-close.mjs");
    writeFileSync(file, `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createEngine } from ${JSON.stringify(engineUrl)};
import { createStubHost } from ${JSON.stringify(hostUrl)};

const dir = ${JSON.stringify(dir)};
const stateDir = join(dir, "state");
mkdirSync(stateDir, { recursive: true });
const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const one = async () => vector();
const embeddings = { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (t) => t.map(vector), shutdown: async () => {} };
const host = createStubHost({
  stateDir,
  workspaceDir: async (agentId) => { const d = join(stateDir, "workspaces", agentId); mkdirSync(d, { recursive: true }); return d; },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});
const engine = createEngine(host, ${JSON.stringify(config(join(dir, "lancedb-namespaced")))}, { internals: { embeddings } });
const principal = { agentId: "agent-exit", workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "inferred" };
await engine.recall({ query: "what happened while I was away", principal, agent: { origin: "user", background: false }, signal: AbortSignal.timeout(8_000) });
const warm = process.getActiveResourcesInfo().filter((r) => r === "MessagePort").length;
process.stdout.write(JSON.stringify({ warm }) + "\\n");
await engine.close({ budgetMs: 5_000 });
`);
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ timedOut: true }); }, 15_000);
      child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.ok(!result.timedOut, `process did not exit after close() (stdout: ${stdout.trim()})`);
    assert.equal(result.code, 0, `child exited with ${result.code}/${result.signal}: ${stderr.slice(-2_000)}`);
    const { warm } = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.ok(warm >= 1, "recall warmed the neo worker, so the exit proves close() released it");
  });
});
