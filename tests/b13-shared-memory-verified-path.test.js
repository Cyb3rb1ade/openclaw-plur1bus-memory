/**
 * tests/b13-shared-memory-verified-path.test.js — E4 Task 10 (ADR 0001,
 * Option B): `SharedMemoryPool` in verified-path mode.
 *
 * The POSIX cases force `{ mode: "verified-path" }` so they run on Linux as
 * well as on macOS CI; they need POSIX modes and skip on win32. The win32
 * case runs only on real Windows (windows-latest CI) and exercises the real
 * `icacls` / PowerShell ACL path of Task 9.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSyncBounded } from "./helpers/run-sync.js";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, sep } from "node:path";

import {
  SHARED_MEMORY_UNSUPPORTED,
  SharedMemoryPool,
  defaultSharedMemoryMode,
} from "../lib/shared-memory-pool.js";
import { migrateLegacySharedRows } from "../lib/shared-memory-migration.js";
import { readDirectoryAcl } from "../lib/platform.js";
import { AgentDbPool } from "../index.js";
import { createEngine } from "../engine/create-engine.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import {
  config,
  flatEmbedder,
  freshBaseDbPath,
  principal,
  seedAndGetId,
  twoWorkspaceHost,
  userAgent,
} from "./helpers/shared-workspace-engine.js";

const DIM = 384;
const workspaceA = { workspaceIdentity: "workspace:v1:alpha" };
const userA = { userPrincipal: "user:v1:telegram:one" };
const posixOnly = { skip: process.platform === "win32" ? "needs POSIX modes" : false };
const SHARED = ".plur1bus-shared";

function recordingLogger() {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args), info() {}, debug() {}, error() {} };
}

function row(text) {
  const vector = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
  return {
    id: randomUUID(),
    text,
    vector,
    category: "fact",
    scope: "workspace",
    agentId: "agent-a",
    storedBy: "agent-a",
    createdAt: Date.now(),
  };
}

function verifiedPool(base, logger = recordingLogger()) {
  return new SharedMemoryPool(base, DIM, AgentDbPool, logger, { mode: "verified-path" });
}

describe("SharedMemoryPool verified-path mode (E4 Task 10, ADR 0001)", () => {
  it("(a) verified-path mode writes and reads a workspace pool", posixOnly, async () => {
    const base = makeTempDir("b13-vp-a-");
    const pool = verifiedPool(base);
    try {
      assert.deepEqual(pool.support(), { supported: true, mode: "verified-path" });
      const stored = row("The synthetic shared fact is stored.");
      let dbPath;
      await pool.withWorkspaceDb(workspaceA, async (db) => {
        dbPath = db.dbPath;
        await db.store(stored);
      });
      const read = await pool.withWorkspaceReadDb(workspaceA, (db) => db.getById(stored.id));
      assert.equal(read?.text, stored.text);
      assert.equal(statSync(join(base, SHARED)).mode & 0o777, 0o700);
      assert.ok(dbPath.startsWith(realpathSync.native(base) + sep), `${dbPath} is under the canonical base`);
      assert.deepEqual(pool.support(), { supported: true, mode: "verified-path" });
    } finally {
      await pool.shutdown();
    }
  });

  it("(b) a symlink swap of the shared root before a lease fails closed", posixOnly, async () => {
    const base = makeTempDir("b13-vp-b-");
    const evil = makeTempDir("b13-vp-b-evil-");
    const pool = verifiedPool(base);
    try {
      await pool.withWorkspaceDb(workspaceA, async (db) => { await db.store(row("first lease")); });
      const shared = join(base, SHARED);
      renameSync(shared, `${shared}.x`);
      symlinkSync(evil, shared);
      await assert.rejects(pool.withWorkspaceDb(workspaceA, async (db) => { await db.store(row("redirected")); }));
      assert.deepEqual(readdirSync(evil), [], "nothing was created under the link target");
      // The planted link is refused before any identity comparison
      // (resolveInside blocks it: unsafe-root); a swap it did not catch
      // would fail the pinned identity (identity-changed). Either taints.
      const support = pool.support();
      assert.equal(support.supported, false);
      assert.equal(support.mode, "verified-path");
      assert.ok(["unsafe-root", "identity-changed"].includes(support.reason), support.reason);
      await assert.rejects(pool.withUserDb(userA, async () => {}), { code: SHARED_MEMORY_UNSUPPORTED });
      assert.deepEqual(readdirSync(evil), []);
    } finally {
      await pool.shutdown();
    }
  });

  it("(c) an identity change during a lease taints the pool", posixOnly, async () => {
    const base = makeTempDir("b13-vp-c-");
    const logger = recordingLogger();
    const pool = verifiedPool(base, logger);
    try {
      const shared = join(base, SHARED);
      await assert.rejects(
        pool.withWorkspaceDb(workspaceA, async () => {
          renameSync(shared, `${shared}.old`);
          mkdirSync(shared, { mode: 0o700 });
        }),
        /identity changed/,
      );
      assert.deepEqual(readdirSync(shared), [], "nothing was written into the replacement root");
      assert.deepEqual(pool.support(), { supported: false, mode: "verified-path", reason: "identity-changed" });
      await assert.rejects(pool.withUserDb(userA, async () => {}), (error) => {
        assert.equal(error.code, SHARED_MEMORY_UNSUPPORTED);
        assert.equal(error.reason, "identity-changed");
        return true;
      });
      // Shared reads on a tainted pool answer empty, as on a platform without shared memory.
      await pool.withWorkspaceReadDb(workspaceA, (db) => assert.equal(db, null));
      assert.ok(logger.warnings.length >= 1, "the taint is logged");
      assert.doesNotMatch(JSON.stringify(logger.warnings), /\bino\b|\bdev\b/);
    } finally {
      await pool.shutdown();
    }
  });

  it("the after-lease check wins over a throwing callback", posixOnly, async () => {
    const base = makeTempDir("b13-vp-throw-");
    const pool = verifiedPool(base);
    try {
      const shared = join(base, SHARED);
      await assert.rejects(
        pool.withWorkspaceDb(workspaceA, async () => {
          renameSync(shared, `${shared}.old`);
          mkdirSync(shared, { mode: 0o700 });
          throw new Error("synthetic callback failure");
        }),
        (error) => /identity changed/.test(error.message) && !/synthetic callback failure/.test(error.message),
      );
      assert.deepEqual(pool.support(), { supported: false, mode: "verified-path", reason: "identity-changed" });
    } finally {
      await pool.shutdown();
    }
  });

  it("the after-lease check also runs on a read lease", posixOnly, async () => {
    const base = makeTempDir("b13-vp-readlease-");
    const pool = verifiedPool(base);
    try {
      const stored = row("A fact read under a swapped root.");
      await pool.withWorkspaceDb(workspaceA, async (db) => { await db.store(stored); });
      const shared = join(base, SHARED);
      await assert.rejects(
        pool.withWorkspaceReadDb(workspaceA, async (db) => {
          assert.ok(db);
          renameSync(shared, `${shared}.old`);
          mkdirSync(shared, { mode: 0o700 });
        }),
        /identity changed/,
      );
      assert.deepEqual(pool.support(), { supported: false, mode: "verified-path", reason: "identity-changed" });
      await pool.withWorkspaceReadDb(workspaceA, (db) => assert.equal(db, null));
    } finally {
      await pool.shutdown();
    }
  });

  it("a root replaced by a fresh real directory before a lease fails the identity comparison", posixOnly, async () => {
    const base = makeTempDir("b13-vp-fresh-");
    const pool = verifiedPool(base);
    try {
      await pool.withWorkspaceDb(workspaceA, async (db) => { await db.store(row("first lease")); });
      const shared = join(base, SHARED);
      renameSync(shared, `${shared}.old`);
      mkdirSync(shared, { mode: 0o700 });
      await assert.rejects(
        pool.withWorkspaceDb(workspaceA, async (db) => { await db.store(row("second lease")); }),
        (error) => error.code === "EIDENTITY" && /shared memory root identity changed/.test(error.message),
      );
      assert.deepEqual(pool.support(), { supported: false, mode: "verified-path", reason: "identity-changed" });
      assert.deepEqual(readdirSync(shared), [], "nothing was written into the look-alike root");
    } finally {
      await pool.shutdown();
    }
  });

  it("(d) an unsafe shared root is refused", posixOnly, async () => {
    const loose = makeTempDir("b13-vp-d-root-");
    mkdirSync(join(loose, SHARED));
    chmodSync(join(loose, SHARED), 0o755);
    const pool = verifiedPool(loose);
    try {
      await assert.rejects(pool.withWorkspaceDb(workspaceA, async () => {}), { reason: "unsafe-root" });
      assert.equal(pool.support().reason, "unsafe-root");
      assert.equal(statSync(join(loose, SHARED)).mode & 0o777, 0o755, "a looser root is refused, not tightened");
      assert.deepEqual(readdirSync(join(loose, SHARED)), []);
    } finally {
      await pool.shutdown();
    }

    const openBase = makeTempDir("b13-vp-d-base-");
    chmodSync(openBase, 0o777);
    const second = verifiedPool(openBase);
    try {
      await assert.rejects(second.withWorkspaceDb(workspaceA, async () => {}), { reason: "unsafe-root" });
      assert.deepEqual(second.support(), { supported: false, mode: "verified-path", reason: "unsafe-root" });
      assert.equal(existsSync(join(openBase, SHARED)), false);
    } finally {
      await second.shutdown();
    }

    // A sticky, world-writable base passes the ancestor walk (sticky) but not
    // the base-owner check (ADR step 3), which runs before the root is created.
    const sticky = makeTempDir("b13-vp-d-sticky-");
    chmodSync(sticky, 0o1777);
    const fourth = verifiedPool(sticky);
    try {
      await assert.rejects(fourth.withWorkspaceDb(workspaceA, async () => {}), { reason: "unsafe-root" });
      assert.deepEqual(fourth.support(), { supported: false, mode: "verified-path", reason: "unsafe-root" });
      assert.equal(existsSync(join(sticky, SHARED)), false, "no root is created under an unsafe base");
    } finally {
      await fourth.shutdown();
    }

    // A pre-existing owner-only root is accepted.
    const tight = makeTempDir("b13-vp-d-tight-");
    mkdirSync(join(tight, SHARED), { mode: 0o700 });
    chmodSync(join(tight, SHARED), 0o700);
    const third = verifiedPool(tight);
    try {
      await third.withWorkspaceDb(workspaceA, async (db) => { await db.store(row("tight root")); });
      assert.deepEqual(third.support(), { supported: true, mode: "verified-path" });
    } finally {
      await third.shutdown();
    }
  });

  it("taint reasons are whitelisted to the 1.8.0 union", async () => {
    const pool = verifiedPool(makeTempDir("b13-vp-whitelist-"));
    try {
      pool._openSharedRoot = () => {
        throw Object.assign(new Error("synthetic foreign reason"), { reason: "not-a-filesystem-path" });
      };
      await assert.rejects(pool.withWorkspaceDb(workspaceA, async () => {}), /synthetic foreign reason/);
      assert.deepEqual(pool.support(), { supported: false, mode: "verified-path", reason: "unsafe-root" });
    } finally {
      await pool.shutdown();
    }
  });

  it("transient resource errors are rethrown without tainting; EACCES still taints unsafe-root", async () => {
    for (const code of ["EMFILE", "ENFILE", "EIO", "EAGAIN"]) {
      const pool = verifiedPool(makeTempDir("b13-vp-transient-"));
      try {
        const real = pool._openSharedRoot.bind(pool);
        let fail = true;
        pool._openSharedRoot = (options) => {
          if (fail) { fail = false; throw Object.assign(new Error(`synthetic ${code}`), { code }); }
          return real(options);
        };
        await assert.rejects(pool.withWorkspaceDb(workspaceA, async () => {}), { code });
        assert.deepEqual(pool.support(), { supported: true, mode: "verified-path" }, code);
        if (process.platform !== "win32") {
          await pool.withWorkspaceDb(workspaceA, async (db) => assert.ok(db));
          // The same during the after-lease check.
          const assertRoot = pool.assertSharedRoot.bind(pool);
          let armed = false;
          pool.assertSharedRoot = () => {
            if (armed) { armed = false; throw Object.assign(new Error(`synthetic ${code}`), { code }); }
            return assertRoot();
          };
          await assert.rejects(pool.withWorkspaceDb(workspaceA, async () => { armed = true; }), { code });
          assert.deepEqual(pool.support(), { supported: true, mode: "verified-path" }, `${code} after lease`);
        }
      } finally {
        await pool.shutdown();
      }
    }
    const denied = verifiedPool(makeTempDir("b13-vp-eacces-"));
    try {
      denied._openSharedRoot = () => { throw Object.assign(new Error("synthetic EACCES"), { code: "EACCES" }); };
      await assert.rejects(denied.withWorkspaceDb(workspaceA, async () => {}), { code: "EACCES" });
      assert.deepEqual(denied.support(), { supported: false, mode: "verified-path", reason: "unsafe-root" });
    } finally {
      await denied.shutdown();
    }
  });

  it("the legacy shared migration stays fd-only and answers unsupported in verified-path mode", async () => {
    const pool = new SharedMemoryPool(makeTempDir("b13-vp-mig-"), DIM, AgentDbPool, null, { mode: "verified-path" });
    try {
      await assert.rejects(
        migrateLegacySharedRows({ sharedPool: pool, agentId: "agent-a", workspaceAliases: [] }),
        (error) => error.code === SHARED_MEMORY_UNSUPPORTED && error.reason === "platform",
      );
    } finally {
      await pool.shutdown();
    }
  });

  it("rejects an unknown mode", () => {
    assert.throws(() => new SharedMemoryPool(makeTempDir("b13-vp-mode-"), DIM, AgentDbPool, null, { mode: "path" }), TypeError);
  });

  it("(e) engine share works end to end in verified-path mode", posixOnly, async () => {
    const stateDir = makeTempDir("e4-vp-engine-state-");
    const baseDbPath = freshBaseDbPath("e4-vp-engine-");
    const { host } = twoWorkspaceHost(stateDir);
    const engine = createEngine(host, config(baseDbPath), {
      internals: { embeddings: flatEmbedder() },
      sharedMemoryMode: "verified-path",
    });
    try {
      const anna = principal("anna");
      const bernd = principal("bernd");
      const F = await seedAndGetId(engine, "anna", "The synthetic office plant is watered on Mondays.", "office plant");
      const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
      const listed = await engine.memory.list({ since: 0 }, bernd, userAgent);
      assert.equal(listed.items.find((c) => c.id === S)?.sharedBy, "anna", "bernd lists the shared copy");
      const { proposalId: P } = await engine.memory.propose(S, "The synthetic office plant is watered on Tuesdays.", bernd, userAgent);
      const accepted = await engine.memory.proposals.accept(P, anna, userAgent);
      const refreshed = await engine.memory.show(accepted.id, bernd, userAgent);
      assert.equal(refreshed.text, "The synthetic office plant is watered on Tuesdays.");
      const status = await engine.status();
      assert.deepEqual(status.sharedMemory, { supported: true, mode: "verified-path" });
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("(f) Linux default stays fd-capability", { skip: process.platform !== "linux" && "fd-capability default is Linux-only" }, async () => {
    const pool = new SharedMemoryPool(makeTempDir("b13-vp-f-"), DIM, AgentDbPool);
    try {
      assert.equal(defaultSharedMemoryMode(), "fd-capability");
      assert.deepEqual(pool.support(), { supported: true, mode: "fd-capability" });
    } finally {
      await pool.shutdown();
    }
  });

  it("darwin and win32 default to verified-path", () => {
    if (process.platform === "linux") {
      // Linux has descriptor aliases, so the platform argument is not consulted.
      assert.equal(defaultSharedMemoryMode("darwin"), "fd-capability");
      return;
    }
    assert.equal(defaultSharedMemoryMode(), process.platform === "darwin" || process.platform === "win32" ? "verified-path" : "unavailable");
  });

  it("win32: a user-owned, owner-only base and root succeed even on an elevated runner", { skip: process.platform !== "win32" && "win32-only ACL path" }, async () => {
    // GitHub's windows-latest runs elevated, so new directories are owned by
    // Administrators and the default path is refused (E4-R12). Handing the
    // base and root to the user makes the success path reachable there:
    // icacls on the pool root is skipped (createdRoot is false), the owner
    // checks pass, LanceDB runs through a VerifiedPathDirectory and the
    // after-lease check runs.
    const base = realpathSync.native(makeTempDir("b13-vp-win-ok-"));
    const root = join(base, SHARED);
    mkdirSync(root);
    const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username;
    const icacls = (args) => execFileSyncBounded("icacls", args, { stdio: "ignore", windowsHide: true });
    icacls([base, "/setowner", user]);
    icacls([root, "/setowner", user]);
    icacls([root, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)(F)`]);
    const rootAcl = readDirectoryAcl(root);
    assert.equal(rootAcl.ownerSid, rootAcl.userSid, "the root was handed to the current user");
    assert.equal(readDirectoryAcl(base).ownerSid, rootAcl.userSid, "the base was handed to the current user");

    const pool = new SharedMemoryPool(base, DIM, AgentDbPool, recordingLogger());
    try {
      assert.equal(pool.mode, "verified-path");
      const stored = row("A synthetic fact on a user-owned Windows root.");
      await pool.withWorkspaceDb(workspaceA, async (db) => { await db.store(stored); });
      const read = await pool.withWorkspaceReadDb(workspaceA, (db) => db.getById(stored.id));
      assert.equal(read?.text, stored.text);
      assert.deepEqual(pool.support(), { supported: true, mode: "verified-path" });
    } finally {
      await pool.shutdown();
    }
  });

  it("win32: the real ACL path restricts the root or refuses it (E4-R12)", { skip: process.platform !== "win32" && "win32-only ACL path" }, async () => {
    const base = makeTempDir("b13-vp-win-");
    const pool = new SharedMemoryPool(base, DIM, AgentDbPool, recordingLogger());
    try {
      assert.equal(pool.mode, "verified-path");
      const baseAcl = readDirectoryAcl(realpathSync.native(base));
      const stored = row("A synthetic fact on Windows.");
      let failure = null;
      try {
        await pool.withWorkspaceDb(workspaceA, async (db) => { await db.store(stored); });
      } catch (error) {
        failure = error;
      }
      const root = join(realpathSync.native(base), SHARED);
      if (failure === null) {
        const acl = readDirectoryAcl(root);
        assert.equal(acl.ownerSid, acl.userSid, "the root is owned by the current user");
        for (const ace of acl.aces.filter((a) => a.type === "Allow")) {
          assert.ok([acl.userSid, "S-1-5-18", "S-1-5-32-544"].includes(ace.sid), `unexpected Allow ACE ${ace.sid}`);
        }
        const read = await pool.withWorkspaceReadDb(workspaceA, (db) => db.getById(stored.id));
        assert.equal(read?.text, stored.text);
        assert.deepEqual(pool.support(), { supported: true, mode: "verified-path" });
      } else {
        // An elevated shell creates directories owned by Administrators
        // (E4-R12): the owner check refuses them with unsafe-root.
        assert.equal(failure.reason, "unsafe-root", `unexpected failure: ${failure.message}`);
        assert.deepEqual(pool.support(), { supported: false, mode: "verified-path", reason: "unsafe-root" });
        const rootOwner = existsSync(root) ? readDirectoryAcl(root).ownerSid : null;
        assert.ok(
          baseAcl.ownerSid !== baseAcl.userSid || (rootOwner !== null && rootOwner !== baseAcl.userSid),
          "a refusal is only expected when the base or root is not owned by the current user",
        );
      }
    } finally {
      await pool.shutdown();
    }
  });
});
