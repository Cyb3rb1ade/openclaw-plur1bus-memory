import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  createWorkspacePolicyStore,
  workspacePolicyKey,
} from "../lib/workspace-policy.js";

function temporaryStateRoot() {
  return mkdtempSync(join(tmpdir(), "plur1bus-workspace-policy-"));
}

const alpha = Object.freeze({
  agentId: "agent-a",
  workspaceIdentity: "workspace:v1:alpha",
});

describe("workspace policy store", () => {
  it("defaults unknown canonical agent/workspace tuples to enabled", () => {
    const root = temporaryStateRoot();
    const store = createWorkspacePolicyStore({ stateRoot: root, now: () => 1234 });
    assert.deepStrictEqual(store.get(alpha), {
      ...alpha,
      enabled: true,
      revision: 0,
      source: "default",
    });
  });

  it("uses canonical agent and workspace identities without owner data", () => {
    assert.equal(workspacePolicyKey(alpha), "agent-a\u0000workspace:v1:alpha");
    assert.equal(
      workspacePolicyKey({ ...alpha, owner: "owner-b", workspaceIdentity: "alpha" }),
      workspacePolicyKey(alpha),
    );
    assert.throws(
      () => workspacePolicyKey({ agentId: "../agent", workspaceIdentity: "alpha" }),
      /agent/i,
    );
  });

  it("persists an override atomically with mode 0600 and survives reload", async () => {
    const root = temporaryStateRoot();
    const store = createWorkspacePolicyStore({ stateRoot: root, now: () => 1234 });
    const disabled = await store.set({
      ...alpha,
      enabled: false,
      expectedRevision: 0,
      actorId: "operator:test",
    });
    assert.deepStrictEqual(disabled, {
      ...alpha,
      enabled: false,
      revision: 1,
      source: "override",
      updatedAt: 1234,
      actorId: "operator:test",
    });
    const statePath = join(root, "control", "workspace-policy.json");
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    assert.deepStrictEqual(
      createWorkspacePolicyStore({ stateRoot: root }).get(alpha),
      disabled,
    );
    assert.deepStrictEqual(JSON.parse(readFileSync(statePath, "utf8")), {
      schemaVersion: 1,
      revision: 1,
      policies: {
        [workspacePolicyKey(alpha)]: {
          ...alpha,
          enabled: false,
          revision: 1,
          updatedAt: 1234,
          actorId: "operator:test",
        },
      },
    });
  });

  it("isolates agents and workspaces and rejects stale revisions", async () => {
    const root = temporaryStateRoot();
    const store = createWorkspacePolicyStore({ stateRoot: root });
    await store.set({ ...alpha, enabled: false, expectedRevision: 0, actorId: "operator:test" });
    assert.equal(store.get(alpha).enabled, false);
    assert.equal(store.get({ agentId: "agent-b", workspaceIdentity: alpha.workspaceIdentity }).enabled, true);
    assert.equal(store.get({ agentId: alpha.agentId, workspaceIdentity: "workspace:v1:beta" }).enabled, true);
    await assert.rejects(
      () => store.set({ ...alpha, enabled: true, expectedRevision: 0, actorId: "operator:test" }),
      (error) => error?.code === "workspace_policy_revision_conflict" && error.current.revision === 1,
    );
  });

  it("serializes concurrent writers so only one expected revision wins", async () => {
    const root = temporaryStateRoot();
    const store = createWorkspacePolicyStore({ stateRoot: root });
    const results = await Promise.allSettled([
      store.set({ ...alpha, enabled: false, expectedRevision: 0, actorId: "operator:a" }),
      store.set({ ...alpha, enabled: true, expectedRevision: 0, actorId: "operator:b" }),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  });

  it("fails closed on malformed state and never overwrites it", () => {
    const root = temporaryStateRoot();
    const statePath = join(root, "control", "workspace-policy.json");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{malformed", { mode: 0o644 });
    const store = createWorkspacePolicyStore({ stateRoot: root });
    assert.throws(() => store.get(alpha), /malformed workspace policy state/i);
    assert.equal(readFileSync(statePath, "utf8"), "{malformed");
  });

  it("repairs an overly broad existing state-file mode on successful write", async () => {
    const root = temporaryStateRoot();
    const store = createWorkspacePolicyStore({ stateRoot: root });
    await store.set({ ...alpha, enabled: false, expectedRevision: 0, actorId: "operator:test" });
    const statePath = join(root, "control", "workspace-policy.json");
    chmodSync(statePath, 0o644);
    await store.set({ ...alpha, enabled: true, expectedRevision: 1, actorId: "operator:test" });
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
  });
});
