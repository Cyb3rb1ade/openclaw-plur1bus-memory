/**
 * Child process for tests/engine-memory-import-concurrency.test.js.
 * argv: <baseDbPath> <stateDir> <agentId> <key...>
 * Prints "ready" once the engine is up, waits for "go" on stdin, imports, and
 * prints one JSON line with the result. Temp dirs only; stub host; no network.
 */

import { createEngine } from "../../engine/create-engine.js";
import { createStubHost } from "../../lib/host-services.js";

const [baseDbPath, stateDir, agentId, ...keys] = process.argv.slice(2);
const hardStop = setTimeout(() => { process.stderr.write("child timeout\n"); process.exit(3); }, 60_000);
hardStop.unref();

const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const wait = () => new Promise((r) => setTimeout(r, 15));
const one = async () => { await wait(); return vector(); };
const embeddings = {
  embed: one, embedQuery: one, embedPassage: one,
  embedBatch: async (texts) => { await wait(); return texts.map(vector); },
  shutdown: async () => {},
};

const engine = createEngine(createStubHost({ stateDir }), {
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: false, autoRecall: false,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  duplicateThreshold: 1.01,
}, { internals: { embeddings } });

const principal = { agentId, workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };

process.stdout.write("ready\n");
await new Promise((resolve) => {
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    if (buf.includes("go")) resolve();
  });
});
try {
  const result = await engine.memory.import({
    agentId,
    principal,
    cards: keys.map((key) => ({ idempotencyKey: key, text: `Imported fact for ${key}.`, provenance: "imported" })),
  }, principal, { origin: "system", background: false });
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: err?.code || "error" })}\n`);
} finally {
  await engine.close({ budgetMs: 5_000 });
  process.exit(0);
}
