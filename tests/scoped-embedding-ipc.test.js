import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  IpcScopedEmbeddingProvider,
  createScopedEmbeddingIpcServer,
  registerScopedEmbeddingIpcServiceAfterLifecycle,
  resolveScopedEmbeddingIpcPaths,
} from "../lib/providers/scoped-embedding-ipc.js";

describe("scoped embedding through activation-owned Unix IPC", () => {
  it("routes query, passage, and batch work to the full-runtime provider", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-"));
    const calls = [];
    const embeddings = {
      model: "intfloat/multilingual-e5-small",
      dimensions: () => 2,
      async embedQuery(text) { calls.push(["query", text]); return [1, 0]; },
      async embedPassage(text) { calls.push(["passage", text]); return [0, 1]; },
      async embedBatch(texts) { calls.push(["batch", texts]); return texts.map(() => [0.5, 0.5]); },
    };
    const server = createScopedEmbeddingIpcServer({ stateRoot, embeddings });
    const provider = new IpcScopedEmbeddingProvider({
      stateRoot,
      model: "intfloat/multilingual-e5-small",
      dimensions: 2,
    });
    try {
      await server.start();
      assert.deepEqual(await provider.embedQuery("q"), [1, 0]);
      assert.deepEqual(await provider.embedPassage("p"), [0, 1]);
      assert.deepEqual(await provider.embedBatch(["a", "b"]), [[0.5, 0.5], [0.5, 0.5]]);
      assert.deepEqual(calls, [["query", "q"], ["passage", "p"], ["batch", ["a", "b"]]]);
      const paths = resolveScopedEmbeddingIpcPaths(stateRoot);
      assert.equal(statSync(paths.directory).mode & 0o777, 0o700);
      assert.equal(statSync(paths.socketPath).mode & 0o777, 0o600);
      assert.equal(statSync(paths.tokenPath).mode & 0o777, 0o600);
    } finally {
      await provider.shutdown();
      await server.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("fails closed before transport for invalid inputs or an absent owner service", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-absent-"));
    const provider = new IpcScopedEmbeddingProvider({ stateRoot, model: "fixture/e5", dimensions: 2 });
    try {
      await assert.rejects(provider.embedBatch([]), /between 1 and 64/i);
      await assert.rejects(provider.embed("x".repeat(60_001)), /60000 characters/i);
      await assert.rejects(provider.embed("owner absent"), /activation-owned embedding IPC.*unavailable/i);
    } finally {
      await provider.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("rotates private authentication on restart and never rebinds a stale scoped provider", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-restart-"));
    const embeddings = {
      model: "fixture/e5",
      dimensions: () => 1,
      async embedQuery() { return [1]; },
      async embedPassage() { return [1]; },
      async embedBatch(texts) { return texts.map(() => [1]); },
    };
    const first = createScopedEmbeddingIpcServer({ stateRoot, embeddings });
    const provider = new IpcScopedEmbeddingProvider({ stateRoot, model: "fixture/e5", dimensions: 1 });
    let second = null;
    try {
      await first.start();
      assert.deepEqual(await provider.embed("first"), [1]);
      await first.shutdown();
      await assert.rejects(provider.embed("between owners"), /activation-owned embedding IPC.*unavailable/i);
      second = createScopedEmbeddingIpcServer({ stateRoot, embeddings });
      await second.start();
      await assert.rejects(provider.embed("stale provider"), /activation-owned embedding owner changed/i);
      const successor = new IpcScopedEmbeddingProvider({ stateRoot, model: "fixture/e5", dimensions: 1 });
      assert.deepEqual(await successor.embed("successor"), [1]);
      await successor.shutdown();
      await second.shutdown();
    } finally {
      await provider.shutdown();
      await second?.shutdown();
      await first.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a scoped registry requests a different model identity", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-identity-"));
    const embeddings = {
      model: "fixture/active-e5",
      dimensions: () => 2,
      async embedQuery() { return [1, 0]; },
      async embedPassage() { return [1, 0]; },
      async embedBatch(texts) { return texts.map(() => [1, 0]); },
    };
    const server = createScopedEmbeddingIpcServer({ stateRoot, embeddings });
    const wrongModel = new IpcScopedEmbeddingProvider({
      stateRoot,
      model: "fixture/stale-e5",
      dimensions: 2,
    });
    try {
      await server.start();
      await assert.rejects(
        wrongModel.embed("must not cross model generations"),
        /model identity does not match/i,
      );
    } finally {
      await wrongModel.shutdown();
      await server.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses a second owner without unlinking the active owner's socket or token", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-owner-collision-"));
    const embeddings = {
      model: "fixture/e5",
      dimensions: () => 1,
      async embedQuery() { return [1]; },
      async embedPassage() { return [1]; },
      async embedBatch(texts) { return texts.map(() => [1]); },
    };
    const first = createScopedEmbeddingIpcServer({ stateRoot, embeddings });
    const second = createScopedEmbeddingIpcServer({ stateRoot, embeddings });
    const provider = new IpcScopedEmbeddingProvider({ stateRoot, model: "fixture/e5", dimensions: 1 });
    try {
      await first.start();
      await assert.rejects(second.start(), /owner is already active/i);
      await second.shutdown();
      assert.deepEqual(await provider.embed("first owner remains reachable"), [1]);
    } finally {
      await provider.shutdown();
      await second.shutdown();
      await first.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("registers one activation-owned service after shutdown ownership", async () => {
    const registrations = [];
    const api = {
      registerService(service) { registrations.push(service); },
      logger: { warn() {} },
    };
    const calls = [];
    const server = {
      async start() { calls.push("start"); },
      async shutdown() { calls.push("stop"); },
    };
    assert.equal(registerScopedEmbeddingIpcServiceAfterLifecycle({
      api,
      server,
      enabled: true,
      lifecycleRegistered: true,
    }), true);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].id, "plur1bus-scoped-embedding-owner");
    await registrations[0].start();
    await registrations[0].stop();
    assert.deepEqual(calls, ["start", "stop"]);
  });
});
