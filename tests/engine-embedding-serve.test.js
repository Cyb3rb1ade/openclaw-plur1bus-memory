/**
 * tests/engine-embedding-serve.test.js — E3 Task 4: EmbeddingService.serve(address | null)
 * runs the scoped embedding IPC server as the in-process owner; close() stops it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { IpcScopedEmbeddingProvider } from "../lib/providers/scoped-embedding-ipc.js";
import { createEmbeddingServing, validateIpcAddress } from "../engine/providers/embedding-service.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const config = (baseDbPath) => ({
  baseDbPath,
  embedding: { provider: "local-transformers", local: { dimensions: 384 } },
  autoCapture: true, autoRecall: true,
  neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
  merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
  temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
  runtime: { recallTimeoutMs: 10_000 },
  duplicateThreshold: 1.01,
});

function stubHost(stateDir, warned) {
  return createStubHost({
    stateDir,
    workspaceDir: async (agentId) => {
      const dir = join(stateDir, "workspaces", agentId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    logger: { info() {}, warn: (m) => warned.push(String(m)), error: (m) => warned.push(String(m)), debug() {} },
  });
}

function stubEmbedder() {
  const vector = () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  return {
    model: "fixture/e5",
    dimensions: () => 384,
    embed: async () => vector(),
    embedQuery: async () => vector(),
    embedPassage: async () => vector(),
    embedBatch: async (texts) => texts.map(vector),
    shutdown: async () => {},
  };
}

function setup(prefix) {
  const warned = [];
  const stateDir = makeTempDir(`${prefix}state-`);
  const baseDbPath = join(makeTempDir(`${prefix}root-`), "lancedb-namespaced");
  const host = stubHost(stateDir, warned);
  const engine = createEngine(host, config(baseDbPath), { internals: { embeddings: stubEmbedder() } });
  return { engine, host, baseDbPath, warned };
}

function privateSockDir() {
  const dir = makeTempDir("e3-srv-");
  chmodSync(dir, 0o700);
  return dir;
}

const tokenPathOf = (baseDbPath) => join(baseDbPath, "control", "embedding-ipc", "owner.token");

async function roundTrip(baseDbPath, result) {
  const client = new IpcScopedEmbeddingProvider({ stateRoot: baseDbPath, ...result.identity, address: result.address });
  try {
    return await client.embedQuery("x");
  } finally {
    await client.shutdown();
  }
}

async function rejectsWith(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "MemoryOpError");
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Same fixture as tests/scoped-embedding-ipc.test.js: a listener in a child
// process that is SIGKILLed, leaving a socket file nobody accepts on.
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

const posixOnly = { skip: process.platform === "win32" };

describe("EmbeddingService.serve() (E3 Task 4)", () => {
  it("(a) serves an explicit unix socket; the result carries tokenPath and identity, never the token", posixOnly, async () => {
    const { engine, baseDbPath } = setup("e3-serve-a-");
    const address = { kind: "unix-socket", address: join(privateSockDir(), "e.sock") };
    try {
      const result = await engine.embedding.serve(address);
      assert.deepEqual(result.address, address);
      assert.ok(result.tokenPath.endsWith(join("control", "embedding-ipc", "owner.token")));
      assert.equal(result.identity.dimensions, 384);
      assert.equal(result.identity.model, "fixture/e5");
      const token = readFileSync(result.tokenPath, "utf8").trim();
      assert.ok(token.length >= 32);
      assert.ok(!JSON.stringify(result).includes(token));
      assert.equal((await roundTrip(baseDbPath, result)).length, 384);
    } finally {
      await engine.close();
    }
  });

  it("(b) is idempotent for the served address, conflicts for another, and serve(null) stops", posixOnly, async () => {
    const { engine, baseDbPath } = setup("e3-serve-b-");
    const sockDir = privateSockDir();
    const address = { kind: "unix-socket", address: join(sockDir, "e.sock") };
    try {
      const first = await engine.embedding.serve(address);
      const again = await engine.embedding.serve({ ...address });
      assert.strictEqual(again, first);
      await rejectsWith(
        engine.embedding.serve({ kind: "unix-socket", address: join(sockDir, "other.sock") }),
        "conflict",
        "embedding IPC is already served on another address",
      );
      const stopped = await engine.embedding.serve(null);
      assert.deepEqual({ ...stopped, dispose: undefined }, { address: null, tokenPath: null, identity: null, dispose: undefined });
      assert.equal(existsSync(address.address), false);
      assert.equal(existsSync(tokenPathOf(baseDbPath)), false);
      const stoppedAgain = await engine.embedding.serve(null);
      assert.equal(stoppedAgain.address, null);
      assert.equal(stoppedAgain.tokenPath, null);
      assert.equal(stoppedAgain.identity, null);
    } finally {
      await engine.close();
    }
  });

  it("(c) serve() without an address binds the platform default", { skip: process.platform !== "linux" }, async () => {
    const { engine, host, baseDbPath } = setup("e3-serve-c-");
    try {
      const result = await engine.embedding.serve();
      assert.equal(result.address.kind, "abstract-socket");
      assert.deepEqual(result.address, host.platform.ipcAddress(join(baseDbPath, "control", "embedding-ipc")));
      assert.equal((await roundTrip(baseDbPath, result)).length, 384);
    } finally {
      await engine.close();
    }
  });

  it("(d) rejects invalid addresses and unsafe socket directories before writing a token", posixOnly, async () => {
    const { engine, baseDbPath } = setup("e3-serve-d-");
    try {
      await rejectsWith(engine.embedding.serve({ kind: "named-pipe", address: "\\\\.\\pipe\\x" }), "invalid-input", "named pipes are Windows-only");
      await rejectsWith(engine.embedding.serve({ kind: "unix-socket", address: "rel.sock" }), "invalid-input", "socket path must be absolute");
      const openDir = makeTempDir("e3-srv-open-");
      chmodSync(openDir, 0o755);
      await rejectsWith(
        engine.embedding.serve({ kind: "unix-socket", address: join(openDir, "e.sock") }),
        "invalid-input",
        "socket directory must be private (0700)",
      );
      const linkParent = makeTempDir("e3-srv-link-");
      const linked = join(linkParent, "linked");
      symlinkSync(privateSockDir(), linked);
      await rejectsWith(engine.embedding.serve({ kind: "unix-socket", address: join(linked, "e.sock") }), "invalid-input");
      await rejectsWith(engine.embedding.serve({ kind: "unix-socket", address: join(linkParent, "missing", "e.sock") }), "invalid-input");
      await rejectsWith(engine.embedding.serve("x"), "invalid-input", "address must be an IpcAddress or null");
      assert.equal(existsSync(tokenPathOf(baseDbPath)), false);
      assert.equal(existsSync(join(openDir, "e.sock")), false);
    } finally {
      await engine.close();
    }
  });

  it("(e) a live foreign listener is a conflict and keeps its socket; a dead stale socket is replaced", posixOnly, async () => {
    const { engine, baseDbPath } = setup("e3-serve-e-");
    const sockDir = privateSockDir();
    const foreignPath = join(sockDir, "foreign.sock");
    const foreign = createServer((socket) => socket.destroy());
    await new Promise((resolve) => foreign.listen(foreignPath, resolve));
    try {
      await rejectsWith(
        engine.embedding.serve({ kind: "unix-socket", address: foreignPath }),
        "conflict",
        "embedding IPC address is in use",
      );
      assert.equal(statSync(foreignPath).isSocket(), true);
      assert.equal(existsSync(tokenPathOf(baseDbPath)), false);

      const stalePath = join(sockDir, "stale.sock");
      await leaveStaleUnixSocket(stalePath);
      const result = await engine.embedding.serve({ kind: "unix-socket", address: stalePath });
      assert.equal((await roundTrip(baseDbPath, result)).length, 384);
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
      await engine.close();
    }
  });

  it("(e2) a second engine on the same stateRoot in this process cannot serve another address", posixOnly, async () => {
    const one = setup("e3-serve-e2-");
    const warned = [];
    const other = createEngine(stubHost(makeTempDir("e3-serve-e2b-state-"), warned), config(one.baseDbPath), {
      internals: { embeddings: stubEmbedder() },
    });
    const sockDir = privateSockDir();
    try {
      const served = await one.engine.embedding.serve({ kind: "unix-socket", address: join(sockDir, "one.sock") });
      await rejectsWith(
        other.embedding.serve({ kind: "unix-socket", address: join(sockDir, "two.sock") }),
        "conflict",
        "embedding IPC address is in use",
      );
      assert.equal(existsSync(join(sockDir, "two.sock")), false);
      assert.equal((await roundTrip(one.baseDbPath, served)).length, 384);
    } finally {
      await other.close();
      await one.engine.close();
    }
  });

  it("(f) dispose() stops the served server; a stale result's dispose() leaves a newer server alone", posixOnly, async () => {
    const { engine, baseDbPath } = setup("e3-serve-f-");
    const sockDir = privateSockDir();
    const address = { kind: "unix-socket", address: join(sockDir, "e.sock") };
    try {
      const first = await engine.embedding.serve(address);
      assert.equal(first.dispose(), undefined);
      await waitFor(() => !existsSync(address.address));

      const second = await engine.embedding.serve(address);
      assert.notStrictEqual(second, first);
      first.dispose();
      // Anything queued after the stale dispose runs after it; the server must still answer.
      assert.strictEqual(await engine.embedding.serve(address), second);
      assert.equal(existsSync(address.address), true);
      assert.equal((await roundTrip(baseDbPath, second)).length, 384);
    } finally {
      await engine.close();
    }
  });

  it("(g) close() stops serving; serve after close is storage; a fresh engine rebinds the path at once", posixOnly, async () => {
    const sockDir = privateSockDir();
    const address = { kind: "unix-socket", address: join(sockDir, "e.sock") };
    const one = setup("e3-serve-g1-");
    await one.engine.embedding.serve(address);
    await one.engine.close();
    assert.equal(existsSync(address.address), false);
    assert.equal(existsSync(tokenPathOf(one.baseDbPath)), false);
    await rejectsWith(one.engine.embedding.serve(address), "storage", "engine is closed");

    const two = setup("e3-serve-g2-");
    try {
      const result = await two.engine.embedding.serve(address);
      assert.equal((await roundTrip(two.baseDbPath, result)).length, 384);
    } finally {
      await two.engine.close();
    }
  });

  it("(h) a request with a wrong token gets an auth error frame and no vectors", posixOnly, async () => {
    const { engine } = setup("e3-serve-h-");
    const address = { kind: "unix-socket", address: join(privateSockDir(), "e.sock") };
    try {
      const result = await engine.embedding.serve(address);
      const socket = createConnection(result.address.address);
      socket.setEncoding("utf8");
      let reply = "";
      socket.on("data", (chunk) => { reply += chunk; });
      await once(socket, "connect");
      socket.write(`${JSON.stringify({
        token: randomBytes(32).toString("hex"),
        ...result.identity,
        request: { operation: "query", texts: ["x"] },
      })}\n`);
      await once(socket, "end");
      const frame = JSON.parse(reply);
      assert.equal(frame.ok, false);
      assert.equal(frame.error.code, "scoped_embedding_auth_failed");
      assert.equal(frame.vectors, undefined);
    } finally {
      await engine.close();
    }
  });

  it("(i) the host lifecycle owner and an IPC client never start a server; serve(null) is a no-op", async () => {
    const calls = [];
    const spy = (options) => { calls.push(options); throw new Error("must not be called"); };
    const base = {
      stateRoot: makeTempDir("e3-serve-i-"),
      getEmbeddings: () => stubEmbedder(),
      fingerprintId: `embedding:v1:sha256:${"a".repeat(64)}`,
      defaultAddress: () => ({ kind: "abstract-socket", address: "\0unused" }),
      isClosed: () => false,
      isUnsafeLink: () => false,
      logger: { warn() {} },
      createServer: spy,
    };
    const addr = { kind: "unix-socket", address: "/tmp/unused.sock" };

    const hostOwned = createEmbeddingServing({ ...base, hostOwned: true, isClient: () => false });
    await rejectsWith(hostOwned.serve(addr), "conflict", "embedding IPC is owned by the host lifecycle");
    const hostStop = await hostOwned.serve(null);
    assert.equal(hostStop.address, null);
    assert.equal(hostStop.tokenPath, null);
    assert.equal(hostStop.identity, null);

    const client = createEmbeddingServing({ ...base, hostOwned: false, isClient: () => true });
    await rejectsWith(client.serve(addr), "conflict", "this engine is an embedding IPC client, not the owner");
    assert.equal((await client.serve(null)).address, null);
    assert.equal(calls.length, 0);
  });

  it("(j) validateIpcAddress applies the per-platform rules", () => {
    const pipe = { kind: "named-pipe", address: `\\\\.\\pipe\\plur1bus-embedding-${"a".repeat(32)}` };
    const valid = validateIpcAddress(pipe, { platform: "win32" });
    assert.deepEqual(valid, pipe);
    assert.ok(Object.isFrozen(valid));
    assert.throws(() => validateIpcAddress(pipe, { platform: "linux" }), { name: "MemoryOpError", code: "invalid-input", message: "named pipes are Windows-only" });
    assert.throws(
      () => validateIpcAddress({ kind: "abstract-socket", address: "\0plur1bus-embedding-x" }, { platform: "darwin" }),
      { code: "invalid-input", message: "abstract sockets are Linux-only" },
    );
    const long = `/${"a".repeat(103)}`;
    assert.equal(Buffer.byteLength(long), 104);
    assert.throws(
      () => validateIpcAddress({ kind: "unix-socket", address: long }, { platform: "darwin" }),
      { code: "invalid-input", message: "socket path exceeds the platform limit" },
    );
    assert.deepEqual(validateIpcAddress({ kind: "unix-socket", address: long }, { platform: "linux" }), { kind: "unix-socket", address: long });
    assert.throws(() => validateIpcAddress({ kind: "unix-socket", address: "/a.sock" }, { platform: "win32" }), { message: "unix sockets are not used on Windows; use a named pipe" });
    assert.throws(() => validateIpcAddress({ kind: "unix-socket", address: "/a\0b" }, { platform: "linux" }), { message: "invalid socket path" });
    assert.throws(() => validateIpcAddress({ kind: "abstract-socket", address: "\0has space" }, { platform: "linux" }), { message: "invalid abstract socket name" });
    assert.throws(() => validateIpcAddress({ kind: "tcp", address: "x" }), { message: "unsupported IPC address kind" });
    assert.throws(() => validateIpcAddress({ kind: "unix-socket", address: "/a", extra: 1 }), { message: "address must be an IpcAddress or null" });
    assert.throws(() => validateIpcAddress(null), { message: "address must be an IpcAddress or null" });
  });
});
