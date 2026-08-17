import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNeoStore } from "../lib/neo-arch.js";
import { previewDropInjected, applyDropInjected } from "../lib/drop-injected-conflicts.js";
import { createConfirmation } from "../lib/security.js";
import { rememberPendingConfirmation, completePendingConfirmation } from "../index.js";

const INJECTED = "Write a dream diary entry from these memory fragments: leftover prompt";
const REAL = "User prefers short answers in the morning.";
const REQUESTER = {
  requesterAgentId: "agent-a",
  requesterWorkspaceKey: "ws-a",
  requesterOwnerId: "",
};

function storeWith(rows) {
  const dir = mkdtempSync(join(tmpdir(), "drop-inj-"));
  const store = createNeoStore(dir, "ws-a");
  store.appendBehaviorCards(rows);
  return { dir, store };
}

function card(id, overrides = {}) {
  return {
    id,
    status: "conflict",
    statement: INJECTED,
    category: "communication_style",
    agentId: "agent-a",
    workspaceKey: "ws-a",
    ...overrides,
  };
}

describe("drop injected behavior conflicts", () => {
  it("previews only newest conflict rows that look injected", () => {
    const { dir, store } = storeWith([
      card("11111111-1111-4111-8111-111111111111"),
      card("22222222-2222-4222-8222-222222222222", { statement: REAL }),
      card("33333333-3333-4333-8333-333333333333", { status: "active" }),
    ]);
    const preview = previewDropInjected(store, REQUESTER);
    assert.equal(preview.ok, true);
    assert.equal(preview.count, 1);
    assert.equal(preview.ids[0], "11111111-1111-4111-8111-111111111111");
    assert.ok(preview.hash);
    assert.ok(preview.examples[0].statement.includes("dream diary"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops matching conflicts via demote and leaves real conflicts and active injection", () => {
    const injectedId = "11111111-1111-4111-8111-111111111111";
    const realId = "22222222-2222-4222-8222-222222222222";
    const activeId = "33333333-3333-4333-8333-333333333333";
    const { dir, store } = storeWith([
      card(injectedId),
      card(realId, { statement: REAL }),
      card(activeId, { status: "active" }),
    ]);
    const preview = previewDropInjected(store, REQUESTER);
    const out = applyDropInjected(store, {
      authorized: true,
      requester: REQUESTER,
      expectedHash: preview.hash,
      expectedCount: preview.count,
    });
    assert.equal(out.ok, true);
    assert.equal(out.dropped, 1);
    const newest = Object.fromEntries(store.readBehaviorCards(50).map((row) => [row.id, row]));
    assert.equal(newest[injectedId].status, "demoted");
    assert.equal(newest[realId].status, "conflict");
    assert.equal(newest[activeId].status, "active");
    const again = applyDropInjected(store, {
      authorized: true,
      requester: REQUESTER,
      expectedHash: preview.hash,
      expectedCount: preview.count,
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, "drift");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not touch a foreign agent or workspace row", () => {
    const ownId = "11111111-1111-4111-8111-111111111111";
    const foreignId = "22222222-2222-4222-8222-222222222222";
    const { dir, store } = storeWith([
      card(ownId),
      card(foreignId, { agentId: "agent-b", workspaceKey: "ws-b" }),
    ]);
    const preview = previewDropInjected(store, REQUESTER);
    assert.deepEqual(preview.ids, [ownId]);
    applyDropInjected(store, {
      authorized: true,
      requester: REQUESTER,
      expectedHash: preview.hash,
      expectedCount: preview.count,
    });
    const newest = Object.fromEntries(store.readBehaviorCards(50).map((row) => [row.id, row]));
    assert.equal(newest[foreignId].status, "conflict");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses unauthorized apply and hash drift", () => {
    const { dir, store } = storeWith([card("11111111-1111-4111-8111-111111111111")]);
    const preview = previewDropInjected(store, REQUESTER);
    assert.equal(applyDropInjected(store, {
      authorized: false,
      requester: REQUESTER,
      expectedHash: preview.hash,
      expectedCount: preview.count,
    }).ok, false);
    assert.equal(applyDropInjected(store, {
      authorized: true,
      requester: REQUESTER,
      expectedHash: "deadbeef",
      expectedCount: preview.count,
    }).reason, "drift");
    const newest = store.readBehaviorCards(50).find((row) => row.id.startsWith("11111111"));
    assert.equal(newest.status, "conflict");
    rmSync(dir, { recursive: true, force: true });
  });

  it("binds the preview hash to requester scope and aborts drift before any write", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { dir, store } = storeWith([card(id)]);
    const preview = previewDropInjected(store, REQUESTER);
    const otherScope = previewDropInjected(store, {
      requesterAgentId: "agent-b",
      requesterWorkspaceKey: "ws-a",
    });
    assert.notEqual(preview.hash, otherScope.hash);
    const drifted = applyDropInjected(store, {
      authorized: true,
      requester: { requesterAgentId: "agent-b", requesterWorkspaceKey: "ws-a" },
      expectedHash: preview.hash,
      expectedCount: preview.count,
    });
    assert.equal(drifted.reason, "drift");
    store.appendBehaviorCards([card("44444444-4444-4444-8444-444444444444")]);
    const afterInsert = applyDropInjected(store, {
      authorized: true,
      requester: REQUESTER,
      expectedHash: preview.hash,
      expectedCount: preview.count,
    });
    assert.equal(afterInsert.reason, "drift");
    const newest = Object.fromEntries(store.readBehaviorCards(50).map((row) => [row.id, row]));
    assert.equal(newest[id].status, "conflict");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects invalid and replayed drop-injected nonces", () => {
    const { dir, store } = storeWith([card("11111111-1111-4111-8111-111111111111")]);
    const preview = previewDropInjected(store, REQUESTER);
    const confirmationStore = new Map();
    const confirmationIndex = new Map();
    const pending = createConfirmation({
      userId: "owner",
      chatId: "owner-dm",
      command: "drop-injected",
      targetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    pending.payload = { hash: preview.hash, count: preview.count };
    rememberPendingConfirmation(confirmationStore, confirmationIndex, pending);
    const memoryCtx = { userId: "owner", conversationPrincipal: "owner-dm", chatId: "owner-dm" };
    const invalid = completePendingConfirmation({
      confirmationStore,
      confirmationIndex,
      expectedCommand: "drop-injected",
      memoryCtx,
      nonce: "00000000-0000-4000-8000-000000000099",
    });
    assert.ok(invalid.error);
    const first = completePendingConfirmation({
      confirmationStore,
      confirmationIndex,
      expectedCommand: "drop-injected",
      memoryCtx,
      nonce: pending.nonce,
    });
    assert.equal(first.pending.payload.hash, preview.hash);
    const replay = completePendingConfirmation({
      confirmationStore,
      confirmationIndex,
      expectedCommand: "drop-injected",
      memoryCtx,
      nonce: pending.nonce,
    });
    assert.ok(replay.error);
    assert.equal(store.readBehaviorCards(50).find((row) => row.id.startsWith("11111111")).status, "conflict");
    rmSync(dir, { recursive: true, force: true });
  });
});
