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
 * Product note: the same collision makes the owner of a real stateRoot fail
 * to start on such a host, permanently for that path (open point in the
 * Windows round-4 ledger); this helper only keeps each test about the
 * behaviour it names.
 */

import { rmSync } from "node:fs";
import { createServer } from "node:net";

import {
  resolveScopedEmbeddingIpcPaths,
  resolveScopedEmbeddingOwnerClaimAddress,
} from "../../lib/providers/scoped-embedding-ipc.js";
import { makeTempDir } from "./temp-dir.js";

const MAX_ATTEMPTS = 20;

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
 * @param {string} prefix `mkdtemp` prefix.
 * @param {string} [root] Parent directory.
 * @returns {Promise<string>} A stateRoot whose claim address was bindable just now.
 */
export async function makeClaimableStateRoot(prefix, root) {
  const errors = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stateRoot = makeTempDir(prefix, root);
    if (process.platform === "linux") return stateRoot;
    const claim = resolveScopedEmbeddingOwnerClaimAddress(resolveScopedEmbeddingIpcPaths(stateRoot).directory);
    const error = await tryBind(claim);
    if (!error) return stateRoot;
    if (error.code !== "EACCES" && error.code !== "EADDRINUSE") throw error;
    errors.push(`${claim.host}:${claim.port} ${error.code}`);
    rmSync(stateRoot, { recursive: true, force: true });
  }
  throw new Error(`no bindable owner claim port in ${MAX_ATTEMPTS} stateRoots: ${errors.join(", ")}`);
}
