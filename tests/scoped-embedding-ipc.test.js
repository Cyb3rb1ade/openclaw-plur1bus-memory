import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  IpcScopedEmbeddingProvider,
  ReloadSafeIpcScopedEmbeddingProvider,
  createScopedEmbeddingIpcServer,
  registerScopedEmbeddingIpcServiceAfterLifecycle,
  OWNER_PIPE_NONCE_FILE,
  ensureScopedEmbeddingPipeNonce,
  readScopedEmbeddingPipeNonce,
  resetScopedEmbeddingNonceWarningForTests,
  resolveScopedEmbeddingDefaultEndpoint,
  resolveScopedEmbeddingIpcPaths,
  resolveScopedEmbeddingOwnerClaimAddress,
} from "../lib/providers/scoped-embedding-ipc.js";
import { ipcAddress, readDirectoryAcl, unixSocketPathMaxBytes } from "../lib/platform.js";
import { claimAddressUnavailable, makeClaimableStateRoot } from "./helpers/claimable-state-root.js";
import { runTracked, spawnTracked, waitForOutput } from "./helpers/spawn-tracked.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const ACTIVE_FINGERPRINT_ID = `embedding:v1:sha256:${"a".repeat(64)}`;
const STALE_FINGERPRINT_ID = `embedding:v1:sha256:${"b".repeat(64)}`;

const WIN32 = process.platform === "win32";
// A stale socket *file* (and the recovery that unlinks it) is a POSIX
// concept: on win32 the owner listens on a named pipe, which disappears with
// its process and has no filesystem entry.
const posixSocketFile = { skip: WIN32 && "engine-windows:posix-only (stale socket-file recovery; win32 owners listen on named pipes)" };

/** The address a raw client connects to for the stateRoot's legacy owner. */
function defaultOwnerAddress(stateRoot) {
  return resolveScopedEmbeddingDefaultEndpoint(resolveScopedEmbeddingIpcPaths(stateRoot)).address;
}

async function leaveStaleUnixSocket(t, socketPath) {
  const child = spawnTracked(t, process.execPath, [
    "-e",
    "const {createServer}=require('node:net');const s=createServer();s.listen(process.argv[1],()=>process.stdout.write('ready'));",
    socketPath,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await waitForOutput(child, { match: "ready", label: "stale socket fixture" });
  child.kill("SIGKILL");
  await child.exited;
  assert.equal(statSync(socketPath).isSocket(), true);
}

async function startOwnerInChild(t, stateRoot) {
  const moduleUrl = new URL("../lib/providers/scoped-embedding-ipc.js", import.meta.url).href;
  const source = [
    "const {createScopedEmbeddingIpcServer}=await import(process.argv[1]);",
    "const fingerprintId=`embedding:v1:sha256:${'a'.repeat(64)}`;",
    "const embeddings={model:'fixture/e5',dimensions:()=>1,embedQuery:async()=>[1],embedPassage:async()=>[1],embedBatch:async texts=>texts.map(()=>[1])};",
    "const owner=createScopedEmbeddingIpcServer({stateRoot:process.argv[2],embeddings,fingerprintId});",
    "await owner.start();process.stdout.write('ready');setInterval(()=>{},1000);",
  ].join("");
  const child = spawnTracked(t, process.execPath, ["--input-type=module", "-e", source, moduleUrl, stateRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForOutput(child, { match: "ready", label: "scoped embedding owner child" });
  return child;
}

function fixtureEmbeddings() {
  return {
    model: "fixture/e5",
    dimensions: () => 1,
    async embedQuery() { return [1]; },
    async embedPassage() { return [1]; },
    async embedBatch(texts) { return texts.map(() => [1]); },
  };
}

async function createStateRoot(prefix) {
  // macOS limits filesystem Unix socket names to 104 bytes.  Its default
  // per-user temporary directory is longer than that before this test adds
  // the private IPC path, while /tmp keeps this fixture portable.
  // win32 has neither /tmp nor socket files (the owner listens on a named pipe).
  // Off Linux the owner claim port derives from the path; a port the host
  // reserves (Windows excluded ranges: listen EACCES) re-rolls the directory.
  return makeClaimableStateRoot(prefix, WIN32 ? tmpdir() : "/tmp");
}

describe("scoped embedding through activation-owned Unix IPC", () => {
  it("keeps token and socket paths confined to the private IPC directory", async () => {
    const stateRoot = await createStateRoot("plur1bus-ipc-containment-");
    try {
      const paths = resolveScopedEmbeddingIpcPaths(stateRoot);
      const sibling = join(stateRoot, "must-not-touch");
      writeFileSync(sibling, "preserve");
      symlinkSync(sibling, paths.tokenPath);
      assert.throws(() => resolveScopedEmbeddingIpcPaths(stateRoot), /outside|escape|traversal/i);
      assert.equal(readFileSync(sibling, "utf8"), "preserve");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("uses a deterministic exclusive loopback claim address off Linux", () => {
    const directory = "/private/plur1bus/control/embedding-ipc";
    const digest = createHash("sha256").update(directory).digest("hex").slice(0, 40);
    const expectedPort = 49_152 + (Number.parseInt(digest.slice(0, 4), 16) % 16_384);
    assert.deepEqual(resolveScopedEmbeddingOwnerClaimAddress(directory, "darwin"), {
      host: "127.0.0.1",
      port: expectedPort,
      exclusive: true,
    });
    assert.deepEqual(
      resolveScopedEmbeddingOwnerClaimAddress(directory, "freebsd"),
      resolveScopedEmbeddingOwnerClaimAddress(directory, "darwin"),
    );
    assert.equal(
      resolveScopedEmbeddingOwnerClaimAddress(directory, "linux"),
      `\0plur1bus-embedding-owner-v1-${digest}`,
    );
  });

  it("listens on owner.sock off win32 and on a nonce-secured named pipe on win32 (EW-R1)", () => {
    const posix = { directory: "/state/control/embedding-ipc", socketPath: "/state/control/embedding-ipc/owner.sock" };
    const noNonce = () => { throw new Error("POSIX must not read a nonce"); };
    assert.deepEqual(resolveScopedEmbeddingDefaultEndpoint(posix, "linux", { readNonce: noNonce }), { address: posix.socketPath, socketPath: posix.socketPath });
    assert.deepEqual(resolveScopedEmbeddingDefaultEndpoint(posix, "darwin", { readNonce: noNonce }), { address: posix.socketPath, socketPath: posix.socketPath });
    const win = { directory: "C:\\State\\control\\embedding-ipc", socketPath: "C:\\State\\control\\embedding-ipc\\owner.sock" };
    const nonceA = "a".repeat(64);
    const nonceB = "b".repeat(64);
    const seams = (nonce, realpath = (p) => p) => ({ readNonce: () => nonce, realpath });
    const expected = (nonce) => {
      const digest = createHash("sha256").update(`c:\\state\\control\\embedding-ipc\n${nonce}`).digest("hex").slice(0, 40);
      return { address: `\\\\.\\pipe\\plur1bus-embedding-owner-v2-${digest}`, socketPath: null };
    };
    assert.deepEqual(resolveScopedEmbeddingDefaultEndpoint(win, "win32", seams(nonceA)), expected(nonceA));
    // The name depends on the secret nonce: a different nonce, a different pipe.
    assert.notEqual(resolveScopedEmbeddingDefaultEndpoint(win, "win32", seams(nonceB)).address, expected(nonceA).address);
    // The directory is hashed in its canonical (realpath.native) form, lower-cased:
    // a short-name or differently cased spelling of the same directory meets the owner.
    const shortName = { ...win, directory: "C:\\STATE~1\\CONTROL\\EMBEDDING-IPC" };
    assert.deepEqual(resolveScopedEmbeddingDefaultEndpoint(shortName, "win32", seams(nonceA, () => "C:\\State\\control\\embedding-ipc")), expected(nonceA));
    // Distinct from the serve() default (platform.ipcAddress) of the same directory.
    assert.notEqual(expected(nonceA).address, ipcAddress(win.directory, { platform: "win32" }).address);
  });

  it("creates the win32 pipe nonce once and fails closed when it is missing, unsafe or malformed (EW-R1)", () => {
    const directory = makeTempDir("plur1bus-ipc-nonce-");
    const paths = { directory };
    const file = join(directory, OWNER_PIPE_NONCE_FILE);
    const unavailable = (error) => error?.code === "scoped_embedding_pipe_nonce_unavailable" && /missing or unreadable/.test(error.message);
    assert.throws(() => readScopedEmbeddingPipeNonce(paths), unavailable, "missing");
    assert.equal(ensureScopedEmbeddingPipeNonce(paths, { platform: "linux" }), true);
    const nonce = readScopedEmbeddingPipeNonce(paths);
    assert.match(nonce, /^[a-f0-9]{64}$/);
    assert.equal(ensureScopedEmbeddingPipeNonce(paths, { platform: "linux" }), false, "an existing nonce is kept");
    assert.equal(readScopedEmbeddingPipeNonce(paths), nonce);
    // Windows run tc3: the directory below an 8.3 ancestor (C:\Users\RUNNER~1\…)
    // was refused as "not a regular file". A parent reached through a link
    // stands in for that spelling; the win32 link check must accept it.
    const alias = join(makeTempDir("plur1bus-ipc-nonce-alias-"), "alias");
    symlinkSync(directory, alias, "dir");
    assert.equal(readScopedEmbeddingPipeNonce({ directory: alias }, { platform: "win32" }), nonce);
    // No file-ACL reader in the repo for the win32 nonce file: engine-windows:posix-only for this mode check.
    if (!WIN32) assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, "not-a-nonce\n");
    assert.throws(() => readScopedEmbeddingPipeNonce(paths), unavailable, "malformed");
    rmSync(file);
    mkdirSync(file);
    assert.throws(() => readScopedEmbeddingPipeNonce(paths), unavailable, "not a regular file");
  });

  it("publishes the nonce atomically: a complete, secured temp file is linked into place (review N2)", () => {
    const directory = makeTempDir("plur1bus-ipc-nonce-atomic-");
    const paths = { directory };
    const file = join(directory, OWNER_PIPE_NONCE_FILE);
    const seen = [];
    const created = ensureScopedEmbeddingPipeNonce(paths, {
      platform: "linux",
      secure: (target) => { seen.push(["secure", target]); return { applied: true, mechanism: "chmod" }; },
      link: (from, to) => {
        // At the moment it becomes visible, the file is already complete and secured,
        // and until then a reader sees no file at all (never an empty one).
        assert.equal(existsSync(to), false);
        assert.match(readFileSync(from, "utf8"), /^[a-f0-9]{64}\n$/);
        assert.deepEqual(seen, [["secure", from]]);
        linkSync(from, to);
      },
    });
    assert.equal(created, true);
    assert.match(readScopedEmbeddingPipeNonce(paths), /^[a-f0-9]{64}$/);
    assert.deepEqual(readdirSync(directory), [OWNER_PIPE_NONCE_FILE], "the temp file is gone");
    // A creator that loses the link race keeps the winner's file and cleans up.
    const before = readFileSync(file, "utf8");
    const lost = ensureScopedEmbeddingPipeNonce(paths, { platform: "linux", link: () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); } });
    assert.equal(lost, false);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(readdirSync(directory), [OWNER_PIPE_NONCE_FILE]);
  });

  it("concurrent creators and readers in separate processes never see an empty or differing nonce (review N2)", async (t) => {
    const directory = makeTempDir("plur1bus-ipc-nonce-race-");
    const moduleUrl = new URL("../lib/providers/scoped-embedding-ipc.js", import.meta.url).href;
    const source = [
      "const m = await import(process.argv[1]);",
      "const paths = { directory: process.argv[2] };",
      "const seen = new Set();",
      "for (let i = 0; i < 400; i += 1) {",
      "  if (i === 20) m.ensureScopedEmbeddingPipeNonce(paths, { platform: 'linux' });",
      "  try { seen.add(m.readScopedEmbeddingPipeNonce(paths)); }",
      "  catch (e) { if (e.cause?.code !== 'ENOENT') { process.stdout.write('BAD ' + e.message + ' ' + (e.cause?.message ?? '')); process.exit(1); } }",
      "}",
      "process.stdout.write([...seen].join(','));",
    ].join("\n");
    const runs = await Promise.all(Array.from({ length: 4 }, () => runTracked(
      t,
      process.execPath,
      ["--input-type=module", "-e", source, moduleUrl, directory],
      { stdio: ["ignore", "pipe", "pipe"], timeoutMs: 30_000 },
    )));
    for (const run of runs) assert.equal(run.code, 0, run.stdout + run.stderr);
    const nonces = new Set(runs.flatMap((run) => run.stdout.split(",").filter(Boolean)));
    assert.equal(nonces.size, 1, [...nonces].join(" | "));
    assert.equal([...nonces][0], readScopedEmbeddingPipeNonce({ directory }));
    assert.deepEqual(readdirSync(directory), [OWNER_PIPE_NONCE_FILE]);
  });

  it("warns once per process when the ACL tool is missing for the nonce (review N4, gate G2 a)", () => {
    resetScopedEmbeddingNonceWarningForTests();
    const warnings = [];
    const logger = { warn: (message) => warnings.push(String(message)) };
    const unavailable = () => ({ applied: false, reason: "acl-tool-unavailable" });
    for (const prefix of ["plur1bus-ipc-nonce-acl-a-", "plur1bus-ipc-nonce-acl-b-"]) {
      assert.equal(ensureScopedEmbeddingPipeNonce({ directory: makeTempDir(prefix) }, { platform: "win32", logger, secure: unavailable }), true);
    }
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0], /icacls\) is unavailable/);
    resetScopedEmbeddingNonceWarningForTests();
  });

  it("a win32 legacy owner without its nonce does not start and says why; a client fails closed too (EW-R1)", async () => {
    // Driven with platform "win32" on any host: the nonce is read before any
    // listener or token exists, so nothing binds here.
    const stateRoot = await createStateRoot("plur1bus-ipc-nonce-owner-");
    const paths = resolveScopedEmbeddingIpcPaths(stateRoot);
    const nonceFile = join(paths.directory, OWNER_PIPE_NONCE_FILE);
    const server = createScopedEmbeddingIpcServer({ stateRoot, embeddings: fixtureEmbeddings(), fingerprintId: ACTIVE_FINGERPRINT_ID, platform: "win32" });
    try {
      assert.match(readFileSync(nonceFile, "utf8").trim(), /^[a-f0-9]{64}$/, "construction created the nonce");
      rmSync(nonceFile);
      await assert.rejects(server.start(), (error) => error?.code === "scoped_embedding_pipe_nonce_unavailable");
      assert.equal(existsSync(paths.tokenPath), false, "no token was issued");
      await server.shutdown();

      writeFileSync(paths.tokenPath, `${"d".repeat(64)}\n`, { mode: 0o600 });
      const client = new IpcScopedEmbeddingProvider({ stateRoot, model: "fixture/e5", dimensions: 1, fingerprintId: ACTIVE_FINGERPRINT_ID, platform: "win32" });
      await assert.rejects(client.embedQuery("q"), (error) => error?.code === "scoped_embedding_pipe_nonce_unavailable");
      await client.shutdown();
    } finally {
      await server.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("diagnoses an oversized unix-socket path before creating IPC children", posixSocketFile, async () => {
    const parent = await createStateRoot("plur1bus-scoped-embedding-path-");
    const suffix = "/control/embedding-ipc/owner.sock";
    const resolvedParent = realpathSync(parent);
    const over = unixSocketPathMaxBytes() + 1 - Buffer.byteLength(resolvedParent) - 1 - Buffer.byteLength(suffix);
    const stateRoot = join(parent, "x".repeat(Math.max(over, 1)));
    try {
      assert.throws(
        () => resolveScopedEmbeddingIpcPaths(stateRoot),
        (error) => error?.code === "scoped_embedding_socket_path_too_long"
          && /shorter state root/i.test(error.message),
      );
      assert.equal(existsSync(join(stateRoot, "control")), false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("routes query, passage, and batch work to the full-runtime provider", async () => {
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-");
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
      if (!WIN32) {
        assert.equal(statSync(paths.directory).mode & 0o777, 0o700);
        assert.equal(statSync(paths.socketPath).mode & 0o777, 0o600);
        assert.equal(statSync(paths.tokenPath).mode & 0o777, 0o600);
      } else {
        // win32: the directory's ACL instead of mode bits (securePath: icacls
        // /inheritance:r, the user only). The token file has no ACL reader in
        // the repo (readDirectoryAcl reads directories) and the pipe no file:
        // engine-windows:posix-only for those two mode assertions.
        const acl = readDirectoryAcl(paths.directory);
        const allowed = acl.aces.filter((ace) => ace.type === "Allow").map((ace) => ace.sid.toUpperCase());
        assert.ok(allowed.length > 0);
        for (const sid of allowed) assert.ok([acl.userSid.toUpperCase(), "S-1-5-18", "S-1-5-32-544"].includes(sid), `unexpected Allow ACE ${sid}`);
      }
    } finally {
      await provider?.shutdown();
      await server.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("carries a memory-only persist: false across the IPC call and omits it otherwise (E5 R26)", async () => {
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-memonly-");
    const calls = [];
    const embeddings = {
      model: "intfloat/multilingual-e5-small",
      dimensions: () => 2,
      async embedQuery(text, options) { calls.push(["query", text, options]); return [1, 0]; },
      async embedPassage(text, options) { calls.push(["passage", text, options]); return [0, 1]; },
      async embedBatch(texts, retries, options) { calls.push(["batch", texts, options]); return texts.map(() => [0.5, 0.5]); },
    };
    const server = createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId: ACTIVE_FINGERPRINT_ID });
    let provider = null;
    try {
      await server.start();
      provider = new ReloadSafeIpcScopedEmbeddingProvider({
        stateRoot,
        model: "intfloat/multilingual-e5-small",
        dimensions: 2,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      await provider.embedQuery("q", { persist: false, agentId: "a" });
      await provider.embed("p", { persist: false });
      await provider.embedBatch(["a"], { persist: false });
      await provider.embedQuery("q2", { agentId: "a" });
      assert.deepEqual(calls, [
        ["query", "q", { persist: false }],
        ["passage", "p", { persist: false }],
        ["batch", ["a"], { persist: false }],
        ["query", "q2", undefined],
      ]);
    } finally {
      await provider?.shutdown();
      await server.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("fails closed before transport for invalid inputs or an absent owner service", async () => {
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-absent-");
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
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-cold-prepare-");
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
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-reload-prepare-");
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
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-restart-");
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
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-unused-epoch-");
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
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-fingerprint-");
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
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-identity-");
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
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-owner-collision-");
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

  it("refuses a live cross-process owner and recovers after its crash", async (t) => {
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-owner-crash-");
    const child = await startOwnerInChild(t, stateRoot);
    const contender = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings: fixtureEmbeddings(),
      fingerprintId: ACTIVE_FINGERPRINT_ID,
    });
    let recovered = null;
    let provider = null;
    try {
      await assert.rejects(contender.start(), /owner is already active/i);
      const childExit = once(child, "exit");
      child.kill("SIGKILL");
      await childExit;
      recovered = createScopedEmbeddingIpcServer({
        stateRoot,
        embeddings: fixtureEmbeddings(),
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      await recovered.start();
      provider = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/e5",
        dimensions: 1,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      assert.deepEqual(await provider.embed("recovered owner"), [1]);
    } finally {
      child.kill("SIGKILL");
      await provider?.shutdown();
      await recovered?.shutdown();
      await contender.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  // On win32 there is no stale socket file to plant; the concurrent election
  // itself (claim port, then the nonce pipe) is still asserted there.
  it("atomically elects one owner when two starts recover the same stale socket", async (t) => {
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-owner-race-");
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
      if (!WIN32) await leaveStaleUnixSocket(t, paths.socketPath);
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
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-incomplete-frame-");
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
      socket = createConnection(defaultOwnerAddress(stateRoot));
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
    const stateRoot = await createStateRoot("plur1bus-scoped-embedding-frame-timeout-");
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
      socket = createConnection(defaultOwnerAddress(stateRoot));
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

describe("scoped embedding IPC on an explicit address (E3)", () => {
  function e3Embeddings() {
    return {
      model: "fixture/e5",
      dimensions: () => 2,
      embedQuery: async () => [1, 0],
      embedPassage: async () => [0, 1],
      embedBatch: async (texts) => texts.map(() => [0.5, 0.5]),
    };
  }

  // win32 cannot listen on a filesystem socket path; the same explicit-address
  // behaviour runs on a unique named pipe there.
  function explicitUnixAddress() {
    if (WIN32) return { kind: "named-pipe", address: `\\\\.\\pipe\\plur1bus-e3-test-${randomUUID()}` };
    const dir = makeTempDir("e3-sock-");
    chmodSync(dir, 0o700);
    return { kind: "unix-socket", address: join(dir, "e.sock") };
  }

  /** A filesystem unix-socket address on every platform (the lstat refusal path;
   * win32 still accepts an explicit unix-socket address). */
  function realUnixSocketAddress() {
    const dir = makeTempDir("e3-sock-");
    chmodSync(dir, 0o700);
    return { kind: "unix-socket", address: join(dir, "e.sock") };
  }

  /** Whether the explicit address is there: a socket file, or a named pipe that accepts a connection. */
  async function addressEntryExists(address) {
    if (address.kind === "unix-socket") return existsSync(address.address);
    return await new Promise((resolve, reject) => {
      const socket = createConnection(address.address);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", (error) => {
        socket.destroy();
        if (error?.code === "ENOENT") resolve(false);
        else reject(error);
      });
    });
  }

  // Every unclaimed start() connect-probes the stateRoot's claim port (off
  // Linux a loopback TCP port in the dynamic range) and refuses when anything
  // answers. A random temp stateRoot whose port a foreign Windows listener
  // holds failed `first.start()` with owner_already_active (windows-2025,
  // run 37432579022), so these tests take a stateRoot whose claim port was
  // bindable and connection-refused when it was rolled.
  function e3Client(stateRoot, address, fingerprintId = ACTIVE_FINGERPRINT_ID) {
    return new IpcScopedEmbeddingProvider({
      stateRoot,
      model: "fixture/e5",
      dimensions: 2,
      fingerprintId,
      address,
      // Explicit abstract sockets fail closed without a peer uid; this suite's
      // abstract cases are about owner exclusivity, not SO_PEERCRED.
      ...(address?.kind === "abstract-socket" ? { readPeerUid: () => process.getuid() } : {}),
    });
  }

  it("serves a round trip on an explicit unix socket and removes socket and token on shutdown", async () => {
    const stateRoot = await makeClaimableStateRoot("e3-ipc-");
    const address = explicitUnixAddress();
    const server = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings: e3Embeddings(),
      fingerprintId: ACTIVE_FINGERPRINT_ID,
      address,
      claim: false,
    });
    let provider = null;
    try {
      await server.start();
      provider = e3Client(stateRoot, address);
      assert.deepEqual(await provider.embedQuery("q"), [1, 0]);
      // A named pipe has no mode bits and the repo no pipe-ACL reader: engine-windows:posix-only.
      if (address.kind === "unix-socket") assert.equal(statSync(address.address).mode & 0o777, 0o600);
      assert.deepEqual(server.identity, { model: "fixture/e5", dimensions: 2, fingerprintId: ACTIVE_FINGERPRINT_ID });
      assert.equal(Object.isFrozen(server.identity), true);
      assert.equal(server.tokenPath, resolveScopedEmbeddingIpcPaths(stateRoot).tokenPath);
      assert.equal(existsSync(resolveScopedEmbeddingIpcPaths(stateRoot).socketPath), false);
    } finally {
      await provider?.shutdown();
      await server.shutdown();
    }
    assert.equal(await addressEntryExists(address), false);
    assert.equal(existsSync(server.tokenPath), false);
  });

  it("opens no claim listener when claim is false", async () => {
    // The probe binds the claim port itself: a host-reserved port re-rolls.
    const stateRoot = await makeClaimableStateRoot("e3-ipc-");
    const address = explicitUnixAddress();
    const server = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings: e3Embeddings(),
      fingerprintId: ACTIVE_FINGERPRINT_ID,
      address,
      claim: false,
    });
    const probe = createServer();
    try {
      await server.start();
      probe.listen(resolveScopedEmbeddingOwnerClaimAddress(resolveScopedEmbeddingIpcPaths(stateRoot).directory));
      await Promise.race([
        once(probe, "listening"),
        once(probe, "error").then(([error]) => { throw error; }),
      ]);
    } finally {
      if (probe.listening) await new Promise((resolve) => probe.close(resolve));
      await server.shutdown();
    }
  });

  it("serves an abstract socket and refuses a second owner on the same address", {
    skip: process.platform !== "linux" && "abstract sockets are Linux-only",
  }, async () => {
    const stateRoot = await makeClaimableStateRoot("e3-ipc-");
    const address = { kind: "abstract-socket", address: "\0plur1bus-e3-test-" + randomUUID() };
    const options = { stateRoot, embeddings: e3Embeddings(), fingerprintId: ACTIVE_FINGERPRINT_ID, address, claim: false };
    const first = createScopedEmbeddingIpcServer(options);
    const second = createScopedEmbeddingIpcServer(options);
    let provider = null;
    try {
      await first.start();
      provider = e3Client(stateRoot, address);
      assert.deepEqual(await provider.embedQuery("q"), [1, 0]);
      const tokenBefore = readFileSync(first.tokenPath, "utf8");
      await assert.rejects(second.start(), /owner is already active/);
      await second.shutdown();
      assert.equal(readFileSync(first.tokenPath, "utf8"), tokenBefore);
      assert.deepEqual(await provider.embedPassage("still served"), [0, 1]);
    } finally {
      await provider?.shutdown();
      await second.shutdown();
      await first.shutdown();
    }
    assert.equal(existsSync(first.tokenPath), false);
  });

  it("recovers a stale unix socket left at the explicit address", posixSocketFile, async (t) => {
    const stateRoot = await makeClaimableStateRoot("e3-ipc-");
    const address = explicitUnixAddress();
    await leaveStaleUnixSocket(t, address.address);
    const server = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings: e3Embeddings(),
      fingerprintId: ACTIVE_FINGERPRINT_ID,
      address,
      claim: false,
    });
    let provider = null;
    try {
      await server.start();
      provider = e3Client(stateRoot, address);
      assert.deepEqual(await provider.embedBatch(["a", "b"]), [[0.5, 0.5], [0.5, 0.5]]);
      assert.equal(existsSync(resolveScopedEmbeddingIpcPaths(stateRoot).socketPath), false);
    } finally {
      await provider?.shutdown();
      await server.shutdown();
    }
  });

  it("rejects a client with a different fingerprint on the explicit address", async () => {
    const stateRoot = await makeClaimableStateRoot("e3-ipc-");
    const address = explicitUnixAddress();
    const server = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings: e3Embeddings(),
      fingerprintId: ACTIVE_FINGERPRINT_ID,
      address,
      claim: false,
    });
    let provider = null;
    try {
      await server.start();
      provider = e3Client(stateRoot, address, STALE_FINGERPRINT_ID);
      await assert.rejects(provider.embedQuery("q"), /fingerprint does not match/);
      assert.equal(existsSync(resolveScopedEmbeddingIpcPaths(stateRoot).socketPath), false);
    } finally {
      await provider?.shutdown();
      await server.shutdown();
    }
  });

  it("refuses a second unclaimed owner on another address of the same stateRoot", async () => {
    const stateRoot = await makeClaimableStateRoot("e3-ipc-");
    const firstAddress = explicitUnixAddress();
    const secondAddress = explicitUnixAddress();
    const base = { stateRoot, embeddings: e3Embeddings(), fingerprintId: ACTIVE_FINGERPRINT_ID, claim: false };
    const first = createScopedEmbeddingIpcServer({ ...base, address: firstAddress });
    const second = createScopedEmbeddingIpcServer({ ...base, address: secondAddress });
    let provider = null;
    try {
      await first.start();
      provider = e3Client(stateRoot, firstAddress);
      assert.deepEqual(await provider.embedQuery("q"), [1, 0]);
      const tokenBefore = readFileSync(first.tokenPath, "utf8");
      await assert.rejects(second.start(), /owner is already active/);
      await second.shutdown();
      assert.equal(await addressEntryExists(secondAddress), false);
      assert.equal(readFileSync(first.tokenPath, "utf8"), tokenBefore);
      assert.deepEqual(await provider.embedPassage("first still served"), [0, 1]);
    } finally {
      await provider?.shutdown();
      await second.shutdown();
      await first.shutdown();
    }
  });

  it("a foreign wildcard listener on the claim port refuses an unclaimed start, and the fixture rejects that stateRoot", {
    skip: process.platform === "linux" && "Linux claims an abstract socket, not a TCP port",
  }, async (t) => {
    // The windows-2025 flake of the test above, made deterministic: another
    // process's 0.0.0.0 listener on the derived claim port.
    let stateRoot = null;
    let port = null;
    let foreign = null;
    const listenErrors = [];
    for (let attempt = 0; attempt < 5 && !foreign; attempt += 1) {
      const candidateRoot = await makeClaimableStateRoot("e3-ipc-");
      const candidatePort = resolveScopedEmbeddingOwnerClaimAddress(resolveScopedEmbeddingIpcPaths(candidateRoot).directory).port;
      const candidate = createServer((socket) => socket.destroy());
      candidate.listen({ host: "0.0.0.0", port: candidatePort });
      const [listenError] = await Promise.race([once(candidate, "listening").then(() => [null]), once(candidate, "error")]);
      if (listenError) {
        listenErrors.push(`${candidatePort} ${listenError.code}`);
        continue;
      }
      [stateRoot, port, foreign] = [candidateRoot, candidatePort, candidate];
    }
    if (!foreign) {
      t.skip(`no claim port stayed free for the foreign wildcard listener: ${listenErrors.join(", ")}`);
      return;
    }
    const server = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings: e3Embeddings(),
      fingerprintId: ACTIVE_FINGERPRINT_ID,
      address: explicitUnixAddress(),
      claim: false,
    });
    try {
      // Usually connect-accepted; a bind refused beside the wildcard listener
      // or a connect still pending after 1 s (a loaded host) re-rolls as well.
      assert.match(await claimAddressUnavailable(stateRoot), new RegExp(`:${port} (connect-accepted|connect-timeout|EADDRINUSE|EACCES)$`));
      await assert.rejects(server.start(), { code: "scoped_embedding_owner_already_active" });
      assert.equal(existsSync(server.tokenPath), false);
    } finally {
      await server.shutdown();
      if (foreign.listening) await new Promise((resolve) => foreign.close(resolve));
    }
  });

  it("refuses an unclaimed owner beside a live claimed legacy owner of the same stateRoot", async () => {
    const stateRoot = await createStateRoot("e3-ipc-legacy-");
    const address = explicitUnixAddress();
    const legacy = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings: e3Embeddings(),
      fingerprintId: ACTIVE_FINGERPRINT_ID,
    });
    const unclaimed = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings: e3Embeddings(),
      fingerprintId: ACTIVE_FINGERPRINT_ID,
      address,
      claim: false,
    });
    let provider = null;
    try {
      await legacy.start();
      provider = new IpcScopedEmbeddingProvider({
        stateRoot, model: "fixture/e5", dimensions: 2, fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      const tokenBefore = readFileSync(legacy.tokenPath, "utf8");
      await assert.rejects(unclaimed.start(), /owner is already active/);
      await unclaimed.shutdown();
      assert.equal(await addressEntryExists(address), false);
      assert.equal(readFileSync(legacy.tokenPath, "utf8"), tokenBefore);
      assert.deepEqual(await provider.embedQuery("legacy still served"), [1, 0]);
    } finally {
      await provider?.shutdown();
      await unclaimed.shutdown();
      await legacy.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses an unclaimed owner while a claimed legacy owner of the same stateRoot runs in another process", async (t) => {
    const stateRoot = await createStateRoot("e3-ipc-xproc-");
    const address = explicitUnixAddress();
    const tokenPath = resolveScopedEmbeddingIpcPaths(stateRoot).tokenPath;
    let child = null;
    const unclaimed = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings: e3Embeddings(),
      fingerprintId: ACTIVE_FINGERPRINT_ID,
      address,
      claim: false,
    });
    try {
      child = await startOwnerInChild(t, stateRoot);
      const tokenBefore = readFileSync(tokenPath);
      await assert.rejects(unclaimed.start(), /owner is already active/);
      await unclaimed.shutdown();
      assert.equal(await addressEntryExists(address), false, "the unclaimed server never listened");
      assert.deepEqual(readFileSync(tokenPath), tokenBefore, "the legacy owner's token is byte-identical");
    } finally {
      await unclaimed.shutdown();
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("does not delete a token file another owner replaced, on either path", async () => {
    const foreignToken = `${"c".repeat(64)}\n`;
    for (const explicit of [true, false]) {
      const stateRoot = await createStateRoot("e3-ipc-foreign-token-");
      const server = createScopedEmbeddingIpcServer({
        stateRoot,
        embeddings: e3Embeddings(),
        fingerprintId: ACTIVE_FINGERPRINT_ID,
        ...(explicit ? { address: explicitUnixAddress(), claim: false } : {}),
      });
      try {
        await server.start();
        writeFileSync(server.tokenPath, foreignToken, { mode: 0o600 });
        await server.shutdown();
        assert.equal(readFileSync(server.tokenPath, "utf8"), foreignToken, `foreign token kept (explicit=${explicit})`);
      } finally {
        await server.shutdown();
        await rm(stateRoot, { recursive: true, force: true });
      }
    }
  });

  it("refuses a live foreign listener at the explicit address without touching it or the token directory", async () => {
    const stateRoot = await makeClaimableStateRoot("e3-ipc-");
    const address = explicitUnixAddress();
    const directory = resolveScopedEmbeddingIpcPaths(stateRoot).directory;
    writeFileSync(join(directory, "sentinel"), "keep");
    const foreign = createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      foreign.once("error", reject);
      foreign.listen(address.address, resolve);
    });
    const server = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings: e3Embeddings(),
      fingerprintId: ACTIVE_FINGERPRINT_ID,
      address,
      claim: false,
    });
    try {
      const before = readdirSync(directory).sort();
      await assert.rejects(server.start(), /owner is already active/);
      await server.shutdown();
      if (address.kind === "unix-socket") assert.equal(lstatSync(address.address).isSocket(), true);
      assert.deepEqual(readdirSync(directory).sort(), before);
      assert.equal(readFileSync(join(directory, "sentinel"), "utf8"), "keep");
    } finally {
      await server.shutdown();
      await new Promise((resolve) => foreign.close(resolve));
    }
  });

  it("refuses a dangling symlink or a regular file at the explicit address and leaves it untouched", async () => {
    const stateRoot = await makeClaimableStateRoot("e3-ipc-");
    const tokenPath = resolveScopedEmbeddingIpcPaths(stateRoot).tokenPath;
    const dangling = realUnixSocketAddress();
    symlinkSync(join(dangling.address, "..", "missing-target"), dangling.address);
    const regular = realUnixSocketAddress();
    writeFileSync(regular.address, "not a socket");
    for (const address of [dangling, regular]) {
      const server = createScopedEmbeddingIpcServer({
        stateRoot,
        embeddings: e3Embeddings(),
        fingerprintId: ACTIVE_FINGERPRINT_ID,
        address,
        claim: false,
      });
      await assert.rejects(server.start(), /refusing unsafe scoped embedding socket path/);
      await server.shutdown();
      assert.equal(existsSync(tokenPath), false);
    }
    assert.equal(lstatSync(dangling.address).isSymbolicLink(), true);
    assert.equal(readFileSync(regular.address, "utf8"), "not a socket");
  });

  it("rejects invalid address and claim options", () => {
    const stateRoot = makeTempDir("e3-ipc-");
    const base = { stateRoot, embeddings: e3Embeddings(), fingerprintId: ACTIVE_FINGERPRINT_ID };
    for (const address of [
      null,
      "/tmp/e.sock",
      { kind: "tcp", address: "127.0.0.1:1" },
      { kind: "unix-socket", address: "" },
      { kind: "abstract-socket" },
    ]) {
      assert.throws(() => createScopedEmbeddingIpcServer({ ...base, address }), /IPC address is invalid/);
    }
    for (const claim of ["yes", 1, null]) {
      assert.throws(
        () => createScopedEmbeddingIpcServer({ ...base, address: explicitUnixAddress(), claim }),
        /claim must be a boolean/,
      );
    }
    assert.throws(
      () => new IpcScopedEmbeddingProvider({
        stateRoot, model: "fixture/e5", dimensions: 2, fingerprintId: ACTIVE_FINGERPRINT_ID, address: { kind: "tcp", address: "x" },
      }),
      /IPC address is invalid/,
    );
    for (const Client of [IpcScopedEmbeddingProvider, ReloadSafeIpcScopedEmbeddingProvider]) {
      assert.throws(
        () => new Client({
          stateRoot, model: "fixture/e5", dimensions: 2, fingerprintId: ACTIVE_FINGERPRINT_ID, address: null,
        }),
        /IPC address is invalid/,
        `${Client.name} rejects address: null like the server`,
      );
    }
  });
});
