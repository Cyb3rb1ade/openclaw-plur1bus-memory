import { strict as assert } from "node:assert";
import test from "node:test";

import { resolveRemOutputRoot } from "../lib/dreaming/rem-dream.js";

const STORE = "/state/_neo/workspaces/acl-owner-main";
const ctx = { agentId: "main", workspaceDir: "/home/agent/workspace", workspaceIdentity: "workspace-dir:v1:/home/agent/workspace" };

test("the agent's own private partition writes into the agent workspace", () => {
  const partition = { scope: "agent-private", agentId: "main", workspaceIdentity: "", ownerUserId: "" };
  assert.equal(resolveRemOutputRoot({ partition, memoryCtx: ctx, storeWorkspaceDir: STORE }), ctx.workspaceDir);
});

test("another agent's private partition and user pools stay in their store directory", () => {
  assert.equal(resolveRemOutputRoot({ partition: { scope: "agent-private", agentId: "bernhardine" }, memoryCtx: ctx, storeWorkspaceDir: STORE }), STORE);
  assert.equal(resolveRemOutputRoot({ partition: { scope: "user", agentId: "main", ownerUserId: "u1" }, memoryCtx: ctx, storeWorkspaceDir: STORE }), STORE);
});

test("the shared workspace partition follows the bound workspace identity only", () => {
  const same = { scope: "workspace", agentId: "main", workspaceIdentity: ctx.workspaceIdentity };
  const other = { scope: "workspace", agentId: "main", workspaceIdentity: "workspace-dir:v1:/elsewhere" };
  assert.equal(resolveRemOutputRoot({ partition: same, memoryCtx: ctx, storeWorkspaceDir: STORE }), ctx.workspaceDir);
  assert.equal(resolveRemOutputRoot({ partition: other, memoryCtx: ctx, storeWorkspaceDir: STORE }), STORE);
});

test("without a memory context everything stays in the store directory", () => {
  assert.equal(resolveRemOutputRoot({ partition: { scope: "agent-private", agentId: "main" }, memoryCtx: null, storeWorkspaceDir: STORE }), STORE);
  assert.equal(resolveRemOutputRoot({ partition: { scope: "agent-private", agentId: "main" }, memoryCtx: { agentId: "main" }, storeWorkspaceDir: STORE }), STORE);
});
