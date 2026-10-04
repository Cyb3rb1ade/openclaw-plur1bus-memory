import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isForeignReasoningMessage,
  isGroupHookContext,
  createGroupReasoningFilter,
} from "../lib/group-reasoning-filter.js";

const GROUP_KEY = "agent:main:telegram:group:-1003839640481:topic:5778";
const DM_KEY = "agent:main:telegram:direct:55736530";

test("recognises streamed reasoning previews", () => {
  assert.equal(isForeignReasoningMessage("🧠 The exec result is returning null"), true);
  assert.equal(isForeignReasoningMessage("  💭 hmm"), true);
  assert.equal(isForeignReasoningMessage("<think>plan</think> answer"), true);
  assert.equal(isForeignReasoningMessage("Reasoning: first check the cron"), true);
  assert.equal(isForeignReasoningMessage("Bernhardine: 🧠 Ich prüfe zuerst"), true);
  assert.equal(isForeignReasoningMessage("[Bernhardine]: 🧠 Ich prüfe zuerst"), true);
});

test("leaves ordinary messages alone", () => {
  assert.equal(isForeignReasoningMessage("Bernd, was denkst du? 🧠"), false);
  assert.equal(isForeignReasoningMessage("Gute Idee"), false);
  assert.equal(isForeignReasoningMessage(""), false);
  assert.equal(isForeignReasoningMessage(undefined), false);
});

test("custom prefixes replace the defaults", () => {
  assert.equal(isForeignReasoningMessage("🤔 grübel", { prefixes: ["🤔"] }), true);
  assert.equal(isForeignReasoningMessage("🧠 x", { prefixes: ["🤔"] }), false);
});

test("group detection from chat type or session key", () => {
  assert.equal(isGroupHookContext({ chatType: "supergroup" }), true);
  assert.equal(isGroupHookContext({ sessionKey: GROUP_KEY }), true);
  assert.equal(isGroupHookContext({ sessionKey: DM_KEY }), false);
  assert.equal(isGroupHookContext({}), false);
});

test("filter claims group reasoning turns without a reply", () => {
  const logs = [];
  const filter = createGroupReasoningFilter({ logger: { info: (m) => logs.push(m) } });
  assert.deepEqual(filter({ cleanedBody: "🧠 Ich schaue nach" }, { sessionKey: GROUP_KEY, agentId: "main" }), { handled: true });
  assert.deepEqual(filter({ body: "🧠 x", content: "[Telegram] 🧠 x", isGroup: true }, {}), { handled: true });
  assert.equal(logs.length, 2);
  assert.ok(!logs[0].includes("Ich schaue nach"), "log must not contain message text");
});

test("filter never touches direct chats or normal group messages", () => {
  const filter = createGroupReasoningFilter();
  assert.equal(filter({ cleanedBody: "🧠 test" }, { sessionKey: DM_KEY }), undefined);
  assert.equal(filter({ body: "🧠 test", isGroup: false }, { sessionKey: DM_KEY }), undefined);
  assert.equal(filter({ cleanedBody: "Hallo zusammen" }, { sessionKey: GROUP_KEY }), undefined);
});

test("disabled filter passes everything through", () => {
  const filter = createGroupReasoningFilter({ enabled: false });
  assert.equal(filter({ cleanedBody: "🧠 test" }, { sessionKey: GROUP_KEY }), undefined);
});
