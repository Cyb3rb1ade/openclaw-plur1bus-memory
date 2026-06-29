import { describe, it } from "node:test";
import assert from "node:assert";

import { checkAccess, filterMemoriesByAcl } from "../lib/acl-middleware.js";

describe('scope="user" ACL', () => {
  it("allows the owning user to access a user-scoped memory", () => {
    const result = checkAccess(
      { userId: "user-1" },
      { id: "m1", scope: "user", ownerUserId: "user-1" },
    );
    assert.strictEqual(result.allowed, true);
  });

  it("denies a different authenticated user from accessing a user-scoped memory", () => {
    const result = checkAccess(
      { userId: "user-2" },
      { id: "m1", scope: "user", ownerUserId: "user-1" },
    );
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "acl.user.mismatch");
  });

  it("denies unauthenticated access to a user-scoped memory", () => {
    const result = checkAccess(
      {},
      { id: "m1", scope: "user", ownerUserId: "user-1" },
    );
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "acl.user.not_authenticated");
  });

  it("fails closed for legacy user-scoped rows without an owner binding", () => {
    const result = checkAccess(
      { userId: "user-1" },
      { id: "m1", scope: "user" },
    );
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "acl.user.missing_owner");
  });

  it("filters user-scoped memories by owner binding", () => {
    const allowed = filterMemoriesByAcl(
      { userId: "user-1" },
      [
        { id: "keep", scope: "user", ownerUserId: "user-1" },
        { id: "drop", scope: "user", ownerUserId: "user-2" },
        { id: "drop-legacy", scope: "user" },
      ],
    );
    assert.deepStrictEqual(allowed.map((memory) => memory.id), ["keep"]);
  });
});
