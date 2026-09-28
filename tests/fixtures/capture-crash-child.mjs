/**
 * tests/fixtures/capture-crash-child.mjs — a process the capture replay tests
 * SIGKILL in the middle of one Engine.capture (tests/engine-capture-replay.test.js,
 * "crash window").
 *
 * argv[2] is JSON: { stateDir, config, turn, stopAt, stopAfter }.
 * The child builds an engine over those directories and captures `turn`.
 * When the pipeline reaches `stopAt` it writes `STOPPED\n` to stdout
 * (synchronously, so the parent sees it) and blocks its thread for good; the
 * parent then kills it. Both stop points are existing EngineInternals
 * members, overridden through `testOptions.internals`:
 *   - "rows-committed": `noteTableWrite`, called right after the store loop
 *     once every row's LanceDB commit resolved and before the replay guard
 *     marks the turn done — the crash window.
 *   - "row-classify": `classifyEmotionForStore`, called inside the store
 *     loop before each row is written; the child stops on call number
 *     `stopAfter + 1`, i.e. after `stopAfter` rows are committed (0: none).
 */
import { mkdirSync, writeSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../../engine/create-engine.js";
import { inferEmotionalValence } from "../../lib/emotion.js";
import { createStubHost } from "../../lib/host-services.js";
import { hashEmbedder } from "../helpers/hash-embedder.js";

const { stateDir, config, turn, stopAt, stopAfter = 0 } = JSON.parse(process.argv[2]);

const stop = () => {
  writeSync(1, "STOPPED\n");
  // Blocks this thread until the parent's SIGKILL: nothing after the stop
  // point runs, exactly like a process killed there.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const internals = { embeddings: hashEmbedder() };
if (stopAt === "rows-committed") {
  internals.noteTableWrite = stop;
} else if (stopAt === "row-classify") {
  let calls = 0;
  // The rows before the stop get the synchronous tier-1 valence, the same
  // shape the real classifier returns.
  internals.classifyEmotionForStore = async (text) => {
    if (calls++ >= stopAfter) stop();
    return { emotion: inferEmotionalValence(text), emotionStatus: "final" };
  };
} else {
  throw new Error(`unknown stopAt: ${stopAt}`);
}

const host = createStubHost({
  stateDir,
  workspaceDir: async (agentId) => {
    const dir = join(stateDir, "workspaces", agentId);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});
const engine = createEngine(host, config, { internals });
const result = await engine.capture({ ...turn, signal: new AbortController().signal }).done;
// Reaching this line means the stop point was never hit.
writeSync(1, `FINISHED ${JSON.stringify(result)}\n`);
await engine.close();
