/**
 * tests/platform.test.js — lib/platform.js, including the win32 branches,
 * which are reached both by the explicit `platform` option and by stubbing
 * `process.platform`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { closeSync, mkdirSync, openSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalIdentityPath,
  ipcAddress,
  isFilesystemPath,
  isUnsafeLink,
  securePath,
} from "../lib/platform.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function withStubbedPlatform(value, body) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("lib/platform isFilesystemPath", () => {
  it("accepts an ordinary path and rejects pipe and abstract addresses", () => {
    assert.equal(isFilesystemPath("/tmp/x"), true);
    assert.equal(isFilesystemPath("\\\\.\\pipe\\plur1bus-embedding-abc"), false);
    assert.equal(isFilesystemPath("\0plur1bus-embedding-abc"), false);
    assert.equal(isFilesystemPath(""), false);
    assert.equal(isFilesystemPath(undefined), false);
  });
});

// Mode bits and filesystem Unix sockets are POSIX; on win32 chmod only toggles
// the read-only bit and a socket path cannot be listened on.
const posixModes = { skip: process.platform === "win32" && "engine-windows:posix-only (needs POSIX modes; no file-ACL reader in the repo to assert instead)" };

describe("lib/platform securePath", () => {
  it("chmods a regular file on POSIX", posixModes, () => {
    const dir = makeTempDir("plur1bus-platform-");
    const file = join(dir, "state.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    const result = securePath(file, { mode: 0o600, platform: "linux" });
    assert.deepEqual(result, { applied: true, mechanism: "chmod" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("chmods through a file descriptor when one is given", posixModes, () => {
    const dir = makeTempDir("plur1bus-platform-fd-");
    const file = join(dir, "report.json");
    const fd = openSync(file, "wx", 0o644);
    try {
      const result = securePath(file, { mode: 0o600, fd, platform: "linux" });
      assert.deepEqual(result, { applied: true, mechanism: "chmod" });
    } finally {
      closeSync(fd);
    }
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("secures a live unix domain socket rather than refusing it", { skip: process.platform === "win32" && "engine-windows:posix-only (POSIX unix-socket and mode semantics)" }, async () => {
    const dir = makeTempDir("plur1bus-platform-sock-");
    const socketPath = join(dir, "owner.sock");
    const server = createServer();
    await new Promise((done) => server.listen(socketPath, done));
    try {
      const result = securePath(socketPath, { mode: 0o600, platform: "linux" });
      assert.deepEqual(result, { applied: true, mechanism: "chmod" });
      assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it("refuses a named pipe instead of throwing", () => {
    const result = securePath("\\\\.\\pipe\\plur1bus-embedding-abc", { platform: "win32" });
    assert.deepEqual(result, { applied: false, reason: "not-a-filesystem-path" });
  });

  it("runs an icacls ACL grant on win32", () => {
    const calls = [];
    const result = securePath("C:\\state\\owner.token", {
      platform: "win32",
      username: "tester",
      execFile: (...args) => { calls.push(args); },
    });
    assert.deepEqual(result, { applied: true, mechanism: "acl" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "icacls");
    assert.deepEqual(calls[0][1], [
      "C:\\state\\owner.token",
      "/inheritance:r",
      "/grant:r",
      "tester:(F)",
    ]);
  });

  it("reaches the win32 branch through a stubbed process.platform", () => {
    const calls = [];
    const result = withStubbedPlatform("win32", () => securePath("C:\\state\\owner.token", {
      username: "tester",
      execFile: (...args) => { calls.push(args); },
    }));
    assert.deepEqual(result, { applied: true, mechanism: "acl" });
    assert.equal(calls.length, 1);
  });

  it("returns acl-tool-unavailable when execFile throws ENOENT", () => {
    const result = securePath("C:\\state\\owner.token", {
      platform: "win32",
      username: "tester",
      execFile: () => { const err = new Error("icacls not found"); err.code = "ENOENT"; throw err; },
    });
    assert.deepEqual(result, { applied: false, reason: "acl-tool-unavailable" });
  });

  it("rethrows a non-ENOENT error from execFile", () => {
    const testError = new Error("permission denied");
    testError.code = "EACCES";
    assert.throws(
      () => securePath("C:\\state\\owner.token", {
        platform: "win32",
        username: "tester",
        execFile: () => { throw testError; },
      }),
      testError,
    );
  });
});

describe("lib/platform ipcAddress", () => {
  it("returns a filesystem socket on linux", () => {
    const address = ipcAddress("/var/lib/plur1bus", { platform: "linux" });
    assert.deepEqual(address, { kind: "unix-socket", address: "/var/lib/plur1bus/owner.sock" });
  });

  it("returns a named pipe on win32", () => {
    const address = ipcAddress("C:\\ProgramData\\plur1bus", { platform: "win32" });
    assert.equal(address.kind, "named-pipe");
    assert.match(address.address, /^\\\\\.\\pipe\\plur1bus-embedding-[0-9a-f]{32}$/);
  });

  it("returns a filesystem socket on darwin", () => {
    const address = ipcAddress("/Users/x/.plur1bus", { platform: "darwin" });
    assert.deepEqual(address, { kind: "unix-socket", address: "/Users/x/.plur1bus/owner.sock" });
  });

  it("is deterministic and distinct per state root", () => {
    const a = ipcAddress("/a", { platform: "linux" });
    const b = ipcAddress("/a", { platform: "linux" });
    const c = ipcAddress("/b", { platform: "linux" });
    assert.equal(a.address, b.address);
    assert.notEqual(a.address, c.address);
  });

  it("refuses a unix-socket path Node would silently truncate", () => {
    const longRoot = `/${"x".repeat(130)}`;
    assert.throws(
      () => ipcAddress(longRoot, { platform: "linux" }),
      (error) => error.code === "scoped_embedding_socket_path_too_long",
    );
    assert.throws(
      () => ipcAddress(longRoot, { platform: "darwin" }),
      (error) => error.code === "scoped_embedding_socket_path_too_long",
    );
  });
});

describe("lib/platform isUnsafeLink", () => {
  it("is true for a symlink and false for a real file", () => {
    const dir = makeTempDir("plur1bus-platform-link-");
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    writeFileSync(real, "x");
    symlinkSync(real, link);
    assert.equal(isUnsafeLink(link, { platform: "linux" }), true);
    assert.equal(isUnsafeLink(real, { platform: "linux" }), false);
  });

  it("is false for a missing path and for a non-filesystem address", () => {
    assert.equal(isUnsafeLink("/nonexistent/plur1bus/xyz", { platform: "linux" }), false);
    assert.equal(isUnsafeLink("\\\\.\\pipe\\x", { platform: "win32" }), false);
  });

  it("accepts a pre-read stat so callers need not lstat twice", () => {
    const dir = makeTempDir("plur1bus-platform-stat-");
    const real = join(dir, "real.txt");
    writeFileSync(real, "x");
    assert.equal(isUnsafeLink(real, { platform: "linux", stat: { isSymbolicLink: () => true } }), true);
  });

  it("on win32 treats a path whose native realpath differs as a reparse point", () => {
    const dir = makeTempDir("plur1bus-platform-junction-");
    const real = join(dir, "target");
    const link = join(dir, "junction");
    mkdirSync(real);
    symlinkSync(real, link, "dir");
    // The stat says "not a symlink" (as Windows reports a junction); the
    // realpath comparison is what catches it.
    assert.equal(
      isUnsafeLink(link, { platform: "win32", stat: { isSymbolicLink: () => false } }),
      true,
    );
  });
});

describe("lib/platform isUnsafeLink (win32 ancestors)", () => {
  // Windows run tc3: every file under C:\Users\RUNNER~1\AppData\Local\Temp was
  // "unsafe", because realpath expands the 8.3 ancestor. An ancestor that
  // resolves elsewhere (a short name, another case, a linked parent) is not a
  // link at the entry itself; a symlinked parent stands in for it here.
  it("does not treat an entry below a differently spelled ancestor as a link", () => {
    const dir = makeTempDir("plur1bus-platform-ancestor-");
    const real = join(dir, "real");
    mkdirSync(real);
    writeFileSync(join(real, "file.txt"), "x");
    const alias = join(dir, "alias");
    symlinkSync(real, alias, "dir");
    assert.equal(isUnsafeLink(join(alias, "file.txt"), { platform: "win32", stat: { isSymbolicLink: () => false } }), false);
    // The link itself is still refused.
    assert.equal(isUnsafeLink(alias, { platform: "win32", stat: { isSymbolicLink: () => false } }), true);
  });

  it("accepts a real file in the host temp directory (8.3 ancestors on Windows runners)", () => {
    const file = join(makeTempDir("plur1bus-platform-tmpfile-"), "owner-pipe.nonce");
    writeFileSync(file, "x");
    assert.equal(isUnsafeLink(file), false);
    assert.equal(isUnsafeLink(file, { platform: "win32" }), false);
  });
});

describe("lib/platform canonicalIdentityPath", () => {
  it("resolves a real directory on the host (POSIX keeps case; win32 folds it)", () => {
    const dir = makeTempDir("plur1bus-platform-Canon-");
    // realpathSync, not the raw path: on macOS os.tmpdir() is /var -> /private/var.
    if (process.platform === "win32") {
      // The POSIX flavour cannot resolve a drive path on a win32 host (it
      // prefixes the cwd); the host's own platform is the real case there.
      assert.equal(canonicalIdentityPath(dir), realpathSync(dir).replace(/\//g, "\\").toLowerCase());
      assert.match(canonicalIdentityPath(dir), /canon-/);
      return;
    }
    assert.equal(canonicalIdentityPath(dir, { platform: "linux" }), realpathSync(dir));
    assert.match(canonicalIdentityPath(dir, { platform: "linux" }), /Canon-/);
  });

  it("folds case and separators on win32 so one workspace hashes once", () => {
    const a = canonicalIdentityPath("C:\\Users\\X\\Work", { platform: "win32" });
    const b = canonicalIdentityPath("c:/users/x/work", { platform: "win32" });
    assert.equal(a, b);
  });

  it("falls back to the absolute path when the target does not exist", () => {
    const value = canonicalIdentityPath("/nonexistent/plur1bus/ws", { platform: "linux" });
    assert.equal(value, "/nonexistent/plur1bus/ws");
  });
});
