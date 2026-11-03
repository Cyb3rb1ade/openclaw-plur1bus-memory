/**
 * tests/engine-reembedding-validate.test.js — contract 1.17.0
 * `admin.reembedding.validate`:
 *   - the facade passes the call to the coordinator unchanged;
 *   - plan → apply → validate on a real temp LanceDB store reaches
 *     `ready_to_switch` with a stub target provider (no model load);
 *   - a failed validation (probe error, recall miss) rejects and leaves the
 *     record in `validating`, never `ready_to_switch`.
 *
 * The switch itself is the host's (out of scope here): the store's active
 * generation and embedding stay untouched by every step below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createEngine } from "../engine/create-engine.js";
import { normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";
import { EMBEDDINGGEMMA2_EMBEDDING_PROFILE } from "../lib/providers/local-model-artifacts.js";
import { embeddingFingerprintFromNormalizedConfig } from "../lib/reembedding/runtime-config.js";
import { createStubHost } from "../lib/host-services.js";
import { config, flatEmbedder, freshBaseDbPath, seedAndGetId, twoWorkspaceHost } from "./helpers/shared-workspace-engine.js";
import { prepareEngineSharedBase } from "./helpers/win32-shared-owner.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const TIMEOUT = { timeout: 120_000 };
const AGENT = "anna";
const target = () => ({
  fingerprint: embeddingFingerprintFromNormalizedConfig(normalizeEmbeddingConfig({
    provider: "local-transformers",
    local: { model: EMBEDDINGGEMMA2_EMBEDDING_PROFILE.model },
  })),
});

const oneHot = (dimensions, index) => Array.from({ length: dimensions }, (_, i) => (i === index ? 1 : 0));

/** Every text gets the same unit vector of the target width: the validation memory is always recalled. */
function flatTargetProvider(overrides = {}) {
  return ({ fingerprint }) => {
    const vector = () => oneHot(fingerprint.dimensions, 0);
    return {
      embed: async () => vector(),
      embedQuery: async () => vector(),
      embedPassage: async () => vector(),
      embedBatch: async (texts) => texts.map(vector),
      shutdown: async () => {},
      ...overrides,
    };
  };
}

/** Each passage gets its own axis; a query is closer to every other memory than to its own, so it is never recalled. */
function missingTargetProvider() {
  return ({ fingerprint }) => {
    const axes = new Map();
    const passage = (text) => {
      if (!axes.has(text)) axes.set(text, axes.size);
      return oneHot(fingerprint.dimensions, axes.get(text));
    };
    const query = (text) => {
      const others = [...axes].filter(([t]) => t !== text).map(([, axis]) => axis);
      const scale = 1 / Math.sqrt(others.length);
      return Array.from({ length: fingerprint.dimensions }, (_, i) => (others.includes(i) ? scale : 0));
    };
    return {
      embed: async (text) => query(text),
      embedQuery: async (text) => query(text),
      embedPassage: async (text) => passage(text),
      embedBatch: async (texts) => texts.map(passage),
      shutdown: async () => {},
    };
  };
}

function engineWith(prefix, reembeddingTargetProvider) {
  const stateDir = makeTempDir(`${prefix}state-`);
  const { host } = twoWorkspaceHost(stateDir);
  return prepareEngineSharedBase(createEngine(host, config(freshBaseDbPath(prefix)), {
    internals: { embeddings: flatEmbedder(), reembeddingTargetProvider },
  }));
}

async function seed(engine, count) {
  for (let i = 0; i < count; i += 1) {
    await seedAndGetId(engine, AGENT, `VALIDATE_SENTINEL fact number ${i} about the lighthouse keeper`, `fact number ${i}`);
  }
}

async function planAndCopy(engine, id) {
  const reembedding = engine.admin.reembedding;
  const planned = await reembedding.plan({ id, target: target() });
  assert.equal(planned.record.state, "planned");
  let record = await reembedding.apply({ id, token: planned.confirmation.token });
  for (let i = 0; i < 20 && record.state === "running"; i += 1) {
    record = await reembedding.resume({ id, token: planned.confirmation.token });
  }
  assert.equal(record.state, "validating");
  return record;
}

describe("admin.reembedding.validate (contract 1.17.0)", () => {
  it("is on the facade and reaches the coordinator with its argument", async () => {
    const calls = [];
    const coordinator = {
      plan: async () => null, apply: async () => null, resume: async () => null, status: async () => null,
      validate: async (...args) => { calls.push(args); return { id: "m1", state: "ready_to_switch" }; },
      shutdown: async () => {},
    };
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("rv-facade-state-") }), config(makeTempDir("rv-facade-db-")), {
      internals: { embeddings: flatEmbedder(), reembeddingCoordinator: coordinator },
    });
    try {
      assert.equal(engine.contract, "1.17.0");
      assert.equal(typeof engine.admin.reembedding.validate, "function");
      assert.deepEqual(await engine.admin.reembedding.validate({ id: "m1" }), { id: "m1", state: "ready_to_switch" });
      assert.deepEqual(calls, [[{ id: "m1" }]]);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("plan → apply → validate reaches ready_to_switch on a store with data", TIMEOUT, async () => {
    const engine = engineWith("rv-ready-", flatTargetProvider());
    try {
      await seed(engine, 2);
      await planAndCopy(engine, "migration-validate-ready");
      const ready = await engine.admin.reembedding.validate({ id: "migration-validate-ready" });
      assert.equal(ready.state, "ready_to_switch");
      assert.equal(ready.receipts.validation.semanticRecall, true);
      assert.equal(ready.receipts.validation.rows, 2);
      assert.equal((await engine.admin.reembedding.status("migration-validate-ready")).state, "ready_to_switch");
      // Validation switches nothing: recall still answers from the active (source) generation.
      const listed = await engine.memory.list({ topic: "lighthouse keeper" }, { agentId: AGENT, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" }, { origin: "user", background: false });
      assert.ok(listed.items.length >= 2);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("a probe that fails rejects and leaves the record in validating", TIMEOUT, async () => {
    const engine = engineWith("rv-probe-", flatTargetProvider({
      embedQuery: async () => { throw new Error("target provider probe failed"); },
    }));
    try {
      await seed(engine, 1);
      await planAndCopy(engine, "migration-validate-probe");
      await assert.rejects(engine.admin.reembedding.validate({ id: "migration-validate-probe" }), /target provider probe failed/);
      assert.equal((await engine.admin.reembedding.status("migration-validate-probe")).state, "validating");
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("a target generation that does not recall the validation memory never reaches ready_to_switch", TIMEOUT, async () => {
    const engine = engineWith("rv-miss-", missingTargetProvider());
    try {
      await seed(engine, 6);
      await planAndCopy(engine, "migration-validate-miss");
      await assert.rejects(
        engine.admin.reembedding.validate({ id: "migration-validate-miss" }),
        /did not recall the source validation memory/,
      );
      const record = await engine.admin.reembedding.status("migration-validate-miss");
      assert.equal(record.state, "validating");
      assert.equal(record.receipts.validation, undefined);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("an agent table without memories validates on the generation check alone", TIMEOUT, async () => {
    const engine = engineWith("rv-empty-", flatTargetProvider({
      embedQuery: async () => { throw new Error("an empty source must not be probed"); },
    }));
    try {
      await engine.open(AGENT);
      const record = await planAndCopy(engine, "migration-validate-empty");
      assert.ok(record.source.tables.length >= 1, "the agent's table is part of the plan");
      assert.ok(record.source.tables.every((t) => t.rowCount === 0));
      const ready = await engine.admin.reembedding.validate({ id: "migration-validate-empty" });
      assert.equal(ready.state, "ready_to_switch");
      assert.equal(ready.receipts.validation.rows, 0);
      assert.equal(ready.receipts.validation.validationMemoryId, null);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("validate before the copy is finished is refused", TIMEOUT, async () => {
    const engine = engineWith("rv-early-", flatTargetProvider());
    try {
      await seed(engine, 1);
      await engine.admin.reembedding.plan({ id: "migration-validate-early", target: target() });
      await assert.rejects(engine.admin.reembedding.validate({ id: "migration-validate-early" }), /requires validating state; found planned/);
      await assert.rejects(engine.admin.reembedding.validate({ id: "missing" }), /not found/);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });
});
