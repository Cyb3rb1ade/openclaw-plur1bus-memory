import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertMutationAllowed,
  parseObsidianCommandPlan,
} from "../lib/obsidian-mutation-policy.js";
import { handleObsidianBridgeCommand } from "../lib/obsidian-control-room.js";

function canonicalContext(overrides = {}) {
  return {
    agentId: "agent-a",
    workspaceIdentity: "workspace:v1:workspace-a",
    userId: "owner",
    userPrincipal: "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    conversationPrincipal: "conversation:v1:test",
    chatId: "chat-a",
    chatKind: "private",
    workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
    ...overrides,
  };
}

describe("B14 immutable Obsidian command plan", () => {
  it("normalizes case once and deeply freezes the exact plan and policy", () => {
    const plan = parseObsidianCommandPlan(
      ["RoTaTe", "--ApPlY", "--MAX-AGE-DAYS", "30"],
      {
        memoryCtx: canonicalContext(),
        mode: "apply",
        allowWrite: true,
        vaultConfirmed: true,
        actionConfirmed: true,
        baseDbPath: "/tmp/db",
      },
    );

    assert.equal(plan.command, "rotate");
    assert.equal(plan.options.apply, true);
    assert.equal(plan.options.maxAgeDays, "30");
    assert.equal(plan.mutationPolicy.allows("archive_move"), true);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.options), true);
    assert.equal(Object.isFrozen(plan.capabilities), true);
    assert.equal(Object.isFrozen(plan.mutationPolicy), true);
    assert.throws(() => {
      plan.options.apply = false;
    }, TypeError);
  });

  it("rejects unknown and duplicate flags", () => {
    assert.throws(
      () => parseObsidianCommandPlan(["doctor", "--wat"], { memoryCtx: canonicalContext() }),
      /unknown flag --wat/i,
    );
    assert.throws(
      () => parseObsidianCommandPlan(["rotate", "--apply", "--APPLY"], { memoryCtx: canonicalContext() }),
      /duplicate flag --apply/i,
    );
  });

  it("rejects dry-run combined with every effective mutation flag case-insensitively", () => {
    for (const flag of [
      "--apply",
      "--write",
      "--delete",
      "--allow-delete",
      "--force",
      "--force-soul",
      "--migrate-soul-memory-rules",
    ]) {
      assert.throws(
        () => parseObsidianCommandPlan(["rotate", "--DRY-RUN", flag], { memoryCtx: canonicalContext() }),
        /contradictory/i,
        flag,
      );
    }
  });

  it("requires rotate delete to carry apply and allow-delete", () => {
    assert.throws(
      () => parseObsidianCommandPlan(["rotate", "--delete"], { memoryCtx: canonicalContext() }),
      /requires --apply and --allow-delete/i,
    );
    assert.throws(
      () => parseObsidianCommandPlan(["rotate", "--apply", "--delete"], { memoryCtx: canonicalContext() }),
      /requires --apply and --allow-delete/i,
    );
  });

  it("fails closed when a sink receives no policy or a denied policy", () => {
    assert.throws(() => assertMutationAllowed(null, "vault_write"), /mutation policy required/i);
    const plan = parseObsidianCommandPlan(["dashboards", "build"], {
      memoryCtx: canonicalContext(),
      mode: "augment",
      allowWrite: true,
      vaultConfirmed: true,
      actionConfirmed: true,
    });
    assert.equal(plan.mutationPolicy.allows("vault_write"), false);
    assert.throws(
      () => assertMutationAllowed(plan.mutationPolicy, "vault_write"),
      /mutation denied/i,
    );
  });
});

describe("B14 authorize-before-read command boundary", () => {
  it("rejects contradictory case variants before any data reader or external sink", async () => {
    let reads = 0;
    let writes = 0;
    const result = await handleObsidianBridgeCommand(
      ["ReCoRdS", "ReBuIlD", "--DRY-RUN", "--APPLY"],
      {
        memoryCtx: canonicalContext({ chatKind: "group" }),
        commandCtx: { userId: "intruder", chatId: "group", chatKind: "group" },
        pluginConfig: { security: { allowedUserIds: ["owner"] } },
        loadRecords: async () => {
          reads++;
          return [];
        },
        memoryStore: async () => {
          writes++;
        },
      },
    );

    assert.match(result.text, /contradictory/i);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
  });

  it("denies an unauthorized data-bearing dry-run before reading records", async () => {
    let reads = 0;
    const result = await handleObsidianBridgeCommand(
      ["records", "rebuild", "--dry-run"],
      {
        memoryCtx: canonicalContext({ userId: "intruder", chatKind: "group" }),
        commandCtx: { userId: "intruder", chatId: "group", chatKind: "group" },
        pluginConfig: { security: { allowedUserIds: ["owner"] } },
        loadRecords: async () => {
          reads++;
          return [];
        },
      },
    );

    assert.match(result.text, /🔒/);
    assert.equal(reads, 0);
  });
});
