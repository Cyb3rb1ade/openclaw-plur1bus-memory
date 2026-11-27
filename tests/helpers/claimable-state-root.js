/**
 * tests/helpers/claimable-state-root.js
 *
 * A temporary stateRoot whose scoped-embedding owner claim address can be
 * bound on this host.
 *
 * Off Linux the owner claim is a loopback TCP port derived from the private
 * IPC directory (49152 + digest % 16384). A random temp directory therefore
 * lands on a random port in the dynamic range, and on a Windows runner a few
 * of those are not ours to bind: Hyper-V/WinNAT excluded port ranges and
 * system services that hold a port exclusively answer `listen EACCES`
 * (windows-2025 tc6: 127.0.0.1:49725, the only port EACCES in every Windows
 * run so far). Such a stateRoot's owner fails to start for a reason that has
 * nothing to do with the behaviour under test, so the fixture rolls a new
 * directory instead. Linux claims an abstract socket and never re-rolls.
 *
 * A bindable port is not enough for an unclaimed (explicit-address) owner:
 * it connect-probes the claim port and refuses with
 * `scoped_embedding_owner_already_active` when anything answers. On Windows a
 * 127.0.0.1 bind succeeds beside another process's non-exclusive 0.0.0.0
 * listener on the same port, so the fixture also re-rolls when a connect to
 * the claim address is accepted after its own bind is closed.
 *
 * Product note: the same collision makes the owner of a real stateRoot fail
 * to start on such a host, permanently for that path (open point in the
 * Windows round-4 ledger); this helper only keeps each test about the
 * behaviour it names.
 */

import { rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";

import {
  resolveScopedEmbeddingIpcPaths,
  resolveScopedEmbeddingOwnerClaimAddress,
} from "../../lib/providers/scoped-embedding-ipc.js";
import { makeTempDir } from "./temp-dir.js";

const MAX_ATTEMPTS = 20;
// The product probe treats a connect that neither succeeds nor is refused
// within 500 ms as a live owner; anything this slow is not a free port either.
const CONNECT_PROBE_TIMEOUT_MS = 1_000;

/**
 * @param {object} address A `net.Server#listen` address.
 * @returns {Promise<NodeJS.ErrnoException | null>} The bind error, or null once bound and closed again.
 */
function tryBind(address) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error) => resolve(error));
    server.listen(address, () => server.close(() => resolve(null)));
  });
}

/**
 * Whether something accepts a TCP connection on the claim address. An
 * unclaimed owner connect-probes exactly this address and refuses to start
 * when it answers, so a foreign listener here reads as a live owner.
 * @param {{host: string, port: number}} address Claim address.
 * @returns {Promise<string | null>} Why the address is occupied, or null when the connection is refused.
 */
function probeConnect(address) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: address.host, port: address.port });
    let settled = false;
    // setImmediate: after an event-loop stall the timer phase runs before the
    // poll phase, so a connect that completed meanwhile is delivered first.
    const timer = setTimeout(() => setImmediate(() => finish("connect-timeout")), CONNECT_PROBE_TIMEOUT_MS);
    function finish(reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reason);
    }
    socket.once("connect", () => finish("connect-accepted"));
    socket.once("error", (error) => finish(error?.code === "ECONNREFUSED" ? null : `connect-${error?.code ?? "error"}`));
  });
}

/**
 * Why this stateRoot's owner claim address is unusable for a test owner, or
 * null when it was bindable and refused connections just now (off Linux).
 * @param {string} stateRoot PLUR1BUS state root.
 * @returns {Promise<string | null>} `host:port reason`, or null.
 */
export async function claimAddressUnavailable(stateRoot) {
  const claim = resolveScopedEmbeddingOwnerClaimAddress(resolveScopedEmbeddingIpcPaths(stateRoot).directory);
  const error = await tryBind(claim);
  if (error && error.code !== "EACCES" && error.code !== "EADDRINUSE") throw error;
  // A successful 127.0.0.1 bind does not prove the port is free: Windows (and
  // macOS, as libuv sets SO_REUSEADDR) lets it coexist with another
  // process's wildcard (0.0.0.0) listener on the same port, e.g. the RPC
  // services in the Windows dynamic range. Once our bind is closed again, a
  // connect reaches that listener, and the unclaimed-owner probe takes it
  // for a live owner.
  const occupied = error ? error.code : await probeConnect(claim);
  return occupied ? `${claim.host}:${claim.port} ${occupied}` : null;
}

/**
 * @param {string} prefix `mkdtemp` prefix.
 * @param {string} [root] Parent directory.
 * @returns {Promise<string>} A stateRoot whose claim address was bindable, and refused connections, just now.
 */
export async function makeClaimableStateRoot(prefix, root) {
  const errors = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stateRoot = makeTempDir(prefix, root);
    if (process.platform === "linux") return stateRoot;
    const occupied = await claimAddressUnavailable(stateRoot);
    if (!occupied) return stateRoot;
    errors.push(occupied);
    rmSync(stateRoot, { recursive: true, force: true });
  }
  throw new Error(`no bindable owner claim port in ${MAX_ATTEMPTS} stateRoots: ${errors.join(", ")}`);
}
