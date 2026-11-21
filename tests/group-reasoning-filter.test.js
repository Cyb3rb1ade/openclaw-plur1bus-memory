import { test } from "node:test";
import assert from "node:assert/strict";
import { shortHash } from "../lib/log-redact.js";
import {
  isForeignReasoningMessage,
  isGroupHookContext,
  createGroupReasoningFilter,
  collectHumanSenderIds,
} from "../lib/group-reasoning-filter.js";

const GROUP_KEY = "agent:main:telegram:group:-1000000000001:topic:1001";
const DM_KEY = "agent:main:telegram:direct:10000001";

test("recognises streamed reasoning previews", () => {
  assert.equal(isForeignReasoningMessage("🧠 The exec result is returning null"), true);
  assert.equal(isForeignReasoningMessage("  💭 hmm"), true);
  assert.equal(isForeignReasoningMessage("<think>plan</think> answer"), true);
  assert.equal(isForeignReasoningMessage("Reasoning: first check the cron"), true);
  assert.equal(isForeignReasoningMessage("PeerBot: 🧠 Ich prüfe zuerst"), true);
  assert.equal(isForeignReasoningMessage("[PeerBot]: 🧠 Ich prüfe zuerst"), true);
});

test("leaves ordinary messages alone", () => {
  assert.equal(isForeignReasoningMessage("Alex, was denkst du? 🧠"), false);
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

test("7.20.2: known human senders are never filtered", () => {
  const logs = [];
  const filter = createGroupReasoningFilter({
    humanSenderIds: () => ["55736530", 1211667028],
    logger: { info: (m) => logs.push(m) },
  });
  assert.equal(filter({ body: "🧠 Bernd, schau mal", isGroup: true, senderId: "55736530" }, {}), undefined);
  assert.equal(filter({ body: "thinking: Bernhardine?", isGroup: true, senderId: "1211667028" }, {}), undefined);
  assert.equal(filter({ cleanedBody: "💭 x" }, { sessionKey: GROUP_KEY, senderId: "telegram:55736530" }), undefined);
  assert.equal(logs.length, 0);
});

test("7.20.2: bot senders are still filtered and the log names sender and prefix", () => {
  const logs = [];
  const filter = createGroupReasoningFilter({
    humanSenderIds: () => ["55736530"],
    logger: { info: (m) => logs.push(m) },
  });
  assert.deepEqual(filter({ body: "🧠 Ich prüfe zuerst", isGroup: true, senderId: "8123456789" }, { sessionKey: GROUP_KEY }), { handled: true });
  // main logs the sender as a hash, never the raw peer id.
  assert.match(logs[0], new RegExp(`sender=${shortHash("8123456789")}`));
  assert.ok(!logs[0].includes("8123456789"), "log must not contain the raw sender id");
  assert.match(logs[0], /prefix=🧠/);
  assert.ok(!logs[0].includes("Ich prüfe"), "log must not contain message text");
});

test("7.20.2: a throwing human-id lookup degrades to the old behavior", () => {
  const filter = createGroupReasoningFilter({ humanSenderIds: () => { throw new Error("boom"); } });
  assert.deepEqual(filter({ body: "🧠 x", isGroup: true, senderId: "1" }, {}), { handled: true });
});

test("7.20.2: collectHumanSenderIds reads channel allowFrom lists, skips wildcards", () => {
  const ids = collectHumanSenderIds({
    channels: {
      telegram: {
        allowFrom: ["*"],
        accounts: {
          default: { allowFrom: [55736530], groupAllowFrom: ["*"] },
          bernhardine: { allowFrom: [1211667028] },
          heisenberg: { allowFrom: ["2048378590"], groupAllowFrom: ["2048378590"] },
        },
      },
      discord: { allowFrom: ["123"] },
    },
  });
  assert.deepEqual([...ids].sort(), ["1211667028", "123", "2048378590", "55736530"]);
  assert.deepEqual([...collectHumanSenderIds(undefined)], []);
});
