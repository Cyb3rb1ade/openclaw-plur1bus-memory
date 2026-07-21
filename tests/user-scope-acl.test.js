import { describe, it } from "node:test";
import assert from "node:assert";

import { checkAccess, filterMemoriesByAcl } from "../lib/acl-middleware.js";

describe('scope="user" ACL', () => {
  const ownerOne = `user:v1:${"a".repeat(64)}`;
  const ownerTwo = `user:v1:${"b".repeat(64)}`;

  it("allows the owning user to access a user-scoped memory", () => {
    const result = checkAccess(
      { userPrincipal: ownerOne },
      { id: "m1", scope: "user", ownerUserId: ownerOne },
    );
    assert.strictEqual(result.allowed, true);
  });

  it("denies a different authenticated user from accessing a user-scoped memory", () => {
    const result = checkAccess(
      { userPrincipal: ownerTwo },
      { id: "m1", scope: "user", ownerUserId: ownerOne },
    );
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "acl.user.mismatch");
  });

  it("denies unauthenticated access to a user-scoped memory", () => {
    const result = checkAccess(
      {},
      { id: "m1", scope: "user", ownerUserId: ownerOne },
    );
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "acl.user.missing_principal");
  });

  it("fails closed for legacy user-scoped rows without an owner binding", () => {
    const result = checkAccess(
      { userPrincipal: ownerOne },
      { id: "m1", scope: "user" },
    );
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.reason, "acl.user.missing_owner");
  });

  it("filters user-scoped memories by owner binding", () => {
    const allowed = filterMemoriesByAcl(
      { userPrincipal: ownerOne },
      [
        { id: "keep", scope: "user", ownerUserId: ownerOne },
        { id: "drop", scope: "user", ownerUserId: ownerTwo },
        { id: "drop-legacy", scope: "user" },
      ],
    );
    assert.deepStrictEqual(allowed.map((memory) => memory.id), ["keep"]);
  });
});
