/**
 * lib/peercred.js — optional Linux SO_PEERCRED (uid of the socket peer).
 *
 * Node has no public API for this. When `koffi` is resolvable (OpenClaw
 * hoists it; it is not a plugin dependency) we call `getsockopt(SO_PEERCRED)`.
 * Anything else returns null so the caller can fail closed (abstract sockets)
 * or fall back to filesystem owner + directory mode (unix-socket paths).
 */

import { createRequire } from "node:module";

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

/** @type {null | undefined | { readUid: (fd: number) => number | null }} */
let loaded;

function loadReader() {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (process.platform !== "linux") return loaded;
  try {
    const koffi = createRequire(import.meta.url)("koffi");
    const libc = koffi.load(null);
    const Ucred = koffi.struct("ucred", {
      pid: "int",
      uid: "uint32",
      gid: "uint32",
    });
    const getsockopt = libc.func(
      "int getsockopt(int sockfd, int level, int optname, _Out_ ucred *optval, _Inout_ uint32_t *optlen)",
    );
    const size = koffi.sizeof(Ucred);
    loaded = {
      readUid(fd) {
        const cred = {};
        const len = [size];
        if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, cred, len) !== 0) return null;
        return Number.isInteger(cred.uid) ? cred.uid : null;
      },
    };
  } catch {
    loaded = null;
  }
  return loaded;
}

/**
 * Peer uid of a connected Linux Unix socket, or null when it cannot be read.
 * @param {import("node:net").Socket} socket Connected socket.
 * @returns {number | null} Peer uid, or null.
 */
export function readLinuxPeerUid(socket) {
  const reader = loadReader();
  if (!reader) return null;
  const fd = socket?._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) return null;
  try {
    return reader.readUid(fd);
  } catch {
    return null;
  }
}

/** Test-only: drop the cached koffi binding. */
export function resetLinuxPeercredForTests() {
  loaded = undefined;
}
