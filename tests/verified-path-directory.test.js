/**
 * tests/verified-path-directory.test.js — E4 Task 9 (ADR 0001, Option B).
 *
 * `VerifiedPathDirectory` is the path-routed twin of `DirectoryCapability`
 * for platforms without descriptor aliases (darwin, win32). These cases run
 * on Linux and macOS; the win32 branches are reached through
 * `platform: "win32"` plus injected `readAcl` / `execFile`. The suite runs as
 * root in the container, so owner and mode policy is driven through the
 * injected `lstat` and `uid` seams, not the real uid.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  VerifiedPathDirectory,
  assertOwnerOnlyDirectory,
  openVerifiedPathDirectory,
} from "../lib/verified-path-directory.js";
import { readDirectoryAcl, secureDirectoryOwnerOnly } from "../lib/platform.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const USER_SID = "S-1-5-21-1-2-3-1001";
const SYSTEM_SID = "S-1-5-18";
const ADMINS_SID = "S-1-5-32-544";
const AUTH_USERS_SID = "S-1-5-11";
const ME = process.getuid?.();

/** A bigint lstat that reports `overrides` for exactly one path and the real entry elsewhere. */
function lstatOverriding(target, overrides) {
  return (path, options) => {
    const real = lstatSync(path, options);
    if (path !== target) return real;
    const fake = Object.create(Object.getPrototypeOf(real));
    Object.assign(fake, real, overrides);
    return fake;
  };
}

function privateBase(prefix) {
  return realpathSync.native(makeTempDir(prefix));
}

describe("VerifiedPathDirectory", () => {
  it("opens and creates a private chain and routes children", () => {
    const base = makeTempDir("e4-vp-");
    const dir = openVerifiedPathDirectory(join(base, "s"), { create: true });
    try {
      assert.ok(dir instanceof VerifiedPathDirectory);
      assert.equal(dir.path, realpathSync.native(join(base, "s")));
      assert.equal(dir.displayPath, dir.path);
      assert.equal(statSync(dir.path).mode & 0o777, 0o700);
      const identity = lstatSync(dir.path, { bigint: true });
      assert.deepEqual({ ...dir.identity }, { dev: identity.dev, ino: identity.ino });
      assert.ok(Object.isFrozen(dir.identity));

      const child = dir.openChild("workspaces", { create: true });
      try {
        assert.equal(child.path, join(dir.path, "workspaces"));
        assert.equal(statSync(child.path).mode & 0o777, 0o700);
        assert.equal(dir.childMatches("workspaces", child), true);
        child.assertOpen();
      } finally {
        child.close();
      }
      dir.assertOpen();
    } finally {
      dir.close();
    }
  });

  it("refuses a symlinked segment at open and a swap after open", () => {
    const base = privateBase("e4-vp-link-");
    const other = join(base, "other");
    mkdirSync(other, { mode: 0o700 });

    // A link found by the per-segment walk (planted after canonicalisation).
    const walked = join(base, "walked");
    mkdirSync(walked, { mode: 0o700 });
    const asLink = lstatOverriding(walked, { mode: 0o120777n });
    assert.throws(
      () => openVerifiedPathDirectory(join(walked, "x"), { create: true, lstat: asLink }),
      (error) => error.code === "ELOOP" && error.message.includes(join(walked, "x")),
    );

    // A link planted between the ENOENT and the mkdir of a created segment.
    const planted = join(base, "planted");
    let hidden = false;
    const racingLstat = (path, options) => {
      if (path === planted && !hidden) {
        hidden = true;
        symlinkSync(other, planted);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return lstatSync(path, options);
    };
    assert.throws(
      () => openVerifiedPathDirectory(planted, { create: true, lstat: racingLstat }),
      (error) => error.code === "ELOOP",
    );
    assert.equal(lstatSync(planted).isSymbolicLink(), true, "the planted link was not followed or replaced");

    // The same race on openChild.
    const parent = openVerifiedPathDirectory(base);
    try {
      const childPlanted = join(base, "child-planted");
      let childHidden = false;
      const childRace = (path, options) => {
        if (path === childPlanted && !childHidden) {
          childHidden = true;
          symlinkSync(other, childPlanted);
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return lstatSync(path, options);
      };
      const racing = openVerifiedPathDirectory(base, { lstat: childRace });
      try {
        assert.throws(() => racing.openChild("child-planted", { create: true }), { code: "ELOOP" });
      } finally {
        racing.close();
      }
      assert.throws(() => parent.openChild("child-planted"), { code: "ELOOP" });

      // A swap after open.
      const d = join(base, "d");
      mkdirSync(d, { mode: 0o700 });
      const held = parent.openChild("d");
      try {
        held.assertOpen();
        renameSync(d, `${d}.old`);
        symlinkSync(other, d);
        assert.throws(() => held.assertOpen(), (error) => {
          assert.equal(error.code, "EIDENTITY");
          assert.ok(error.message.includes(d));
          assert.ok(!error.message.includes(String(held.identity.ino)), "no identity numbers in the message");
          return true;
        });
        assert.equal(parent.childMatches("d", held), false);
      } finally {
        held.close();
      }
    } finally {
      parent.close();
    }
  });

  it("resolves a link in the configured path once and applies the policy to its target chain", () => {
    // ADR 0001 step 1: the path is canonicalised once (realpathSync.native of
    // its nearest existing ancestor); the walk then runs on the canonical
    // chain. This is what lets macOS's /var -> /private/var tmpdir work.
    const base = privateBase("e4-vp-canon-");
    const target = join(base, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(base, "configured"));
    const dir = openVerifiedPathDirectory(join(base, "configured", "x"), { create: true });
    try {
      assert.equal(dir.path, join(target, "x"));
    } finally {
      dir.close();
    }
    // The resolved chain is still subject to the ancestor policy.
    const foreign = lstatOverriding(target, { uid: 4242n });
    assert.throws(
      () => openVerifiedPathDirectory(join(base, "configured", "y"), { create: true, lstat: foreign }),
      { reason: "unsafe-root" },
    );
  });

  it("refuses a replaced directory with the same name", () => {
    const base = privateBase("e4-vp-replace-");
    const d = join(base, "d");
    mkdirSync(d, { mode: 0o700 });
    const held = openVerifiedPathDirectory(d);
    try {
      rmSync(d, { recursive: true });
      mkdirSync(d, { mode: 0o700 });
      assert.throws(() => held.assertOpen(), { code: "EIDENTITY" });
      const parent = openVerifiedPathDirectory(base);
      try {
        assert.equal(parent.childMatches("d", held), false);
      } finally {
        parent.close();
      }
    } finally {
      held.close();
    }
  });

  it("ancestor and owner policy", () => {
    const base = privateBase("e4-vp-policy-");
    const ancestor = join(base, "a");
    mkdirSync(ancestor, { mode: 0o700 });
    const leaf = join(ancestor, "leaf");

    assert.throws(
      () => openVerifiedPathDirectory(leaf, { create: true, lstat: lstatOverriding(ancestor, { mode: 0o40777n }) }),
      (error) => error.reason === "unsafe-root" && error.message.includes(leaf),
    );
    assert.throws(
      () => openVerifiedPathDirectory(leaf, { create: true, lstat: lstatOverriding(ancestor, { mode: 0o40775n }) }),
      { reason: "unsafe-root" },
    );
    const sticky = openVerifiedPathDirectory(leaf, { create: true, lstat: lstatOverriding(ancestor, { mode: 0o41777n }) });
    sticky.close();
    assert.throws(
      () => openVerifiedPathDirectory(leaf, { lstat: lstatOverriding(ancestor, { uid: 4242n }) }),
      { reason: "unsafe-root" },
    );
    // Owned by the (injected) current user passes: every entry the real user
    // owns is reported as uid 4242, and 4242 is passed as the current uid.
    const asUser4242 = (path, options) => {
      const real = lstatSync(path, options);
      if (real.uid !== BigInt(ME)) return real;
      const fake = Object.create(Object.getPrototypeOf(real));
      return Object.assign(fake, real, { uid: 4242n });
    };
    const own = openVerifiedPathDirectory(leaf, { uid: 4242, lstat: asUser4242 });
    own.close();
    assert.throws(() => openVerifiedPathDirectory(leaf, { uid: 4243, lstat: asUser4242 }), { reason: "unsafe-root" });
    // No usable uid on POSIX fails closed.
    assert.throws(() => openVerifiedPathDirectory(leaf, { uid: null }), { reason: "unsafe-root" });

    const loose = join(base, "loose");
    mkdirSync(loose, { mode: 0o750 });
    assert.equal(statSync(loose).mode & 0o777, 0o750);
    assert.throws(() => assertOwnerOnlyDirectory(loose, { platform: "linux", uid: ME }), (error) => {
      assert.equal(error.reason, "unsafe-root");
      assert.ok(error.message.includes(loose));
      return true;
    });
    const tight = join(base, "tight");
    mkdirSync(tight, { mode: 0o700 });
    assertOwnerOnlyDirectory(tight, { platform: "linux", uid: ME });
    assert.throws(() => assertOwnerOnlyDirectory(tight, { platform: "linux", uid: 4242 }), { reason: "unsafe-root" });
    assert.throws(() => assertOwnerOnlyDirectory(tight, { platform: "linux", uid: null }), { reason: "unsafe-root" });
    assert.throws(() => assertOwnerOnlyDirectory(join(base, "missing"), { platform: "linux", uid: ME }), { reason: "unsafe-root" });
    symlinkSync(tight, join(base, "tight-link"));
    assert.throws(() => assertOwnerOnlyDirectory(join(base, "tight-link"), { platform: "linux", uid: ME }), { reason: "unsafe-root" });
  });

  it("win32 ACL policy", () => {
    const dir = privateBase("e4-vp-acl-");
    const acl = (overrides = {}) => () => ({
      ownerSid: USER_SID,
      userSid: USER_SID,
      aces: [
        { sid: USER_SID, type: "Allow" },
        { sid: SYSTEM_SID, type: "Allow" },
        { sid: ADMINS_SID, type: "Allow" },
      ],
      ...overrides,
    });
    assertOwnerOnlyDirectory(dir, { platform: "win32", readAcl: acl() });
    assert.throws(
      () => assertOwnerOnlyDirectory(dir, {
        platform: "win32",
        readAcl: acl({ aces: [{ sid: USER_SID, type: "Allow" }, { sid: AUTH_USERS_SID, type: "Allow" }] }),
      }),
      (error) => error.reason === "unsafe-root" && error.message.includes(dir) && !error.message.includes(AUTH_USERS_SID),
    );
    assert.throws(
      () => assertOwnerOnlyDirectory(dir, { platform: "win32", readAcl: acl({ ownerSid: ADMINS_SID }) }),
      { reason: "unsafe-root" },
    );
    assert.throws(
      () => assertOwnerOnlyDirectory(dir, {
        platform: "win32",
        readAcl: () => { throw Object.assign(new Error("powershell missing"), { reason: "acl-tool-unavailable" }); },
      }),
      { reason: "acl-tool-unavailable" },
    );
    assertOwnerOnlyDirectory(dir, {
      platform: "win32",
      readAcl: acl({ aces: [{ sid: USER_SID, type: "Allow" }, { sid: AUTH_USERS_SID, type: "Deny" }] }),
    });
    assert.throws(
      () => assertOwnerOnlyDirectory(dir, {
        platform: "win32",
        readAcl: acl({ aces: [{ sid: USER_SID, type: "Audit" }] }),
      }),
      { reason: "unsafe-root" },
    );
    assert.throws(
      () => assertOwnerOnlyDirectory(join(dir, "missing"), { platform: "win32", readAcl: acl() }),
      { reason: "unsafe-root" },
    );
  });

  it("readDirectoryAcl passes the path via the environment", () => {
    const target = "C:\\Users\\synthetic user\\shared'; Remove-Item -Recurse C:\\ #";
    const calls = [];
    const output = JSON.stringify({
      ownerSid: USER_SID,
      userSid: USER_SID,
      aces: [{ sid: USER_SID, type: "Allow" }, { sid: SYSTEM_SID, type: "Allow" }],
    });
    const acl = readDirectoryAcl(target, {
      execFile: (file, args, options) => {
        calls.push({ file, args, options });
        return `\uFEFF${output}\r\n`;
      },
    });
    assert.deepEqual(acl, {
      ownerSid: USER_SID,
      userSid: USER_SID,
      aces: [{ sid: USER_SID, type: "Allow" }, { sid: SYSTEM_SID, type: "Allow" }],
    });
    assert.equal(calls.length, 1);
    const [{ file, args, options }] = calls;
    assert.equal(file, "powershell.exe");
    assert.ok(args.includes("-NoProfile") && args.includes("-NonInteractive"));
    for (const arg of args) {
      for (const part of ["synthetic user", "Remove-Item", "shared"]) {
        assert.ok(!arg.includes(part), `argv must not carry the path: ${arg}`);
      }
    }
    const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    assert.match(script, /\$env:PLUR1BUS_ACL_PATH/);
    assert.ok(!script.includes("synthetic user"));
    assert.equal(options.env.PLUR1BUS_ACL_PATH, target);

    const missing = Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
    assert.throws(
      () => readDirectoryAcl(target, { execFile: () => { throw missing; } }),
      { reason: "acl-tool-unavailable" },
    );
    assert.throws(() => readDirectoryAcl(target, { execFile: () => "not json" }), { reason: "acl-tool-unavailable" });
    assert.throws(
      () => readDirectoryAcl(target, { execFile: () => JSON.stringify({ ownerSid: USER_SID, userSid: USER_SID, aces: [{ sid: "Everyone", type: "Allow" }] }) }),
      { reason: "acl-tool-unavailable" },
    );
    assert.throws(
      () => readDirectoryAcl(target, { execFile: () => { throw Object.assign(new Error("exit 1"), { status: 1 }); } }),
      { reason: "acl-tool-unavailable" },
    );

    const icacls = [];
    const result = secureDirectoryOwnerOnly(target, {
      platform: "win32",
      username: "synthetic",
      execFile: (fileName, argv) => { icacls.push({ fileName, argv }); },
    });
    assert.deepEqual(result, { applied: true, mechanism: "acl" });
    assert.deepEqual(icacls, [{ fileName: "icacls", argv: [target, "/inheritance:r", "/grant:r", "synthetic:(OI)(CI)(F)"] }]);
    assert.deepEqual(
      secureDirectoryOwnerOnly(target, {
        platform: "win32",
        username: "synthetic",
        execFile: () => { throw Object.assign(new Error("spawn icacls ENOENT"), { code: "ENOENT" }); },
      }),
      { applied: false, reason: "acl-tool-unavailable" },
    );
  });

  it("secureDirectoryOwnerOnly makes a POSIX directory 0700 without following a link", () => {
    const base = privateBase("e4-vp-secure-");
    const dir = join(base, "d");
    mkdirSync(dir, { mode: 0o755 });
    assert.deepEqual(secureDirectoryOwnerOnly(dir, { platform: "linux" }), { applied: true, mechanism: "chmod" });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const victim = join(base, "victim");
    mkdirSync(victim, { mode: 0o755 });
    symlinkSync(victim, join(base, "link"));
    // O_DIRECTORY|O_NOFOLLOW on a link: ELOOP (darwin) or ENOTDIR (Linux).
    assert.throws(
      () => secureDirectoryOwnerOnly(join(base, "link"), { platform: "linux" }),
      (error) => error.code === "ELOOP" || error.code === "ENOTDIR",
    );
    assert.equal(statSync(victim).mode & 0o777, 0o755);
    assert.deepEqual(
      secureDirectoryOwnerOnly("\\\\.\\pipe\\plur1bus-x", { platform: "win32" }),
      { applied: false, reason: "not-a-filesystem-path" },
    );
  });

  it("fails closed on bad input, missing entries, files and closed handles", () => {
    const base = privateBase("e4-vp-edges-");
    assert.throws(() => openVerifiedPathDirectory("relative/path"), TypeError);
    assert.throws(() => openVerifiedPathDirectory(""), TypeError);
    assert.throws(() => openVerifiedPathDirectory(`${base}/a\0b`), TypeError);
    assert.throws(() => openVerifiedPathDirectory(join(base, "missing")), (error) => {
      assert.equal(error.code, "ENOENT");
      assert.ok(error.message.includes(join(base, "missing")));
      return true;
    });
    const file = join(base, "file");
    writeFileSync(file, "x");
    assert.throws(() => openVerifiedPathDirectory(file), { code: "ENOTDIR" });
    assert.throws(() => openVerifiedPathDirectory(join(file, "below"), { create: true }), { code: "ENOTDIR" });

    const dir = openVerifiedPathDirectory(base);
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\0b", 7]) {
      assert.throws(() => dir.openChild(bad), TypeError);
    }
    assert.throws(() => dir.openChild("absent"), { code: "ENOENT" });
    assert.throws(() => dir.openChild("file"), { code: "ENOTDIR" });
    const child = dir.openChild("c", { create: true });
    assert.equal(dir.childMatches("absent", child), false);
    assert.equal(dir.childMatches("file", child), false);
    child.close();
    child.close();
    assert.throws(() => child.assertOpen(), /closed/);
    assert.throws(() => dir.childMatches("c", child), /closed/);
    dir.close();
    assert.throws(() => dir.openChild("c"), /closed/);
  });

  it("holds an anchor descriptor per directory on POSIX", () => {
    const base = privateBase("e4-vp-anchor-");
    const dir = openVerifiedPathDirectory(base);
    try {
      assert.equal(typeof dir.anchorFd, "number");
    } finally {
      dir.close();
    }
    assert.equal(dir.anchorFd, null);
  });
});
