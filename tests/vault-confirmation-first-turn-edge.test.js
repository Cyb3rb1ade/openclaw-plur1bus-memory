import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveHostCommandMemoryContext } from "../lib/memory-request-context.js";
import { confirmVaultConfirmation, prepareVaultConfirmation } from "../lib/obsidian-vault-confirmation-flow.js";
const routing = Object.freeze({
  parseAgentSessionKey(v) { const m = /^agent:([^:]+):(.+)$/u.exec(v); return m ? { agentId: m[1], rest: m[2] } : null; },
  parseThreadSessionSuffix(v) { return { baseSessionKey: v, threadId: "" }; },
  normalizeOptionalAccountId(v) { return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined; },
  normalizeMessageChannel(v) { return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined; },
});
const base = { args: "", agentId: "a", senderId: "u", channel: "telegram", accountId: "default", sessionKey: "agent:a:telegram:direct:c", from: "telegram:c", to: "telegram:c", getCurrentConversationBinding: () => null };
describe("prepare in a fresh chat, first agent turn, then confirm", () => {
  // Accepted behaviour, pinned so it cannot be "fixed" by widening the binding:
  // the first agent turn in a chat creates the persisted session, and a
  // confirmation prepared before that turn is refused loudly with the field
  // named. The user repeats prepare. Documented in KNOWN-ISSUES.
  it("is refused with the conversation principal named", async (t) => {
    const ws = mkdtempSync(join(tmpdir(), "edge-")); t.after(() => rmSync(ws, { recursive: true, force: true }));
    const vault = join(ws, "vault"); mkdirSync(vault);
    let entry = null;
    const resolve = (ctx) => resolveHostCommandMemoryContext(ctx, { resolveAgentWorkspaceDir: async () => ws, routingLoader: async () => routing, requireConversation: true, resolveSessionEntry: async () => ({ available: true, entry }) });
    const store = new Map();
    const prepCtx = await resolve({ ...base, sessionId: "rand-1" });
    const prepared = prepareVaultConfirmation({ baseDbPath: ws, memoryCtx: prepCtx, vaultPath: vault, confirmationStore: store });
    assert.equal(prepared.ok, true);
    entry = { sessionId: "persisted-now" };
    const confCtx = await resolve({ ...base, sessionId: "rand-2" });
    const result = confirmVaultConfirmation({ callbackData: prepared.callbackData, confirmationStore: store, baseDbPath: ws, memoryCtx: confCtx, vaultPath: vault });

    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatchedFields, ["conversationPrincipal"]);
  });
});
