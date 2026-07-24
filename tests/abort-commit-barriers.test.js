import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { lightDream } from "../lib/dreaming/light-dream.js";
import { extractEpisodesFromTurns } from "../lib/episodes.js";
import { ContradictionDetector } from "../lib/contradiction-detector.js";
import {
  ensurePersonaVoiceSeed,
  evolvePersonaVoice,
  hasPersonaVoice,
  writePersonaVoice,
} from "../lib/persona-voice.js";

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function waitForStart(started) {
  return Promise.race([
    started.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
}

function makeTurns(count = 5) {
  const createdAt = new Date().toISOString();
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    agentId: "abort-agent",
    workspaceKey: "abort-workspace",
    role: index % 2 === 0 ? "user" : "assistant",
    content: index === 0
      ? "Bitte immer die wichtige Projektentscheidung und ihre Begruendung bewahren."
      : `Conversation turn ${index} contains enough narrative detail for extraction.`,
    createdAt,
  }));
}

function makeDreamHarness(t) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-dream-abort-barrier-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const writes = [];
  const memoryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  return {
    workspaceDir,
    writes,
    params: {
      turns: makeTurns(3),
      neoStore: {
        readReactions() { return []; },
        appendDreams() { writes.push("neo-dream"); },
        appendBehaviorCards() { writes.push("behavior-card"); },
      },
      db: {
        async search() {
          return [{ entry: { id: memoryId, memoryClass: "standard" }, score: 0.9 }];
        },
        async store() { writes.push("dream-memory"); },
        table: {
          query() {
            return {
              where() {
                return {
                  limit() {
                    return { async toArray() { return [{ id: memoryId, replayCount: 0, vector: [0.1] }]; } };
                  },
                };
              },
            };
          },
          async update() { writes.push("memory-strengthen"); },
        },
      },
      embeddings: { async embed() { return [0.1]; } },
      insightLlmCfg: { feature: "conversation-insights" },
      narrativeLlmCfg: { feature: "dream-narrative" },
      echoLlmCfg: { feature: "dream-echo" },
      personaLlmCfg: { feature: "persona-voice" },
      logger: { info() {}, warn() {} },
      workspaceDir,
    },
  };
}

test("light dream commits nothing when insight LLM ignores abort and succeeds late", async (t) => {
  const controller = new AbortController();
  const late = deferred();
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const { params, writes, workspaceDir } = makeDreamHarness(t);

  const pending = lightDream({
    ...params,
    signal: controller.signal,
    callLlm: async (_messages, cfg) => {
      assert.equal(cfg.feature, "conversation-insights");
      startedResolve();
      return late.promise;
    },
  });

  assert.equal(await waitForStart(started), true);
  controller.abort();
  late.resolve(JSON.stringify(["A durable project insight that would activate a memory."]));

  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(writes, []);
  assert.equal(existsSync(join(workspaceDir, ".dream-echoes.jsonl")), false);
  assert.equal(hasPersonaVoice(workspaceDir), false);
});

test("light dream blocks dream-memory, echo, Neo, and persona writes after later LLM aborts", async (t) => {
  for (const abortFeature of ["dream-narrative", "dream-echo", "persona-voice"]) {
    const controller = new AbortController();
    const late = deferred();
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const { params, writes, workspaceDir } = makeDreamHarness(t);
    params.db.search = async () => [];
    params.narrativeCfg = abortFeature === "persona-voice"
      ? null
      : { enabled: true, storeAsMemory: abortFeature === "dream-narrative" };
    params.personaSeedCfg = abortFeature === "persona-voice"
      ? { agentId: "abort-agent", lang: "de" }
      : null;

    const responses = {
      "conversation-insights": JSON.stringify(["A durable project insight for the dream."]),
      "dream-narrative": "A sufficiently long dream narrative crosses a quiet archive and returns with one clear project decision.",
      "dream-echo": JSON.stringify({ sentence: "Die Entscheidung ging mir noch einmal durch den Kopf.", topics: ["decision"] }),
      "persona-voice": "- kurze Saetze\n- freundlich direkt\n- Emoji-Palette: 🌿 ✨",
    };
    const pending = lightDream({
      ...params,
      signal: controller.signal,
      callLlm: async (_messages, cfg) => {
        if (cfg.feature === abortFeature) {
          startedResolve();
          return late.promise;
        }
        return responses[cfg.feature];
      },
    });

    assert.equal(await waitForStart(started), true, abortFeature);
    const writesBeforeAbort = writes.length;
    controller.abort();
    late.resolve(responses[abortFeature]);

    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(writes.length, writesBeforeAbort, abortFeature);
    assert.equal(existsSync(join(workspaceDir, ".dream-echoes.jsonl")), false, abortFeature);
    assert.equal(hasPersonaVoice(workspaceDir), false, abortFeature);
  }
});

test("episode extraction exposes no late result when its LLM ignores abort", async () => {
  const controller = new AbortController();
  const late = deferred();
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const pending = extractEpisodesFromTurns(makeTurns(), {
    agentId: "abort-agent",
    signal: controller.signal,
    llmCfg: { feature: "episode-extraction" },
    callLlm: async () => {
      startedResolve();
      return late.promise;
    },
  });

  assert.equal(await waitForStart(started), true);
  controller.abort();
  late.resolve(JSON.stringify({
    title: "Late episode",
    narrativeArc: "decision",
    turningPoint: "The late response",
    summary: "This must never reach the fire-and-forget commit continuation.",
  }));

  await assert.rejects(pending, { name: "AbortError" });
});

test("contradiction detection persists nothing when its LLM ignores abort", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-contradiction-abort-barrier-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const controller = new AbortController();
  const late = deferred();
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const detector = new ContradictionDetector({
    workspaceDir,
    logger: { warn() {} },
    llm: async () => {
      startedResolve();
      return late.promise;
    },
  });
  const pending = detector.findAndPersistContradictions([
    { id: "overlay-a", targetMemoryId: "memory-a", shiftType: "meaning", shiftDescription: "Production is required." },
    { id: "overlay-b", targetMemoryId: "memory-a", shiftType: "meaning", shiftDescription: "Production is forbidden." },
  ], { signal: controller.signal });

  assert.equal(await waitForStart(started), true);
  controller.abort();
  late.resolve("yes");

  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(existsSync(join(workspaceDir, "contradictions.jsonl")), false);
});

test("an aborted queued contradiction append does not poison the next append", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-contradiction-queue-abort-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const detector = new ContradictionDetector({ workspaceDir, logger: { warn() {}, debug() {} } });
  const gate = deferred();
  detector._writeQueue = gate.promise;
  const controller = new AbortController();
  const first = detector.persistContradiction({
    targetMemoryId: "memory-aborted",
    overlayA: "overlay-aborted-a",
    overlayB: "overlay-aborted-b",
  }, { signal: controller.signal });

  controller.abort();
  gate.resolve();
  await assert.rejects(first, { name: "AbortError" });

  await detector.persistContradiction({
    targetMemoryId: "memory-next",
    overlayA: "overlay-next-a",
    overlayB: "overlay-next-b",
  });

  const records = readFileSync(join(workspaceDir, "contradictions.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].targetMemoryId, "memory-next");
});

test("persona seed and evolution do not write after an abort-ignoring LLM resolves", async (t) => {
  for (const operation of ["seed", "evolution"]) {
    const workspaceDir = mkdtempSync(join(tmpdir(), `plur1bus-persona-${operation}-abort-`));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    if (operation === "evolution") {
      writePersonaVoice(workspaceDir, "- Kurze Saetze\n- Freundlich direkt\n- Emoji-Palette: 🌿 ✨");
    }
    const before = operation === "evolution"
      ? readFileSync(join(workspaceDir, "persona-voice.md"), "utf8")
      : null;
    const controller = new AbortController();
    const late = deferred();
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const callLlm = async () => {
      startedResolve();
      return late.promise;
    };
    const pending = operation === "seed"
      ? ensurePersonaVoiceSeed({
          workspaceDir,
          agentId: "abort-agent",
          llmCfg: { feature: "persona-voice" },
          callLlm,
          signal: controller.signal,
        })
      : evolvePersonaVoice({
          workspaceDir,
          outcomes: Array.from({ length: 12 }, (_, index) => ({
            timestamp: Date.now() - index,
            outcome: "confirmed_or_continued",
          })),
          llmCfg: { feature: "persona-voice" },
          callLlm,
          signal: controller.signal,
        });

    assert.equal(await waitForStart(started), true, operation);
    controller.abort();
    late.resolve(operation === "seed"
      ? "- Kurze Saetze\n- Freundlich direkt\n- Emoji-Palette: 🌿 ✨"
      : "- Neue Marotte: prueft zweimal.");
    await assert.rejects(pending, { name: "AbortError" });

    if (operation === "seed") {
      assert.equal(hasPersonaVoice(workspaceDir), false);
    } else {
      assert.equal(readFileSync(join(workspaceDir, "persona-voice.md"), "utf8"), before);
    }
  }
});
