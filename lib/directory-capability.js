import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const DIRECTORY_FLAGS = (constants.O_RDONLY ?? 0)
  | (constants.O_DIRECTORY ?? 0)
  | (constants.O_NOFOLLOW ?? 0)
  | (constants.O_CLOEXEC ?? 0);
let capabilitySupport;

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSupported() {
  if (!stableDirectoryCapabilitiesSupported()) {
    throw new Error(
      `stable directory capabilities are unavailable on ${process.platform}; explicit named namespace routing is disabled`,
    );
  }
}

/** Return whether this runtime exposes the primitives required for fd-backed directory routing. */
export function stableDirectoryCapabilitiesSupported() {
  if (capabilitySupport !== undefined) return capabilitySupport;
  if (process.platform === "win32" || !constants.O_DIRECTORY || !constants.O_NOFOLLOW) {
    capabilitySupport = false;
    return false;
  }
  let fd = null;
  try {
    fd = openFd(sep);
    const stat = fstatSync(fd);
    fdAlias(fd, { dev: stat.dev, ino: stat.ino });
    capabilitySupport = true;
  } catch (_error) {
    capabilitySupport = false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return capabilitySupport;
}

function fdAlias(fd, identity) {
  const candidates = process.platform === "linux"
    ? [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]
    : [`/dev/fd/${fd}`];
  for (const candidate of candidates) {
    try {
      if (sameIdentity(statSync(candidate), identity)) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
  }
  throw new Error("no verified fd-backed directory alias is available for secure namespace routing");
}

function validateSegment(name) {
  if (
    typeof name !== "string"
    || !name
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\0")
  ) {
    throw new TypeError(`invalid directory capability segment: ${String(name)}`);
  }
  return name;
}

function openFd(path) {
  return openSync(path, DIRECTORY_FLAGS);
}

/** A live descriptor-bound directory identity used for race-safe child routing. */
export class DirectoryCapability {
  constructor(fd, displayPath) {
    this.fd = fd;
    this.displayPath = displayPath;
    this.identity = Object.freeze((() => {
      const stat = fstatSync(fd);
      return { dev: stat.dev, ino: stat.ino };
    })());
    this.path = fdAlias(fd, this.identity);
    this.closed = false;
  }

  /** Assert that the held descriptor still denotes its original directory. */
  assertOpen() {
    if (this.closed) throw new Error(`directory capability is closed: ${this.displayPath}`);
    if (!sameIdentity(fstatSync(this.fd), this.identity)) {
      throw new Error(`directory capability identity changed: ${this.displayPath}`);
    }
  }

  /** Open one non-symlink child relative to this held directory, optionally creating it. */
  openChild(name, { create = false } = {}) {
    this.assertOpen();
    const segment = validateSegment(name);
    const childPath = `${this.path}/${segment}`;
    let fd;
    try {
      fd = openFd(childPath);
    } catch (error) {
      if (!create || error?.code !== "ENOENT") throw error;
      try {
        mkdirSync(childPath);
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
      fd = openFd(childPath);
    }
    try {
      return new DirectoryCapability(fd, resolve(this.displayPath, segment));
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  /** Return whether a child name still resolves to a supplied held identity. */
  childMatches(name, childCapability) {
    this.assertOpen();
    childCapability.assertOpen();
    let current;
    try {
      current = this.openChild(name);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP") return false;
      throw error;
    }
    try {
      return sameIdentity(current.identity, childCapability.identity);
    } finally {
      current.close();
    }
  }

  /** Close the held descriptor. Safe to call repeatedly. */
  close() {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

/** Open/create an absolute directory one segment at a time through held parent descriptors. */
export function openDirectoryCapability(path, { create = false } = {}) {
  assertSupported();
  if (typeof path !== "string" || !path || !isAbsolute(path)) {
    throw new TypeError("directory capability path must be absolute");
  }
  const absolutePath = resolve(path);
  const segments = absolutePath.split(sep).filter(Boolean);
  let currentFd = openFd(sep);
  let current;
  try {
    current = new DirectoryCapability(currentFd, sep);
    currentFd = null;
    for (const segment of segments) {
      const next = current.openChild(segment, { create });
      current.close();
      current = next;
    }
    current.displayPath = absolutePath;
    return current;
  } catch (error) {
    if (currentFd !== null) closeSync(currentFd);
    current?.close();
    throw error;
  }
}

/** Verify that an absolute pathname still names the held directory identity. */
export function pathMatchesDirectoryCapability(path, capability) {
  let current;
  try {
    current = openDirectoryCapability(path);
    return sameIdentity(current.identity, capability.identity);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP") return false;
    throw error;
  } finally {
    current?.close();
  }
}
