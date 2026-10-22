import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.js";
import { createAfterthoughtHost } from "../lib/afterthought-host.js";

const session = { sessionKey: "agent:main:telegram:direct:123", sessionId: "original-session", revision: 3, lastActivityAt: 100, completedAt: 200 };

function fixture(options = {}) {
  const state = {
    entry: { sessionId: session.sessionId, updatedAt: 200, delivery: { kind: "external", context: { channel: "telegram", to: "123", accountId: "owner-bot", threadId: 7 } } },
    facts: { key: session.sessionKey, sessionId: session.sessionId, run: "idle", lastActivityAt: 200, archived: false },
    events: [
      { type: "session", id: "header" },
      { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Original request" }, { type: "image", data: "no-bitmap-in-prompt" }] } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "private hidden reasoning" }, { type: "toolCall", id: "tool-1", name: "search", arguments: { query: "research" } }] } },
      { type: "message", id: "t1", message: { role: "toolResult", toolCallId: "tool-1", toolName: "search", content: [{ type: "text", text: "Relevant original result" }] } },
      { type: "compaction", summary: "Earlier original conversation summary" },
      { type: "message", id: "a2", message: { role: "assistant", content: "Finished answer" } },
    ],
    sent: [], appended: [], contextNotes: [], unsubscribed: 0, listener: null, reads: 0, warnings: [],
  };
  const api = {
    config: {}, logger: { warn(...args) { state.warnings.push(args); } },
    runtime: {
      gateway: {
        async readSessionFacts() { return { sessions: state.facts ? [state.facts] : [] }; },
        subscribeSessionChanges(listener) { state.listener = listener; return () => { state.listener = null; state.unsubscribed += 1; if (options.unsubscribeFailure) throw new Error("subscription already disposed"); }; },
      },
      channel: { outbound: { async loadAdapter() {
        if (options.onLoadAdapter) await options.onLoadAdapter(state);
        return { async sendPayload(payload) {
          if (options.onSend) await options.onSend(state, payload);
          payload.signal?.throwIfAborted();
          state.sent.push(payload);
          return options.receipt ?? { messageId: "sent-1" };
        } };
      } } },
    },
  };
  const host = createAfterthoughtHost({
    api, agentId: "main", workspaceDir: options.workspaceDir ?? "/tmp/afterthought-host-unused",
    loadSessionRuntime: async () => ({
      getSessionEntry: () => state.entry,
      deliveryContextFromSession: (entry) => entry?.delivery?.kind === "external" ? entry.delivery.context : undefined,
      resolveSendPolicy: () => options.sendPolicy ?? "allow",
    }),
    loadTranscriptRuntime: async () => ({
      async readSessionTranscriptEvents(scope) {
        assert.equal(scope.sessionId, "original-session");
        state.reads += 1;
        return structuredClone(state.events);
      },
      async appendAssistantMirrorMessageByIdentity(input) {
        if (options.appendFailure) return { ok: false, code: "session-rebound", reason: "session changed" };
        state.appended.push(input);
        return { ok: true, messageId: "mirror-1" };
      },
      appendSessionTranscriptMessageByIdentityStrict: options.missingContextWriter ? undefined : async (input) => {
        if (options.contextFailure) return { kind: "rejected", reason: "session-rebound" };
        state.contextNotes.push(input);
        return { kind: "result", result: { appended: true, messageId: "context-1" } };
      },
    }),
  });
  return { state, host };
}

test("reads full original conversation including tool calls, results and compaction without hidden reasoning", async () => {
  const { host } = fixture();
  const read = await host.readConversation(session);
  assert.deepEqual(read.messages, [
    { id: "u1", role: "user", content: "Original request\n[image attachment]" },
    { id: "a1", role: "assistant", content: '[tool call: search] {"query":"research"}' },
    { id: "t1", role: "tool", content: "[tool result: search]\nRelevant original result" },
    { role: "system", content: "[conversation summary]\nEarlier original conversation summary" },
    { id: "a2", role: "assistant", content: "Finished answer" },
  ]);
  assert.match(read.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(read.revision, 3);
});

test("preserves source event IDs and timestamps including compaction cursor anchors", async () => {
  const { host, state } = fixture();
  state.events = [
    { type: "message", id: "first", timestamp: "2026-10-22T10:00:00.000Z", message: { role: "user", content: "First correction", timestamp: 42 } },
    { type: "compaction", id: "summary", timestamp: "2026-10-22T10:01:00.000Z", summary: "The correction remains binding." },
  ];
  const { messages } = await host.readConversation(session);
  assert.equal(messages[0].id, "first");
  assert.equal(messages[0].timestamp, 42);
  assert.equal(messages[1].id, "summary");
  assert.equal(messages[1].timestamp, Date.parse("2026-10-22T10:01:00.000Z"));
});

test("preserves branch summaries and the truthful provider-context notes from previous afterthoughts", async () => {
  const { host, state } = fixture();
  state.events = [
    { type: "branch_summary", id: "branch", summary: "Alternative restore approach was rejected." },
    { type: "message", id: "older-note", message: { role: "custom", customType: "plur1bus.afterthought-context", display: false, content: "Previously delivered ASSISTANT afterthought: test a sample restore." } },
  ];
  const { messages } = await host.readConversation(session);
  assert.deepEqual(messages, [
    { id: "branch", role: "system", content: "[conversation summary]\nAlternative restore approach was rejected." },
    { id: "older-note", role: "system", content: "Previously delivered ASSISTANT afterthought: test a sample restore." },
  ]);
});

test("excludes internal heartbeat/cron user and assistant pairs and their tools while retaining genuine discussion", async () => {
  const { host, state } = fixture();
  state.events = [
    { type: "message", message: { role: "user", content: "Explain how heartbeat scheduling works." } },
    { type: "message", message: { role: "assistant", content: "It runs periodically." } },
    { type: "message", message: { role: "user", content: "Read HEARTBEAT.md if it exists. Follow it strictly." } },
    { type: "message", message: { role: "toolResult", toolName: "read", content: "INTERNAL HEARTBEAT NOTES" } },
    { type: "message", message: { role: "assistant", content: "INTERNAL HEARTBEAT ANSWER" } },
    { type: "message", message: { role: "user", content: "[cron:job-id] Run a maintenance task" } },
    { type: "message", message: { role: "assistant", content: "INTERNAL CRON ANSWER" } },
    { type: "message", message: { role: "user", content: "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations." } },
    { type: "message", message: { role: "assistant", content: "INTERNAL NEW HEARTBEAT ANSWER" } },
    { type: "message", message: { role: "user", content: "Continue my proposal." } },
    { type: "message", message: { role: "assistant", content: "CRON MIRROR", openclawDeliveryMirror: { kind: "cron-direct-delivery-context" } } },
    { type: "message", message: { role: "assistant", content: "Here is your genuine proposal." } },
    { type: "message", message: { role: "user", content: "Scheduled automation", provenance: { source: "cron" } } },
    { type: "message", message: { role: "assistant", content: "INTERNAL METADATA CRON ANSWER" } },
  ];
  const { messages } = await host.readConversation(session);
  assert.deepEqual(messages.map((item) => item.content), ["Explain how heartbeat scheduling works.", "It runs periodically.", "Continue my proposal.", "Here is your genuine proposal."]);
});

test("logs generic failures without transport-provided private conversation text", async () => {
  const secret = "PRIVATE ORIGINAL USER QUOTE";
  const { host, state } = fixture({ onSend() { throw new Error(secret); } });
  await host.readConversation(session);
  const result = await host.deliver(session, { text: "Follow-up", idempotencyKey: "key" });
  assert.equal(result.uncertain, true);
  assert.equal(JSON.stringify(state.warnings).includes(secret), false);
});

test("rejects changed session binding, busy session, missing facts and archived sessions", async () => {
  for (const change of [
    (state) => { state.entry.sessionId = "new-session"; },
    (state) => { state.facts.run = "active"; },
    (state) => { state.facts = null; },
    (state) => { state.facts.archived = true; },
  ]) {
    const { host, state } = fixture();
    change(state);
    assert.equal(await host.isCurrent(session), false);
    await assert.rejects(host.readConversation(session));
    assert.equal(state.sent.length, 0);
  }
});

test("detects new inbound transcript activity after the snapshot without depending on timestamp resolution", async () => {
  const { host, state } = fixture();
  await host.readConversation(session);
  state.events.push({ type: "message", message: { role: "user", content: "New request" } });
  assert.equal(await host.isCurrent(session), false);
  const result = await host.deliver(session, { text: "Old follow-up", idempotencyKey: "stable-key" });
  assert.equal(result.sent, false);
  assert.equal(state.sent.length, 0);
});

test("delivers only to the original account/thread and mirrors after the visible send", async () => {
  const { host, state } = fixture();
  await host.readConversation(session);
  const result = await host.deliver(session, { text: "A useful follow-up", idempotencyKey: "stable-key" });
  assert.equal(result.sent, true);
  assert.equal(result.mirrored, true);
  assert.equal(result.contextRecorded, true);
  assert.equal(result.atomic, false);
  assert.equal(state.sent[0].to, "123");
  assert.equal(state.sent[0].accountId, "owner-bot");
  assert.equal(state.sent[0].threadId, 7);
  assert.equal(state.appended[0].sessionId, "original-session");
  assert.equal(state.appended[0].sessionKey, session.sessionKey);
  assert.equal(state.appended[0].idempotencyKey, "stable-key");
  assert.equal(state.appended[0].text, "A useful follow-up");
  assert.equal(state.contextNotes[0].sessionId, "original-session");
  assert.equal(state.contextNotes[0].message.idempotencyKey, "stable-key:context");
  assert.equal(state.contextNotes[0].message.role, "custom");
  assert.equal(state.contextNotes[0].message.display, false);
  assert.notEqual(state.contextNotes[0].message.excludeFromContext, true);
  assert.match(state.contextNotes[0].message.content, /ASSISTANT.*afterthought/);
  assert.match(state.contextNotes[0].message.content, /untrusted historical data/i);
  assert.match(state.contextNotes[0].message.content, /not a new user request/i);
  assert.match(state.contextNotes[0].message.content, /A useful follow-up/);
  assert.equal(state.unsubscribed, 1);
});

test("fails closed without a snapshot or canonical route and honors the session send policy", async () => {
  const noSnapshot = fixture();
  assert.equal((await noSnapshot.host.deliver(session, { text: "Follow-up", idempotencyKey: "key" })).sent, false);
  for (const options of [{}, { sendPolicy: "deny" }]) {
    const { host, state } = fixture(options);
    await host.readConversation(session);
    if (!options.sendPolicy) state.entry.delivery = undefined;
    assert.equal((await host.deliver(session, { text: "Follow-up", idempotencyKey: "key" })).sent, false);
    assert.equal(state.sent.length, 0);
  }
});

test("rechecks activity and route after awaited adapter preparation", async () => {
  for (const mutation of [
    (state) => { state.facts.run = "active"; },
    (state) => { state.entry.delivery.context.to = "different-chat"; },
    (state) => { state.entry.sessionId = "successor"; },
  ]) {
    const { host, state } = fixture({ onLoadAdapter: mutation });
    await host.readConversation(session);
    assert.equal((await host.deliver(session, { text: "Follow-up", idempotencyKey: "key" })).sent, false);
    assert.equal(state.sent.length, 0);
    assert.equal(state.unsubscribed, 1);
  }
});

test("aborts on an original-session invalidation during provider preparation and unsubscribes", async () => {
  const { host, state } = fixture({ onSend(s) { s.listener({ agentId: "main", sessionKey: session.sessionKey }); } });
  await host.readConversation(session);
  const result = await host.deliver(session, { text: "Follow-up", idempotencyKey: "key" });
  assert.equal(result.sent, false);
  assert.equal(result.uncertain, true);
  assert.equal(state.sent.length, 0);
  assert.equal(state.appended.length, 0);
  assert.equal(state.unsubscribed, 1);
});

test("reports an uncertain outcome after a send or mirror failure, preventing blind retries", async () => {
  const sending = fixture({ onSend() { throw new Error("network interrupted after dispatch"); } });
  await sending.host.readConversation(session);
  const failed = await sending.host.deliver(session, { text: "Follow-up", idempotencyKey: "key" });
  assert.equal(failed.uncertain, true);
  assert.equal(failed.sent, false);
  const mirrored = fixture({ appendFailure: true });
  await mirrored.host.readConversation(session);
  const result = await mirrored.host.deliver(session, { text: "Follow-up", idempotencyKey: "key" });
  assert.equal(result.sent, true);
  assert.equal(result.mirrored, false);
  assert.equal(result.uncertain, true);
  assert.equal(mirrored.state.sent.length, 1);
});

test("does not mirror an adapter's explicit not_sent result", async () => {
  const { host, state } = fixture({ receipt: { messageId: "unused", outcome: "not_sent" } });
  await host.readConversation(session);
  const result = await host.deliver(session, { text: "Follow-up", idempotencyKey: "key" });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "not_sent");
  assert.equal(state.appended.length, 0);
});

test("refuses delivery when the public provider-context writer is unavailable", async () => {
  const { host, state } = fixture({ missingContextWriter: true });
  await host.readConversation(session);
  const result = await host.deliver(session, { text: "Follow-up", idempotencyKey: "key" });
  assert.equal(result.sent, false);
  assert.equal(state.sent.length, 0);
});

test("reports confirmed delivery and mirror but uncertain context when the session changes during context append", async () => {
  const { host, state } = fixture({ contextFailure: true });
  await host.readConversation(session);
  const result = await host.deliver(session, { text: "Follow-up", idempotencyKey: "key" });
  assert.equal(result.sent, true);
  assert.equal(result.mirrored, true);
  assert.equal(result.contextRecorded, false);
  assert.equal(result.uncertain, true);
  assert.equal(state.sent.length, 1);
});

test("a subscription cleanup error cannot turn a confirmed send into a retryable failure", async () => {
  const { host } = fixture({ unsubscribeFailure: true });
  await host.readConversation(session);
  const result = await host.deliver(session, { text: "Follow-up", idempotencyKey: "key" });
  assert.equal(result.sent, true);
  assert.equal(result.mirrored, true);
});

test("rechecks send policy after awaited adapter preparation", async () => {
  const options = { onLoadAdapter() { options.sendPolicy = "deny"; } };
  const { host, state } = fixture(options);
  await host.readConversation(session);
  const result = await host.deliver(session, { text: "Follow-up", idempotencyKey: "key" });
  assert.equal(result.sent, false);
  assert.equal(state.sent.length, 0);
});

test("writes optional Markdown below the workspace and passes it as a document attachment", async () => {
  const workspaceDir = makeTempDir("afterthought-host-");
  try {
    const { host, state } = fixture({ workspaceDir });
    await host.readConversation(session);
    const result = await host.deliver(session, { text: "Attached follow-up", document: { title: "../../unsafe title", markdown: "# Complete proposal\n\nAll details." }, idempotencyKey: "../../untrusted-key" });
    assert.equal(result.sent, true);
    assert.match(result.documentPath, /\/\.plur1bus\/afterthoughts\/[a-f0-9]{64}\.md$/);
    assert.equal(readFileSync(result.documentPath, "utf8"), "# Complete proposal\n\nAll details.");
    assert.equal(state.sent[0].mediaUrl, result.documentPath);
    assert.deepEqual(state.sent[0].mediaLocalRoots, [workspaceDir]);
    assert.deepEqual(state.appended[0].mediaUrls, [result.documentPath]);
    assert.match(state.contextNotes[0].message.content, /Complete proposal/);
    assert.match(state.contextNotes[0].message.content, /All details/);
  } finally { rmSync(workspaceDir, { recursive: true, force: true }); }
});

test("rejects an attachment directory symlink escaping the workspace", async () => {
  const workspaceDir = makeTempDir("afterthought-host-");
  const outside = makeTempDir("afterthought-outside-");
  try {
    symlinkSync(outside, join(workspaceDir, ".plur1bus"));
    const { host, state } = fixture({ workspaceDir });
    await host.readConversation(session);
    const result = await host.deliver(session, { text: "Follow-up", document: { title: "Details", markdown: "Details" }, idempotencyKey: "key" });
    assert.equal(result.sent, false);
    assert.equal(state.sent.length, 0);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
