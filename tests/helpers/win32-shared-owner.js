/**
 * tests/helpers/win32-shared-owner.js — make an engine's verified-path shared
 * memory root usable on an elevated Windows runner.
 *
 * GitHub's Windows runners run elevated, so every directory the test process
 * creates is owned by BUILTIN\Administrators, not by the runner user. The
 * verified-path shared pool (ADR 0001, E4-R12) deliberately refuses a base or
 * root with a foreign owner (`unsafe-root`), so every share in such a test
 * answered `storage` ("memory write failed"). The owner checks are
 * deliberately not loosened (ruling EW-R4): on a real elevated Windows gateway
 * shared writes are refused the same way. That is a documented known
 * limitation, `engine-windows:elevated-owner` (docs/engine-api.md, "Shared
 * memory on macOS and Windows"; CHANGELOG). This helper only makes the suite
 * exercise the success path the way an unelevated user's machine would.
 *
 * This helper does what tests/b13-shared-memory-verified-path.test.js's
 * "user-owned, owner-only base and root" case does: it pre-creates the base
 * and `.plur1bus-shared` root and hands both to the current user with an
 * owner-only ACL. It is a no-op on every other platform.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { internalsOf } from "../../engine/internals.js";
import { SHARED_ROOT_SEGMENT } from "../../lib/shared-memory-pool.js";

/**
 * Hand a directory tree root to the current Windows user (no-op elsewhere).
 * @param {string} baseDir Shared memory base directory (the pool's `baseDir`).
 * @param {{platform?: string}} [options]
 * @returns {string} `baseDir`.
 */
export function prepareWin32SharedBase(baseDir, { platform = process.platform } = {}) {
  if (platform !== "win32") return baseDir;
  const root = join(baseDir, SHARED_ROOT_SEGMENT);
  mkdirSync(root, { recursive: true });
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username;
  const icacls = (args) => execFileSync("icacls", args, { stdio: "ignore", windowsHide: true });
  icacls([baseDir, "/setowner", user]);
  icacls([root, "/setowner", user]);
  icacls([root, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)(F)`]);
  return baseDir;
}

/**
 * {@link prepareWin32SharedBase} for an engine's own shared memory pool.
 * @param {object} engine An Engine from createEngine().
 * @returns {object} `engine`.
 */
export function prepareEngineSharedBase(engine) {
  if (process.platform !== "win32") return engine;
  prepareWin32SharedBase(internalsOf(engine).sharedMemoryPool.baseDir);
  return engine;
}
