import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createMigrationConfirmation,
  verifyMigrationConfirmation,
} from "../lib/reembedding/confirmation.js";
import { createMigrationStateStore } from "../lib/reembedding/state-store.js";

describe("durable reembedding state and confirmations", () => {
  let stateRoot;

  beforeEach(() => { stateRoot = mkdtempSync(join(tmpdir(), "plur1bus-reembedding-state-")); });
  afterEach(() => { rmSync(stateRoot, { recursive: true, force: true }); });

  it("stores no confirmation token and validates its hash, digest, and expiry", () => {
    const issued = createMigrationConfirmation({
      planDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: 2_000,
      randomBytes: () => Buffer.alloc(32, 7),
    });

    assert.equal(Object.hasOwn(issued.persisted, "token"), false);
    assert.equal(verifyMigrationConfirmation(issued.token, issued.persisted, 1_999), true);
    assert.equal(verifyMigrationConfirmation(`${issued.token}x`, issued.persisted, 1_999), false);
    assert.equal(verifyMigrationConfirmation(issued.token, { ...issued.persisted, planDigest: `sha256:${"b".repeat(64)}` }, 1_999), false);
    assert.equal(verifyMigrationConfirmation(issued.token, issued.persisted, 2_000), false);
  });

  it("verifies the exact confirmation binding without consulting its expiry", async () => {
    const confirmation = await import("../lib/reembedding/confirmation.js");
    const issued = createMigrationConfirmation({
      planDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: 2_000,
      randomBytes: () => Buffer.alloc(32, 7),
    });
    const wrongToken = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`;

    assert.equal(confirmation.verifyMigrationConfirmationBinding(issued.token, issued.persisted), true);
    assert.equal(confirmation.verifyMigrationConfirmationBinding(wrongToken, issued.persisted), false);
    assert.equal(confirmation.verifyMigrationConfirmationBinding(`${issued.token}x`, issued.persisted), false);
    assert.equal(confirmation.verifyMigrationConfirmationBinding(issued.token, {
      ...issued.persisted,
      planDigest: `sha256:${"b".repeat(64)}`,
    }), false);
    assert.equal(confirmation.verifyMigrationConfirmationBinding(issued.token, {
      ...issued.persisted,
      schemaVersion: 2,
    }), false);
  });

  it("permits only the declared state transitions with optimistic revisions", async () => {
    const store = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const created = await store.create({
      id: "migration-0001",
      state: "planned",
      planDigest: `sha256:${"a".repeat(64)}`,
      source: { generation: "generation-a", versions: [{ tableId: "agent-a/memories", version: "v1" }] },
      target: { generation: "generation-b", fingerprintId: `embedding:v1:sha256:${"b".repeat(64)}` },
      confirmation: createMigrationConfirmation({
        planDigest: `sha256:${"a".repeat(64)}`,
        expiresAt: 2_000,
        randomBytes,
      }).persisted,
    });
    assert.equal(created.revision, 1);

    const confirmed = await store.transition("migration-0001", "planned", "confirmed", { expectedRevision: 1 });
    assert.equal(confirmed.revision, 2);
    await assert.rejects(
      store.transition("migration-0001", "confirmed", "completed", { expectedRevision: 2 }),
      /invalid migration transition/,
    );
    await assert.rejects(
      store.transition("migration-0001", "confirmed", "running", { expectedRevision: 1 }),
      (error) => error?.code === "reembedding_revision_conflict",
    );
  });

  it("persists mode 0600 atomically and rejects secret-bearing state fields", async () => {
    const store = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    await store.create({
      id: "migration-0001",
      state: "planned",
      planDigest: `sha256:${"a".repeat(64)}`,
      source: { generation: "generation-a", versions: [] },
      target: {
        generation: "generation-b",
        fingerprintId: `embedding:v1:sha256:${"b".repeat(64)}`,
        secretRef: { source: "store", provider: "lab", id: "EMBEDDING_TARGET" },
      },
      confirmation: createMigrationConfirmation({
        planDigest: `sha256:${"a".repeat(64)}`,
        expiresAt: 2_000,
        randomBytes,
      }).persisted,
    });

    const statePath = join(stateRoot, "control", "reembedding-state.json");
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    const persisted = readFileSync(statePath, "utf8");
    assert.doesNotMatch(persisted, /reemb_v1_/);

    await assert.rejects(
      store.create({
        id: "migration-0002",
        state: "planned",
        planDigest: `sha256:${"c".repeat(64)}`,
        source: { generation: "generation-a", versions: [] },
        target: { generation: "generation-c", apiKey: "secret-must-not-persist" },
      }),
      /secret-bearing migration state field/,
    );
  });

  it("serializes writers and allows only one non-terminal migration", async () => {
    const store = createMigrationStateStore({ stateRoot, now: () => 1_000 });
    const record = (id) => ({
      id,
      state: "planned",
      planDigest: `sha256:${"a".repeat(64)}`,
      source: { generation: "generation-a", versions: [] },
      target: { generation: `${id}-target`, fingerprintId: `embedding:v1:sha256:${"b".repeat(64)}` },
    });
    const results = await Promise.allSettled([
      store.create(record("migration-0001")),
      store.create(record("migration-0002")),
    ]);
    assert.deepStrictEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  });

  it("atomically fails an expired planned migration before creating its replacement", async () => {
    let clock = 1_000;
    const store = createMigrationStateStore({ stateRoot, now: () => clock });
    const expired = createMigrationConfirmation({
      planDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: 2_000,
      randomBytes: () => Buffer.alloc(32, 1),
    });
    await store.create({
      id: "migration-expired-planned",
      state: "planned",
      planDigest: `sha256:${"a".repeat(64)}`,
      confirmation: expired.persisted,
      source: { generation: "generation-source", versions: [] },
      target: { generation: "generation-quarantined", fingerprintId: `embedding:v1:sha256:${"b".repeat(64)}` },
      cursor: { tableIndex: 0, offset: 0, completedRows: 0, providerCalls: 0, bytes: 0 },
      receipts: { targetCreated: false },
    });

    clock = 2_000;
    const replacement = createMigrationConfirmation({
      planDigest: `sha256:${"c".repeat(64)}`,
      expiresAt: 3_000,
      randomBytes: () => Buffer.alloc(32, 2),
    });
    const created = await store.create({
      id: "migration-replacement",
      state: "planned",
      planDigest: `sha256:${"c".repeat(64)}`,
      confirmation: replacement.persisted,
      source: { generation: "generation-source", versions: [] },
      target: { generation: "generation-new", fingerprintId: `embedding:v1:sha256:${"d".repeat(64)}` },
    });

    const retired = store.get("migration-expired-planned");
    assert.equal(retired.state, "failed");
    assert.equal(retired.revision, 2);
    assert.equal(retired.updatedAt, "1970-01-01T00:00:02.000Z");
    assert.deepStrictEqual(retired.error, { code: "expired_migration_superseded" });
    assert.equal(retired.target.generation, "generation-quarantined");
    assert.deepStrictEqual(retired.cursor, { tableIndex: 0, offset: 0, completedRows: 0, providerCalls: 0, bytes: 0 });
    assert.deepStrictEqual(retired.receipts, { targetCreated: false });
    assert.equal(created.state, "planned");
    assert.equal(created.revision, 1);
    assert.equal(created.createdAt, "1970-01-01T00:00:02.000Z");

    const durable = JSON.parse(readFileSync(join(stateRoot, "control", "reembedding-state.json"), "utf8"));
    assert.equal(durable.revision, 2);
    assert.equal(durable.migrations["migration-expired-planned"].state, "failed");
    assert.equal(durable.migrations["migration-replacement"].state, "planned");
    assert.doesNotMatch(JSON.stringify(durable), new RegExp(`${expired.token}|${replacement.token}`));
  });

  it("atomically fails an expired running migration without discarding its durable progress", async () => {
    let clock = 1_000;
    const store = createMigrationStateStore({ stateRoot, now: () => clock });
    const confirmation = createMigrationConfirmation({
      planDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: 2_000,
      randomBytes: () => Buffer.alloc(32, 3),
    });
    let running = await store.create({
      id: "migration-expired-running",
      state: "planned",
      planDigest: `sha256:${"a".repeat(64)}`,
      confirmation: confirmation.persisted,
      source: { generation: "generation-source", versions: [] },
      target: { generation: "generation-quarantined", fingerprintId: `embedding:v1:sha256:${"b".repeat(64)}` },
      cursor: { tableIndex: 0, offset: 8, completedRows: 8, providerCalls: 1, bytes: 512 },
      receipts: { targetCreated: true },
    });
    running = await store.transition(running.id, "planned", "confirmed", { expectedRevision: running.revision });
    running = await store.transition(running.id, "confirmed", "running", { expectedRevision: running.revision });

    clock = 2_000;
    const replacement = createMigrationConfirmation({
      planDigest: `sha256:${"c".repeat(64)}`,
      expiresAt: 3_000,
      randomBytes: () => Buffer.alloc(32, 4),
    });
    await store.create({
      id: "migration-after-running",
      state: "planned",
      planDigest: `sha256:${"c".repeat(64)}`,
      confirmation: replacement.persisted,
      source: { generation: "generation-source", versions: [] },
      target: { generation: "generation-new", fingerprintId: `embedding:v1:sha256:${"d".repeat(64)}` },
    });

    const retired = store.get(running.id);
    assert.equal(retired.state, "failed");
    assert.equal(retired.revision, 4);
    assert.deepStrictEqual(retired.error, { code: "expired_migration_superseded" });
    assert.equal(retired.target.generation, "generation-quarantined");
    assert.deepStrictEqual(retired.cursor, { tableIndex: 0, offset: 8, completedRows: 8, providerCalls: 1, bytes: 512 });
    assert.deepStrictEqual(retired.receipts, { targetCreated: true });
  });

  it("keeps an unexpired coordinator migration as a hard active conflict", async () => {
    let clock = 1_000;
    const store = createMigrationStateStore({ stateRoot, now: () => clock });
    await store.create({
      id: "migration-unexpired",
      state: "planned",
      planDigest: `sha256:${"a".repeat(64)}`,
      confirmation: createMigrationConfirmation({
        planDigest: `sha256:${"a".repeat(64)}`,
        expiresAt: 2_000,
        randomBytes,
      }).persisted,
      source: { generation: "generation-source", versions: [] },
      target: { generation: "generation-target", fingerprintId: `embedding:v1:sha256:${"b".repeat(64)}` },
    });

    clock = 1_999;
    await assert.rejects(store.create({
      id: "migration-blocked",
      state: "planned",
      planDigest: `sha256:${"c".repeat(64)}`,
      source: { generation: "generation-source", versions: [] },
      target: { generation: "generation-new", fingerprintId: `embedding:v1:sha256:${"d".repeat(64)}` },
    }), (error) => error?.code === "reembedding_active_conflict");
    assert.equal(store.get("migration-unexpired").state, "planned");
    assert.equal(store.get("migration-blocked"), null);
  });

  it("never auto-retires switching or rollback states after confirmation expiry", async (context) => {
    const cases = [
      ["switching", ["confirmed", "running", "validating", "ready_to_switch", "switching"]],
      ["rollback_planned", ["confirmed", "running", "validating", "ready_to_switch", "switching", "completed", "rollback_planned"]],
      ["rolling_back", ["confirmed", "running", "validating", "ready_to_switch", "switching", "completed", "rollback_planned", "rolling_back"]],
    ];
    for (const [protectedState, transitions] of cases) {
      await context.test(protectedState, async () => {
        let clock = 1_000;
        const store = createMigrationStateStore({ stateRoot: join(stateRoot, protectedState), now: () => clock });
        const confirmation = createMigrationConfirmation({
          planDigest: `sha256:${"a".repeat(64)}`,
          expiresAt: 2_000,
          randomBytes,
        });
        let record = await store.create({
          id: `migration-${protectedState}`,
          state: "planned",
          planDigest: `sha256:${"a".repeat(64)}`,
          confirmation: confirmation.persisted,
          source: { generation: "generation-source", versions: [] },
          target: { generation: "generation-target", fingerprintId: `embedding:v1:sha256:${"b".repeat(64)}` },
        });
        let from = "planned";
        for (const to of transitions) {
          record = await store.transition(record.id, from, to, { expectedRevision: record.revision });
          from = to;
        }

        clock = 2_000;
        await assert.rejects(store.create({
          id: `migration-blocked-by-${protectedState}`,
          state: "planned",
          planDigest: `sha256:${"c".repeat(64)}`,
          source: { generation: "generation-source", versions: [] },
          target: { generation: "generation-new", fingerprintId: `embedding:v1:sha256:${"d".repeat(64)}` },
        }), (error) => error?.code === "reembedding_active_conflict");
        assert.equal(store.get(record.id).state, protectedState);
      });
    }
  });

  it("fails closed on malformed durable state", () => {
    const control = join(stateRoot, "control");
    const store = createMigrationStateStore({ stateRoot });
    writeFileSync(join(control, "reembedding-state.json"), "{broken", { mode: 0o600 });
    assert.throws(() => store.list(), (error) => error?.code === "reembedding_state_invalid");
  });
});
