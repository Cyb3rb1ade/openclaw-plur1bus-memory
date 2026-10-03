/**
 * Strict SDDL / WMI ACL parsers for the Windows fast path.
 * Synthetic strings only — no live Windows tools.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseSddl,
  parseWhoamiCsv,
  parseWmiAcl,
} from "../lib/windows-acl-sddl.js";

const USER = "S-1-5-21-1-2-3-1001";
const SYSTEM = "S-1-5-18";
const ADMINS = "S-1-5-32-544";
const USERS = "S-1-5-32-545";
const EVERYONE = "S-1-1-0";
const AUTH = "S-1-5-11";

function fails(fn) {
  assert.throws(fn, { code: "ACL_PARSE" });
}

describe("parseSddl", () => {
  it("reads an owner-only DACL", () => {
    assert.deepEqual(
      parseSddl(`O:${USER}D:(A;;FA;;;${USER})`),
      { ownerSid: USER, aces: [{ sid: USER, type: "Allow" }] },
    );
  });

  it("keeps inherited ACEs", () => {
    assert.deepEqual(
      parseSddl(`O:${USER}D:AI(A;OICIID;FA;;;${SYSTEM})(A;OICIID;FA;;;${ADMINS})`),
      {
        ownerSid: USER,
        aces: [
          { sid: SYSTEM, type: "Allow" },
          { sid: ADMINS, type: "Allow" },
        ],
      },
    );
  });

  it("keeps a Deny ACE", () => {
    assert.deepEqual(
      parseSddl(`O:${USER}D:(D;;FA;;;${USERS})(A;;FA;;;${USER})`),
      {
        ownerSid: USER,
        aces: [
          { sid: USERS, type: "Deny" },
          { sid: USER, type: "Allow" },
        ],
      },
    );
  });

  it("expands Everyone, Users and Authenticated Users aliases", () => {
    assert.deepEqual(
      parseSddl("O:SYD:(A;;FA;;;WD)(A;;FA;;;BU)(A;;FA;;;AU)"),
      {
        ownerSid: SYSTEM,
        aces: [
          { sid: EVERYONE, type: "Allow" },
          { sid: USERS, type: "Allow" },
          { sid: AUTH, type: "Allow" },
        ],
      },
    );
  });

  it("rejects an object ACE", () => {
    fails(() => parseSddl(`O:${USER}D:(OA;;FA;;;WD)`));
  });

  it("rejects a conditional ACE", () => {
    fails(() => parseSddl(`O:${USER}D:(XA;;FA;;;WD;(WIN://SYSAPPID Contains "x"))`));
    fails(() => parseSddl(`O:${USER}D:(A;;FA;;;WD;(x==1))`));
  });

  it("rejects malformed SDDL", () => {
    fails(() => parseSddl(""));
    fails(() => parseSddl("not sddl"));
    fails(() => parseSddl(`O:${USER}`));
    fails(() => parseSddl(`D:(A;;FA;;;${USER})`));
    fails(() => parseSddl(`O:EveryoneD:(A;;FA;;;WD)`));
    fails(() => parseSddl(`O:${USER}D:(A;;FA;;;LA)`));
    fails(() => parseSddl(`O:${USER}D:(A;;FA;;;${USER}`));
  });

  it("accepts an empty DACL", () => {
    assert.deepEqual(parseSddl(`O:${USER}D:`), { ownerSid: USER, aces: [] });
    assert.deepEqual(parseSddl(`O:${USER}D:P`), { ownerSid: USER, aces: [] });
  });

  it("rejects a null DACL", () => {
    fails(() => parseSddl(`O:${USER}D:NO_ACCESS_CONTROL`));
    fails(() => parseSddl(`O:${USER}D:PNO_ACCESS_CONTROL`));
  });
});

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

  it("rejects a null DACL, unknown ACE kinds and junk", () => {
    fails(() => parseWmiAcl(`OWNER=${USER}\nDACL=NULL\n`));
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
