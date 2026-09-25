import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.js";
import { createMemoryOpsContext } from "../engine/memory-ops/context.js";
import { isMemoryOpError, memoryOpError } from "../engine/memory-ops/errors.js";

const stateDir = makeTempDir("e1-ctx-");
const ws = makeTempDir("e1-ws-");
const host = { stateDir, workspaceDir: async () => ws };
const P = { agentId: "bernd", workspace: `workspace-dir:v1:${ws}`, channel: "cli", accountId: "host", chat: { id: "cli:u", kind: "direct" }, trust: "proved" };
const USER = { origin: "user", background: false };

test("archive dir is <stateDir>/memory/_archive (same as OpenClaw's ~/.openclaw/memory/_archive)", async () => {
  const r = await createMemoryOpsContext({ host }).resolve(P, USER, {});
  assert.equal(r.archiveDir, join(stateDir, "memory", "_archive"));
  assert.equal(r.agentId, "bernd");
});
for (const a of [{ origin: "cron", background: true }, { origin: "subagent", background: false }, { origin: "user", background: true }, { origin: "user" }]) {
  test(`destructive op refused for ${JSON.stringify(a)}`, async () => {
    await assert.rejects(createMemoryOpsContext({ host }).resolve(P, a, { destructive: true }), (e) => isMemoryOpError(e) && e.code === "denied");
  });
}
test("sharing requires proved trust", async () => {
  await assert.rejects(createMemoryOpsContext({ host }).resolve({ ...P, trust: "inferred" }, USER, { destructive: true, target: "workspace" }), (e) => e.code === "denied");
});
test("invalid agent id is invalid-input", async () => {
  await assert.rejects(createMemoryOpsContext({ host }).resolve({ ...P, agentId: "../x" }, USER), (e) => e.code === "invalid-input");
});
test("unknown error codes are a programming error", () => {
  assert.throws(() => memoryOpError("nope", "x"), TypeError);
});

test("a proved principal claiming a different workspace is denied with a MemoryOpError, not a raw error", async () => {
  const other = makeTempDir("e1-other-ws-");
  await assert.rejects(
    createMemoryOpsContext({ host }).resolve({ ...P, channel: "telegram", workspace: `workspace-dir:v1:${other}` }, USER),
    (e) => isMemoryOpError(e) && e.code === "denied",
  );
});
test("a host that cannot resolve the agent's workspace yields invalid-input", async () => {
  const failing = { stateDir, workspaceDir: async () => { throw new Error("no such agent"); } };
  await assert.rejects(createMemoryOpsContext({ host: failing }).resolve(P, USER), (e) => isMemoryOpError(e) && e.code === "invalid-input");
});
test("the workspace alias snapshot is consulted on every resolve", async () => {
  let calls = 0;
  await createMemoryOpsContext({ host, getWorkspaceAliases: () => { calls += 1; return undefined; } }).resolve(P, USER);
  assert.equal(calls, 1);
});

// fix round 1, E1-R10: a destructive op writes an audit line under
// workspaceDir (lib/sql-safety.js's appendDestructiveOpLog), which fails
// closed for a falsy workspaceDir — refused here, before any mutation,
// instead of surfacing later as that op's own generic "storage" failure.
for (const falsyWorkspaceDir of [undefined, null, ""]) {
  test(`destructive op refused before any mutation when workspaceDir resolves to ${JSON.stringify(falsyWorkspaceDir)}`, async () => {
    const noWorkspaceHost = { stateDir, workspaceDir: async () => falsyWorkspaceDir };
    await assert.rejects(
      createMemoryOpsContext({ host: noWorkspaceHost }).resolve(P, USER, { destructive: true }),
      (e) => isMemoryOpError(e) && e.code === "invalid-input",
    );
  });
}
test("a non-destructive op tolerates a falsy workspaceDir (list/show never write the destructive-op audit log)", async () => {
  const noWorkspaceHost = { stateDir, workspaceDir: async () => undefined };
  const r = await createMemoryOpsContext({ host: noWorkspaceHost }).resolve(P, USER, {});
  assert.equal(r.agentId, "bernd");
});
