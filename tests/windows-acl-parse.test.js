/**
 * Strict WMI / whoami parsers for the Windows ACL fast path.
 * Synthetic strings only — no live Windows tools.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseWhoamiCsv,
  parseWmiAcl,
} from "../lib/windows-acl-parse.js";

const USER = "S-1-5-21-1-2-3-1001";
const SYSTEM = "S-1-5-18";
const USERS = "S-1-5-32-545";

function fails(fn, code = "ACL_PARSE") {
  assert.throws(fn, { code });
}

describe("parseWmiAcl", () => {
  it("reads owner and Allow/Deny ACEs", () => {
    assert.deepEqual(
      parseWmiAcl(`OWNER=${USER}\r\nACE=0,${SYSTEM}\nACE=1,${USERS}\nACE=0,${USER}\n`),
      {
        ownerSid: USER,
        aces: [
          { sid: SYSTEM, type: "Allow" },
          { sid: USERS, type: "Deny" },
          { sid: USER, type: "Allow" },
        ],
      },
    );
  });

  it("accepts an empty DACL", () => {
    assert.deepEqual(parseWmiAcl(`OWNER=${USER}\n`), { ownerSid: USER, aces: [] });
  });

  it("rejects a null DACL even with extra junk", () => {
    fails(() => parseWmiAcl(`OWNER=${USER}\nDACL=NULL\n`), "ACL_NULL_DACL");
    fails(() => parseWmiAcl(`Microsoft (R) Windows Script Host\nOWNER=${USER}\nDACL=NULL\n`), "ACL_NULL_DACL");
  });

  it("rejects unknown ACE kinds and junk", () => {
    fails(() => parseWmiAcl(`OWNER=${USER}\nACE=2,${SYSTEM}\n`));
    fails(() => parseWmiAcl(`OWNER=${USER}\nACE=5,${SYSTEM}\n`));
    fails(() => parseWmiAcl(`OWNER=${USER}\nACE=9,${SYSTEM}\n`));
    fails(() => parseWmiAcl(`OWNER=BUILTIN\\Administrators\nACE=0,${SYSTEM}\n`));
    fails(() => parseWmiAcl(`{"ownerSid":"${USER}"}`));
    fails(() => parseWmiAcl(""));
    fails(() => parseWmiAcl(`ACE=0,${SYSTEM}\n`));
  });
});

describe("parseWhoamiCsv", () => {
  it("reads the SID from CSV", () => {
    assert.equal(parseWhoamiCsv(`"host\\user","${USER}"\r\n`), USER);
    assert.equal(parseWhoamiCsv(`${USER}\n`), USER);
  });

  it("rejects missing or extra SIDs", () => {
    fails(() => parseWhoamiCsv(""));
    fails(() => parseWhoamiCsv("host\\user,Everyone"));
    fails(() => parseWhoamiCsv(`"${USER}","${SYSTEM}"`));
  });
});
