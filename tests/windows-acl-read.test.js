/**
 * Fast Windows ACL read: fallback when the native tools fail, and a live
 * parity check against PowerShell 5.1 on Windows CI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, win32 } from "node:path";
import { userInfo } from "node:os";

import { readDirectoryAcl } from "../lib/platform.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const USER_SID = "S-1-5-21-1-2-3-1001";
const SYSTEM_SID = "S-1-5-18";
const USERS_SID = "S-1-5-32-545";
const JSON_ACL = JSON.stringify({
  ownerSid: USER_SID,
  userSid: USER_SID,
  aces: [{ sid: USER_SID, type: "Allow" }, { sid: SYSTEM_SID, type: "Allow" }],
});

function bySidType(aces) {
  return [...aces].map((ace) => `${ace.type}:${ace.sid.toUpperCase()}`).sort();
}

describe("readDirectoryAcl fast path fallback", () => {
  const target = "C:\\synthetic\\dir";

  it("uses PowerShell when the fast tools fail and keeps the result", () => {
    const files = [];
    const acl = readDirectoryAcl(target, {
      execFile: (file, args, options) => {
        files.push(String(file).toLowerCase());
        if (String(file).toLowerCase().includes("powershell")) return JSON_ACL;
        throw Object.assign(new Error("fast path missing"), { status: 1 });
      },
    });
    assert.deepEqual(acl, JSON.parse(JSON_ACL));
    assert.ok(files.some((f) => f.includes("cscript") || f.includes("whoami")));
    assert.ok(files.some((f) => f.includes("powershell")));
  });

  it("throws acl-tool-unavailable when both paths fail", () => {
    assert.throws(
      () => readDirectoryAcl(target, {
        execFile: () => { throw Object.assign(new Error("exit 1"), { status: 1 }); },
      }),
      { reason: "acl-tool-unavailable" },
    );
  });

  it("keeps the 30 s product cap on the PowerShell fallback", () => {
    let timeout;
    readDirectoryAcl(target, {
      execFile: (file, args, options) => {
        if (String(file).toLowerCase().includes("powershell")) {
          timeout = options.timeout;
          return JSON_ACL;
        }
        throw Object.assign(new Error("fast path missing"), { status: 1 });
      },
    });
    assert.ok(timeout > 0 && timeout <= 30_000);
  });

  it("uses PowerShell when cscript prints a banner before OWNER", () => {
    const files = [];
    const acl = readDirectoryAcl(target, {
      execFile: (file) => {
        files.push(String(file).toLowerCase());
        if (String(file).toLowerCase().includes("cscript")) {
          return `Microsoft (R) Windows Script Host Version 5.812\nOWNER=${USER_SID}\nACE=0,${USER_SID}\n`;
        }
        return JSON_ACL;
      },
    });
    assert.deepEqual(acl, JSON.parse(JSON_ACL));
    assert.ok(files.some((f) => f.includes("powershell")));
  });

  it("uses PowerShell when WMI output is well-formed but unknown", () => {
    const files = [];
    const acl = readDirectoryAcl(target, {
      execFile: (file) => {
        files.push(String(file).toLowerCase());
        if (String(file).toLowerCase().includes("cscript")) {
          return `OWNER=${USER_SID}\nACE=5,${SYSTEM_SID}\n`;
        }
        return JSON_ACL;
      },
    });
    assert.deepEqual(acl, JSON.parse(JSON_ACL));
    assert.ok(files.some((f) => f.includes("cscript")));
    assert.ok(files.some((f) => f.includes("powershell")));
  });

  it("DACL=NULL never falls back to PowerShell", () => {
    const files = [];
    assert.throws(
      () => readDirectoryAcl(target, {
        execFile: (file) => {
          files.push(String(file).toLowerCase());
          if (String(file).toLowerCase().includes("cscript")) {
            return `OWNER=${USER_SID}\nDACL=NULL\n`;
          }
          return JSON_ACL;
        },
      }),
      { reason: "acl-tool-unavailable" },
    );
    assert.ok(files.some((f) => f.includes("cscript")));
    assert.equal(files.some((f) => f.includes("powershell")), false);
  });

  it("spawns cscript and whoami from System32", () => {
    const files = [];
    const root = typeof process.env.SystemRoot === "string"
      && win32.isAbsolute(process.env.SystemRoot)
      && !process.env.SystemRoot.includes("\0")
      && !process.env.SystemRoot.includes('"')
      ? process.env.SystemRoot
      : "C:\\Windows";
    readDirectoryAcl(target, {
      execFile: (file, _args, options) => {
        files.push(file);
        const lower = String(file).toLowerCase();
        if (lower.includes("cscript")) {
          assert.equal(options?.env?.PLUR1BUS_ACL_PATH, target);
          return `OWNER=${USER_SID}\nACE=0,${USER_SID}\n`;
        }
        if (lower.includes("whoami")) return `"u","${USER_SID}"`;
        throw new Error(`unexpected spawn ${file}`);
      },
    });
    assert.deepEqual(files, [
      win32.join(root, "System32", "cscript.exe"),
      win32.join(root, "System32", "whoami.exe"),
    ]);
  });
});

describe("readDirectoryAcl fast path matches PowerShell", {
  skip: process.platform !== "win32" && "win32-only icacls/PowerShell ACL parity",
}, () => {
  function aclDir(tag) {
    const base = makeTempDir(`acl-parity-${tag}-`);
    const dir = join(base, "d");
    mkdirSync(dir);
    return dir;
  }

  function icacls(args) {
    execFileSync("icacls.exe", args, { stdio: "ignore", windowsHide: true });
  }

  function powershellAcl(dir) {
    return readDirectoryAcl(dir, {
      // Product cap stays 30 s. Forcing 5.1 on windows-11-arm needs more:
      // probe 37123429626, cold first 32 s.
      timeoutMs: 60_000,
      execFile: (file, args, options) => {
        if (!String(file).toLowerCase().includes("powershell")) {
          throw Object.assign(new Error("forced powershell path"), { status: 1 });
        }
        return execFileSync(file, args, options);
      },
    });
  }

  it("agrees on owner-only, extra Users Allow, and extra Deny", () => {
    const user = process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${userInfo().username}`
      : userInfo().username;

    const ownerOnly = aclDir("owner");
    icacls([ownerOnly, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)(F)`]);

    const extraAllow = aclDir("allow");
    icacls([extraAllow, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)(F)`, "/grant", "*S-1-5-32-545:(R)"]);

    const extraDeny = aclDir("deny");
    icacls([extraDeny, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)(F)`, "/deny", "*S-1-5-32-545:(W)"]);

    for (const dir of [ownerOnly, extraAllow, extraDeny]) {
      const fast = readDirectoryAcl(dir);
      const classic = powershellAcl(dir);
      assert.equal(fast.ownerSid.toUpperCase(), classic.ownerSid.toUpperCase(), dir);
      assert.equal(fast.userSid.toUpperCase(), classic.userSid.toUpperCase(), dir);
      assert.deepEqual(bySidType(fast.aces), bySidType(classic.aces), dir);
    }

    const allowSids = readDirectoryAcl(extraAllow).aces.filter((ace) => ace.type === "Allow").map((ace) => ace.sid.toUpperCase());
    assert.ok(allowSids.includes(USERS_SID));
    const denySids = readDirectoryAcl(extraDeny).aces.filter((ace) => ace.type === "Deny").map((ace) => ace.sid.toUpperCase());
    assert.ok(denySids.includes(USERS_SID));
  });

  it("records the PowerShell ACE list for a NULL DACL", () => {
    const dir = aclDir("nulldacl");
    const encoded = Buffer.from([
      "$ErrorActionPreference = 'Stop'",
      "$p = $env:PLUR1BUS_ACL_PATH",
      "$acl = [System.IO.Directory]::GetAccessControl($p)",
      "$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])",
      "$sd = New-Object System.Security.AccessControl.DirectorySecurity",
      "$sd.SetOwner($owner)",
      "$sd.SetSecurityDescriptorSddlForm(($sd.GetSecurityDescriptorSddlForm('Owner') + 'D:NO_ACCESS_CONTROL'))",
      "[System.IO.Directory]::SetAccessControl($p, $sd)",
    ].join("\n"), "utf16le").toString("base64");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env: { ...process.env, PLUR1BUS_ACL_PATH: dir },
      windowsHide: true,
      timeout: 60_000,
    });
    const classic = powershellAcl(dir);
    assert.match(classic.ownerSid, /^S-1-/);
    assert.ok(Array.isArray(classic.aces));
    // Evidence for PR #207 review Q5: empty vs synthesised Everyone. Not a security gate.
    console.log("NULL_DACL_POWERSHELL", JSON.stringify({
      ownerSid: classic.ownerSid,
      aceCount: classic.aces.length,
      aces: classic.aces,
    }));
  });
});
