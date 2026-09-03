import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  IpcScopedEmbeddingProvider,
  createScopedEmbeddingIpcServer,
  registerScopedEmbeddingIpcServiceAfterLifecycle,
  resolveScopedEmbeddingIpcPaths,
} from "../lib/providers/scoped-embedding-ipc.js";

const ACTIVE_FINGERPRINT_ID = `embedding:v1:sha256:${"a".repeat(64)}`;
const STALE_FINGERPRINT_ID = `embedding:v1:sha256:${"b".repeat(64)}`;

async function leaveStaleUnixSocket(socketPath) {
  const child = spawn(process.execPath, [
    "-e",
    "const {createServer}=require('node:net');const s=createServer();s.listen(process.argv[1],()=>process.stdout.write('ready'));",
    socketPath,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(([code]) => {
      throw new Error(`stale socket fixture exited early (${code}): ${stderr.join("")}`);
    }),
  ]);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal(statSync(socketPath).isSocket(), true);
}

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
    const server = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    let provider = null;
    try {
      await server.start();
      provider = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "intfloat/multilingual-e5-small",
        dimensions: 2,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      assert.deepEqual(await provider.embedQuery("q"), [1, 0]);
      assert.deepEqual(await provider.embedPassage("p"), [0, 1]);
      assert.deepEqual(await provider.embedBatch(["a", "b"]), [[0.5, 0.5], [0.5, 0.5]]);
      assert.deepEqual(calls, [["query", "q"], ["passage", "p"], ["batch", ["a", "b"]]]);
      const paths = resolveScopedEmbeddingIpcPaths(stateRoot);
      assert.equal(statSync(paths.directory).mode & 0o777, 0o700);
      assert.equal(statSync(paths.socketPath).mode & 0o777, 0o600);
      assert.equal(statSync(paths.tokenPath).mode & 0o777, 0o600);
    } finally {
      await provider?.shutdown();
      await server.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("fails closed before transport for invalid inputs or an absent owner service", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-absent-"));
    const provider = new IpcScopedEmbeddingProvider({
      stateRoot,
      model: "fixture/e5",
      dimensions: 2,
      fingerprintId: ACTIVE_FINGERPRINT_ID,
    });
    try {
      await assert.rejects(provider.embedBatch([]), /between 1 and 64/i);
      await assert.rejects(provider.embed("x".repeat(60_001)), /60000 characters/i);
      await assert.rejects(provider.embed("owner absent"), /activation-owned embedding IPC.*unavailable/i);
    } finally {
      await provider.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("binds a discovery provider prepared before the first activated owner", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-cold-prepare-"));
    const embeddings = {
      model: "fixture/e5",
      dimensions: () => 1,
      async embedQuery() { return [1]; },
      async embedPassage() { return [1]; },
      async embedBatch(texts) { return texts.map(() => [1]); },
    };
    const prepared = new IpcScopedEmbeddingProvider({
      stateRoot,
      model: "fixture/e5",
      dimensions: 1,
      fingerprintId: ACTIVE_FINGERPRINT_ID,
    });
    const owner = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings,
      fingerprintId: ACTIVE_FINGERPRINT_ID,
    });
    try {
      await assert.rejects(
        prepared.embed("before activation"),
        /activation-owned embedding IPC.*unavailable/i,
      );
      await owner.start();
      assert.deepEqual(await prepared.embed("after activation"), [1]);
    } finally {
      await prepared.shutdown();
      await owner.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("binds a replacement discovery provider only to the next activated owner epoch", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-reload-prepare-"));
    const embeddings = {
      model: "fixture/e5",
      dimensions: () => 1,
      async embedQuery() { return [1]; },
      async embedPassage() { return [1]; },
      async embedBatch(texts) { return texts.map(() => [1]); },
    };
    const staleBeforeFirstOwner = new IpcScopedEmbeddingProvider({
      stateRoot,
      model: "fixture/e5",
      dimensions: 1,
      fingerprintId: ACTIVE_FINGERPRINT_ID,
    });
    const first = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    let preparedSuccessor = null;
    let second = null;
    try {
      await first.start();
      await first.shutdown();
      preparedSuccessor = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/e5",
        dimensions: 1,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      second = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
      await second.start();
      assert.deepEqual(await preparedSuccessor.embed("replacement owner"), [1]);
      await assert.rejects(
        staleBeforeFirstOwner.embed("must not skip an owner epoch"),
        /activation-owned embedding owner changed/i,
      );
    } finally {
      await preparedSuccessor?.shutdown();
      await staleBeforeFirstOwner.shutdown();
      await second?.shutdown();
      await first.shutdown();
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
    const first = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    let provider = null;
    let second = null;
    try {
      await first.start();
      provider = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/e5",
        dimensions: 1,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      assert.deepEqual(await provider.embed("first"), [1]);
      await first.shutdown();
      await assert.rejects(provider.embed("between owners"), /activation-owned embedding IPC.*unavailable/i);
      second = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
      await second.start();
      await assert.rejects(provider.embed("stale provider"), /activation-owned embedding owner changed/i);
      const successor = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/e5",
        dimensions: 1,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      assert.deepEqual(await successor.embed("successor"), [1]);
      await successor.shutdown();
      await second.shutdown();
    } finally {
      await provider?.shutdown();
      await second?.shutdown();
      await first.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("binds an unused scoped provider to the owner epoch present at construction", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-unused-epoch-"));
    const embeddings = {
      model: "fixture/e5",
      dimensions: () => 1,
      async embedQuery() { return [1]; },
      async embedPassage() { return [1]; },
      async embedBatch(texts) { return texts.map(() => [1]); },
    };
    const first = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    let staleProvider = null;
    let second = null;
    try {
      await first.start();
      staleProvider = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/e5",
        dimensions: 1,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      await first.shutdown();
      second = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
      await second.start();
      await assert.rejects(
        staleProvider.embed("must not acquire a successor epoch"),
        /activation-owned embedding owner changed/i,
      );
    } finally {
      await staleProvider?.shutdown();
      await second?.shutdown();
      await first.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("binds IPC requests to the complete immutable embedding fingerprint", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-fingerprint-"));
    const embeddings = {
      model: "fixture/e5",
      dimensions: () => 1,
      fingerprintId: ACTIVE_FINGERPRINT_ID,
      async embedQuery() { return [1]; },
      async embedPassage() { return [1]; },
      async embedBatch(texts) { return texts.map(() => [1]); },
    };
    const server = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    let staleProvider = null;
    try {
      await server.start();
      staleProvider = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/e5",
        dimensions: 1,
        fingerprintId: STALE_FINGERPRINT_ID,
      });
      await assert.rejects(
        staleProvider.embed("same model and dimensions, different vector semantics"),
        /embedding fingerprint.*does not match/i,
      );
    } finally {
      await staleProvider?.shutdown();
      await server.shutdown();
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
    const server = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    let wrongModel = null;
    try {
      await server.start();
      wrongModel = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/stale-e5",
        dimensions: 2,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      await assert.rejects(
        wrongModel.embed("must not cross model generations"),
        /model identity does not match/i,
      );
    } finally {
      await wrongModel?.shutdown();
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
    const first = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    const second = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    let provider = null;
    try {
      await first.start();
      provider = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/e5",
        dimensions: 1,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      await assert.rejects(second.start(), /owner is already active/i);
      await second.shutdown();
      assert.deepEqual(await provider.embed("first owner remains reachable"), [1]);
    } finally {
      await provider?.shutdown();
      await second.shutdown();
      await first.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("atomically elects one owner when two starts recover the same stale socket", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-owner-race-"));
    const paths = resolveScopedEmbeddingIpcPaths(stateRoot);
    const embeddings = {
      model: "fixture/e5",
      dimensions: () => 1,
      async embedQuery() { return [1]; },
      async embedPassage() { return [1]; },
      async embedBatch(texts) { return texts.map(() => [1]); },
    };
    const first = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    const second = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    let provider = null;
    try {
      await leaveStaleUnixSocket(paths.socketPath);
      const outcomes = await Promise.allSettled([first.start(), second.start()]);
      assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
      const rejected = outcomes.find(({ status }) => status === "rejected");
      assert.equal(rejected?.reason?.code, "scoped_embedding_owner_already_active");
      provider = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/e5",
        dimensions: 1,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      assert.deepEqual(await provider.embed("elected owner remains reachable"), [1]);
    } finally {
      await provider?.shutdown();
      await Promise.allSettled([second.shutdown(), first.shutdown()]);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("closes an incomplete unauthenticated connection during owner shutdown", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-incomplete-frame-"));
    const embeddings = {
      model: "fixture/e5",
      dimensions: () => 1,
      async embedQuery() { return [1]; },
      async embedPassage() { return [1]; },
      async embedBatch(texts) { return texts.map(() => [1]); },
    };
    const server = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    let socket = null;
    let shutdown = null;
    try {
      await server.start();
      socket = createConnection(resolveScopedEmbeddingIpcPaths(stateRoot).socketPath);
      await once(socket, "connect");
      const clientClosed = once(socket, "close");
      shutdown = server.shutdown();
      const outcome = await Promise.race([
        shutdown.then(() => "settled"),
        new Promise((resolve) => setTimeout(resolve, 250, "still-pending")),
      ]);
      assert.equal(outcome, "settled", "shutdown must not wait for a client that never sends an authenticated frame");
      await clientClosed;
      assert.equal(socket.destroyed, true, "shutdown must terminate the incomplete client connection");
    } finally {
      socket?.destroy();
      await shutdown;
      await server.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("bounds the unauthenticated request-frame window", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-scoped-embedding-frame-timeout-"));
    const embeddings = {
      model: "fixture/e5",
      dimensions: () => 1,
      async embedQuery() { return [1]; },
      async embedPassage() { return [1]; },
      async embedBatch(texts) { return texts.map(() => [1]); },
    };
    const server = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings,
      fingerprintId: ACTIVE_FINGERPRINT_ID,
      requestFrameTimeoutMs: 25,
    });
    let socket = null;
    try {
      await server.start();
      socket = createConnection(resolveScopedEmbeddingIpcPaths(stateRoot).socketPath);
      socket.setEncoding("utf8");
      await once(socket, "connect");
      const outcome = await Promise.race([
        once(socket, "data").then(([chunk]) => JSON.parse(String(chunk).trim())),
        new Promise((resolve) => setTimeout(resolve, 250, null)),
      ]);
      assert.equal(outcome?.ok, false);
      assert.equal(outcome?.error?.code, "scoped_embedding_request_timeout");
    } finally {
      socket?.destroy();
      await server.shutdown();
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
