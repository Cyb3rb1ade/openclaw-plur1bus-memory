import assert from "node:assert/strict";
import { test } from "node:test";
import { registerAfterthoughtActivityHooks } from "../lib/afterthought-hooks.js";

function fixture(options = {}) {
  const hooks = new Map(); const observed = [];
  registerAfterthoughtActivityHooks({
    api: { on: (name, handler) => hooks.set(name, handler), logger: { warn() {} } },
    observe: (workspace, activity) => observed.push({ workspace, ...activity }),
    classifyIncognito: async () => false,
    isAllowed: () => true,
    ...options,
  });
  return { hooks, observed };
}
const ctx = { agentId: "main", workspaceDir: "/tmp/test-workspace", sessionKey: "agent:main:telegram:default:direct:123", sessionId: "session-1", runId: "run-1" };

test("interactive turn starts and finishes the same session's idle clock", async () => {
  const { hooks, observed } = fixture();
  await hooks.get("before_prompt_build")({ prompt: "Planen wir die Reise." }, ctx);
  await hooks.get("agent_end")({ success: true, messages: [{ role: "user", content: "Planen wir die Reise." }, { role: "assistant", content: "Hier ist der Plan." }] }, ctx);
  assert.deepEqual(observed.map(({ phase, sessionKey, runId }) => ({ phase, sessionKey, runId })), [
    { phase: "start", sessionKey: ctx.sessionKey, runId: "run-1" },
    { phase: "end", sessionKey: ctx.sessionKey, runId: "run-1" },
  ]);
});

test("heartbeat in a direct chat never starts a user inactivity window", async () => {
  const { hooks, observed } = fixture();
  const prompt = "Read the current HEARTBEAT.md in your workspace with the read tool and work through every item in it.";
  await hooks.get("before_prompt_build")({ prompt }, ctx);
  await hooks.get("agent_end")({ messages: [{ role: "user", content: prompt }, { role: "assistant", content: "HEARTBEAT_OK" }] }, ctx);
  assert.equal(observed.length, 0);
});

test("incognito, denied workspaces and unsuccessful turns cannot arm reflection", async () => {
  for (const options of [{ classifyIncognito: async () => true }, { isAllowed: () => false }]) {
    const f = fixture(options);
    await f.hooks.get("before_prompt_build")({ prompt: "privat" }, ctx);
    await f.hooks.get("agent_end")({ success: true, messages: [{ role: "user", content: "privat" }, { role: "assistant", content: "Antwort" }] }, ctx);
    assert.equal(f.observed.length, 0);
  }
  const f = fixture();
  await f.hooks.get("agent_end")({ success: false, messages: [{ role: "user", content: "Frage" }] }, ctx);
  assert.equal(f.observed.some((a) => a.phase === "end"), false);
});

test("missing transcript identity is not persisted and disabled feature adds no hooks", async () => {
  const f = fixture();
  await f.hooks.get("before_prompt_build")({ prompt: "Frage" }, { ...ctx, sessionId: undefined });
  assert.equal(f.observed.length, 0);
  assert.equal(fixture({ enabled: false }).hooks.size, 0);
});

test("oversized session identity is refused before the activity writer", async () => {
  const f = fixture();
  await f.hooks.get("before_prompt_build")({ prompt: "Frage" }, { ...ctx, sessionKey: "x".repeat(1025) });
  assert.equal(f.observed.length, 0);
});
