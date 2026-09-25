import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryOpsContext } from "../engine/memory-ops/context.js";
import { isMemoryOpError, memoryOpError } from "../engine/memory-ops/errors.js";

const stateDir = mkdtempSync(join(tmpdir(), "e1-ctx-"));
const ws = mkdtempSync(join(tmpdir(), "e1-ws-"));
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
