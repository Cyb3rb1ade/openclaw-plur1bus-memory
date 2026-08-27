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

  it("fails closed on malformed durable state", () => {
    const control = join(stateRoot, "control");
    const store = createMigrationStateStore({ stateRoot });
    writeFileSync(join(control, "reembedding-state.json"), "{broken", { mode: 0o600 });
    assert.throws(() => store.list(), (error) => error?.code === "reembedding_state_invalid");
  });
});
