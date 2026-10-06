/**
 * tests/scoped-embedding-ipc-trust.test.js — K8-I1: Linux serve() default is
 * a filesystem socket; the client checks server identity before sending the
 * token or memory text.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ipcAddress, unixSocketPathMaxBytes } from "../lib/platform.js";
import {
  IpcScopedEmbeddingProvider,
  assertIpcPeerIdentity,
  assertTrustedUnixSocketPath,
  resolveScopedEmbeddingIpcPaths,
} from "../lib/providers/scoped-embedding-ipc.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const posixOnly = { skip: process.platform === "win32" && "engine-windows:posix-only (unix-socket owner and mode)" };
const ACTIVE_FINGERPRINT_ID = `embedding:v1:sha256:${"a".repeat(64)}`;
const MARKER = "zzK8IpcTrustMarker_A91C_oat";
// darwin: $TMPDIR realpaths past the 103-byte sun_path limit.
const shortTmp = process.platform === "darwin" ? "/tmp" : tmpdir();

function listenUnix(path) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("K8-I1 embedding IPC trust", () => {
  it("linux ipcAddress is a filesystem socket, not an abstract name", () => {
    const address = ipcAddress("/var/lib/plur1bus/control/embedding-ipc", { platform: "linux" });
    assert.equal(address.kind, "unix-socket");
    assert.equal(address.address, "/var/lib/plur1bus/control/embedding-ipc/owner.sock");
    assert.equal(address.address.includes("\0"), false);
  });

  it("refuses a unix socket in a group-writable directory", posixOnly, () => {
    const dir = makeTempDir("e3-trust-gw-");
    chmodSync(dir, 0o770);
    assert.throws(
      () => assertTrustedUnixSocketPath(join(dir, "e.sock")),
      (error) => {
        assert.equal(error.code, "scoped_embedding_untrusted_peer");
        assert.match(error.message, /private \(0700\)/);
        return true;
      },
    );
  });

  it("refuses a unix socket whose directory is owned by another uid", posixOnly, () => {
    const dir = makeTempDir("e3-trust-foreign-");
    chmodSync(dir, 0o700);
    assert.throws(
      () => assertTrustedUnixSocketPath(join(dir, "e.sock"), { euid: process.getuid() + 1 }),
      (error) => {
        assert.equal(error.code, "scoped_embedding_untrusted_peer");
        assert.match(error.message, /not owned by this user/);
        return true;
      },
    );
  });

  it("the client does not send token or text to a group-writable socket", posixOnly, async () => {
    const stateRoot = makeTempDir("e3-tgw-", shortTmp);
    const paths = resolveScopedEmbeddingIpcPaths(stateRoot);
    writeFileSync(paths.tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });

    const openDir = makeTempDir("e3-topen-", shortTmp);
    chmodSync(openDir, 0o770);
    const sockPath = join(openDir, "e.sock");
    const received = [];
    const server = createServer((socket) => {
      socket.on("data", (chunk) => received.push(Buffer.from(chunk)));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });
    let client;
    try {
      client = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/e5",
        dimensions: 2,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
        address: { kind: "unix-socket", address: sockPath },
      });
      await assert.rejects(
        client.embedQuery(`secret ${MARKER}`),
        (error) => error.code === "scoped_embedding_untrusted_peer",
      );
      assert.equal(received.length, 0);
    } finally {
      await client?.shutdown();
      await closeServer(server);
    }
  });

  it("the client does not send token or text to a foreign-owned directory", posixOnly, async () => {
    const stateRoot = makeTempDir("e3-tfor-", shortTmp);
    const dir = makeTempDir("e3-town-", shortTmp);
    chmodSync(dir, 0o700);
    const sockPath = join(dir, "e.sock");
    const received = [];
    const server = await listenUnix(sockPath);
    server.on("connection", (socket) => {
      socket.on("data", (chunk) => received.push(Buffer.from(chunk)));
    });
    const paths = resolveScopedEmbeddingIpcPaths(stateRoot);
    writeFileSync(paths.tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
    let client;
    try {
      client = new IpcScopedEmbeddingProvider({
        stateRoot,
        model: "fixture/e5",
        dimensions: 2,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
        address: { kind: "unix-socket", address: sockPath },
        euid: process.getuid() + 1,
      });
      await assert.rejects(
        client.embedQuery(`secret ${MARKER}`),
        (error) => error.code === "scoped_embedding_untrusted_peer",
      );
      assert.equal(received.length, 0);
    } finally {
      await client?.shutdown();
      await closeServer(server);
    }
  });

  it("maps a missing socket file to ipc_unavailable", posixOnly, () => {
    const dir = makeTempDir("e3-trust-gone-");
    chmodSync(dir, 0o700);
    assert.throws(
      () => assertTrustedUnixSocketPath(join(dir, "e.sock")),
      (error) => {
        assert.equal(error.code, "scoped_embedding_ipc_unavailable");
        assert.equal(error.cause?.code, "ENOENT");
        return true;
      },
    );
  });

  it("refuses a unix-socket path Node would silently truncate", () => {
    const longPath = `/${"x".repeat(130)}/owner.sock`;
    assert.throws(
      () => assertTrustedUnixSocketPath(longPath, { platform: "linux" }),
      (error) => error.code === "scoped_embedding_socket_path_too_long",
    );
    assert.throws(
      () => assertTrustedUnixSocketPath(longPath, { platform: "darwin" }),
      (error) => error.code === "scoped_embedding_socket_path_too_long",
    );
  });

  it("refuses a long stateRoot before creating IPC children", posixOnly, () => {
    const parent = makeTempDir("e3-trust-long-", shortTmp);
    const suffix = "/control/embedding-ipc/owner.sock";
    const resolvedParent = realpathSync(parent);
    const over = unixSocketPathMaxBytes() + 1 - Buffer.byteLength(resolvedParent) - 1 - Buffer.byteLength(suffix);
    const stateRoot = join(parent, "x".repeat(Math.max(over, 1)));
    assert.throws(
      () => resolveScopedEmbeddingIpcPaths(stateRoot),
      (error) => {
        assert.equal(error.code, "scoped_embedding_socket_path_too_long");
        assert.match(error.message, /shorter state root/i);
        return true;
      },
    );
    assert.equal(existsSync(join(stateRoot, "control")), false);
  });

  it("refuses an abstract socket when the peer uid cannot be read", () => {
    assert.throws(
      () => assertIpcPeerIdentity({}, `\0plur1bus-e3-test-${randomUUID()}`, {
        platform: "linux",
        euid: 1000,
        readPeerUid: () => null,
      }),
      (error) => {
        assert.equal(error.code, "scoped_embedding_untrusted_peer");
        assert.match(error.message, /verified peer uid/);
        return true;
      },
    );
  });

  it("refuses an abstract socket whose peer uid is not this user", () => {
    assert.throws(
      () => assertIpcPeerIdentity({}, "\0plur1bus-embedding-x", {
        platform: "linux",
        euid: 1000,
        readPeerUid: () => 1001,
      }),
      (error) => {
        assert.equal(error.code, "scoped_embedding_untrusted_peer");
        assert.match(error.message, /not this user/);
        return true;
      },
    );
  });
});
