/**
 * tests/engine-store-schema.test.js — E2 Task 2: store schema version marker
 * and admin.migrate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import {
  schemaMarkerPath,
  readStoreSchemaVersion,
  writeStoreSchemaMarker,
} from "../engine/store/schema-version.js";

const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: false, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
});

const userAgent = { origin: "user", background: false };

describe("store schema marker (engine wiring)", () => {
  it("a fresh baseDbPath starts current: marker written, status().storeSchema is { current: '1', expected: '1' }", async () => {
    const baseDbPath = join(makeTempDir("ess-fresh-"), "lancedb-namespaced");
    assert.equal(existsSync(baseDbPath), false);
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ess-state-") }), config(baseDbPath));
    try {
      const markerPath = schemaMarkerPath(baseDbPath);
      assert.equal(existsSync(markerPath), true);
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      assert.equal(marker.schemaVersion, "1");
      assert.deepEqual((await engine.status()).storeSchema, { current: "1", expected: "1" });
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("a pre-existing legacy store (no marker) starts at 0; admin.migrate advances it and rejects out-of-range calls", async () => {
    const baseDbPath = join(makeTempDir("ess-legacy-"), "lancedb-namespaced");
    mkdirSync(baseDbPath, { recursive: true });
    writeFileSync(join(baseDbPath, "some-legacy-file.txt"), "pretend this is an old store");

    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ess-state-") }), config(baseDbPath));
    try {
      assert.deepEqual((await engine.status()).storeSchema, { current: "0", expected: "1" });

      const result = await engine.admin.migrate("0", "1");
      assert.deepEqual(result, { from: "0", to: "1", applied: true });
      const marker = JSON.parse(readFileSync(schemaMarkerPath(baseDbPath), "utf8"));
      assert.equal(marker.schemaVersion, "1");
      assert.deepEqual((await engine.status()).storeSchema, { current: "1", expected: "1" });

      await assert.rejects(engine.admin.migrate("0", "1"), (e) => e.code === "conflict");
      assert.deepEqual(await engine.admin.migrate("1", "1"), { from: "1", to: "1", applied: false });
      await assert.rejects(engine.admin.migrate("1", "0"), (e) => e.code === "invalid-input");
      await assert.rejects(engine.admin.migrate("1", "2"), (e) => e.code === "invalid-input");
      await assert.rejects(engine.admin.migrate("x", "1"), (e) => e.code === "invalid-input");
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("an unparsable marker file reports current: null and migrate() rejects storage", async () => {
    const baseDbPath = join(makeTempDir("ess-broken-"), "lancedb-namespaced");
    mkdirSync(baseDbPath, { recursive: true });
    writeFileSync(schemaMarkerPath(baseDbPath), "not json");

    const engine = createEngine(createStubHost({ stateDir: makeTempDir("ess-state-") }), config(baseDbPath));
    try {
      assert.deepEqual((await engine.status()).storeSchema, { current: null, expected: "1" });
      await assert.rejects(engine.admin.migrate("0", "1"), (e) => e.code === "storage");
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });
});

describe("store schema marker (unit)", () => {
  it("writeStoreSchemaMarker leaves no .tmp file behind and readStoreSchemaVersion reads it back", () => {
    const baseDbPath = join(makeTempDir("ess-unit-"), "store");
    writeStoreSchemaMarker(baseDbPath, "1", { engineVersion: "0.0.0-test" });
    const files = readdirSync(baseDbPath);
    assert.ok(!files.some((f) => f.endsWith(".tmp")), `unexpected tmp file among ${JSON.stringify(files)}`);
    assert.equal(readStoreSchemaVersion(baseDbPath), "1");
  });
});
