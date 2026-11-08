import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.js";
import { registerAfterthoughtActivityHooks } from "../lib/afterthought-hooks.js";
import { observeAfterthoughtActivity, runConversationAfterthoughtJob } from "../lib/afterthought-reflection.js";
import { createAfterthoughtHost } from "../lib/afterthought-host.js";

test("interactive hooks schedule full-history reflection, original-chat delivery and context exactly once", async () => {
  const workspaceDir = makeTempDir("afterthought-integration-");
  const completedAt = Date.parse("2026-10-22T10:00:00Z");
  const key = "agent:main:telegram:owner:direct:123";
  const sessionId = "original-transcript";
  const hooks = new Map();
  const sent = []; const mirrors = []; const contextNotes = [];
  const config = {};
  const originalRoute = { channel: "telegram", to: "123", accountId: "original-bot", threadId: 17 };
  const entry = { sessionId, updatedAt: completedAt, delivery: { kind: "external", context: originalRoute } };
  const events = [
    { type: "message", id: "first-user", message: { role: "user", content: "Initial decision: use the offline archive.", timestamp: completedAt - 180 * 60_000 } },
    { type: "message", id: "early-correction", message: { role: "user", content: "Correction: keep the encryption keys separate.", timestamp: completedAt - 179 * 60_000 } },
    { type: "message", id: "tool-call", message: { role: "assistant", content: [{ type: "toolCall", id: "scan-1", name: "archive_scan", arguments: { mode: "offline" } }] } },
    { type: "message", id: "tool-result", message: { role: "toolResult", toolName: "archive_scan", toolCallId: "scan-1", content: "The archive contains two encrypted backup sets." } },
    { type: "compaction", id: "summary", summary: "Prior summary: offline restore testing is still an open point." },
    { type: "message", id: "heartbeat-user", message: { role: "user", content: "Read HEARTBEAT.md if it exists. Follow it strictly." } },
    { type: "message", id: "heartbeat-assistant", message: { role: "assistant", content: "INTERNAL MAINTENANCE MUST NOT ENTER REFLECTION" } },
    { type: "message", id: "latest-user", message: { role: "user", content: "Thanks, we can stop here.", timestamp: completedAt - 1000 } },
    { type: "message", id: "latest-assistant", message: { role: "assistant", content: "The agreed backup plan is ready.", timestamp: completedAt } },
  ];
  writeFileSync(join(workspaceDir, "SOUL.md"), "Use a calm, plain voice.");
  const api = {
    config, logger: { warn() {} },
    on: (name, handler) => hooks.set(name, handler),
    runtime: {
      gateway: {
        readSessionFacts: async () => ({ sessions: [{ key, sessionId, run: "idle", archived: false, lastActivityAt: completedAt }] }),
        subscribeSessionChanges: () => () => {},
      },
      channel: { outbound: { loadAdapter: async () => ({ sendPayload: async (payload) => {
        sent.push(payload);
        return { channel: "telegram", messageId: "provider-message-1" };
      } }) } },
    },
  };
  registerAfterthoughtActivityHooks({
    api,
    classifyIncognito: async () => false,
    observe: (workspace, activity) => observeAfterthoughtActivity(workspace, {
      ...activity, now: activity.phase === "start" ? completedAt - 1000 : completedAt, random: () => 0,
    }),
  });
  const ctx = { agentId: "main", workspaceDir, sessionKey: key, sessionId, runId: "interactive-run" };
  await hooks.get("before_prompt_build")({ prompt: "Thanks, we can stop here." }, ctx);
  await hooks.get("agent_end")({ success: true, messages: events.filter((event) => event.message).map((event) => event.message) }, ctx);
  const host = createAfterthoughtHost({
    api, agentId: "main", workspaceDir,
    loadSessionRuntime: async () => ({
      getSessionEntry: () => entry,
      deliveryContextFromSession: (session) => session.delivery?.context,
      resolveSendPolicy: () => "allow",
    }),
    loadTranscriptRuntime: async () => ({
      readSessionTranscriptEvents: async (target) => { assert.equal(target.sessionId, sessionId); return structuredClone(events); },
      appendAssistantMirrorMessageByIdentity: async (mirror) => { mirrors.push(mirror); return { ok: true, messageId: "mirror-1" }; },
      appendSessionTranscriptMessageByIdentityStrict: async (note) => { contextNotes.push(note); return { kind: "result", result: { appended: true, messageId: "context-1" } }; },
    }),
  });
  let modelCalls = 0;
  const job = () => runConversationAfterthoughtJob({
    workspaceDir, agentId: "main", llmCfg: { model: "injected-test" },
    now: completedAt + 15 * 60_000, hour: 12,
    ...host,
    callLlm: async (messages) => {
      modelCalls += 1;
      const prompt = messages.map((message) => message.content).join("\n");
      for (const literal of ["Initial decision: use the offline archive.", "Correction: keep the encryption keys separate.", "archive_scan", "two encrypted backup sets", "offline restore testing is still an open point", "Use a calm, plain voice."]) assert.ok(prompt.includes(literal), literal);
      assert.ok(!prompt.includes("INTERNAL MAINTENANCE MUST NOT ENTER REFLECTION"));
      return JSON.stringify({ send: true, text: "One useful addition: test restoring a small offline sample.", document: { title: "Restore check", markdown: "# Restore check\n\nKeep the encryption keys separate during the test." } });
    },
  });
  const result = await job();
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "123");
  assert.equal(sent[0].accountId, "original-bot");
  assert.equal(sent[0].threadId, 17);
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0].sessionKey, key);
  assert.equal(mirrors[0].sessionId, sessionId);
  assert.equal(contextNotes.length, 1);
  assert.equal(contextNotes[0].sessionId, sessionId);
  assert.equal(contextNotes[0].message.role, "custom");
  assert.equal(contextNotes[0].message.display, false);
  assert.match(contextNotes[0].message.content, /Keep the encryption keys separate during the test/);
  assert.equal(readFileSync(sent[0].mediaUrl, "utf8"), "# Restore check\n\nKeep the encryption keys separate during the test.");
  const durable = JSON.parse(readFileSync(join(workspaceDir, ".afterthought-reflection.json"), "utf8"));
  const recorded = Object.values(durable.sessions)[0];
  assert.equal(recorded.reflectedRevision, 1);
  assert.equal(recorded.reflectedCursor.id, "latest-assistant");
  assert.equal(recorded.deliveryIntent.status, "delivered");
  assert.equal(durable.lastSentDate, "2026-10-22");
  assert.ok(!JSON.stringify(durable).includes("Initial decision"));
  assert.equal((await job()).skipped, true);
  assert.equal(modelCalls, 1);
  assert.equal(sent.length, 1);
  assert.equal(mirrors.length, 1);
  assert.equal(contextNotes.length, 1);
});
