// Versand des Critical Push mit Knöpfen über den Telegram-Adapter, mit
// Rückfall auf die Textzustellung (7.16.10).
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverCriticalButtonPush } from "../lib/critical-button-delivery.js";

const config = {};
const delivery = { channel: "telegram", to: "55736530", accountId: "default" };
const result = {
  pushMessages: [
    { id: "1", shortRef: "47056", text: "Text 1", buttonText: "Karte 1\nReferenz: 47056" },
    { id: "2", shortRef: "dd907", text: "Text 2", buttonText: "Karte 2\nReferenz: dd907" },
  ],
};

function adapterRecording({ failOn } = {}) {
  const sent = [];
  return {
    sent,
    loadAdapter: async (channel) => {
      assert.equal(channel, "telegram");
      return {
        async sendPayload(ctx) {
          if (failOn !== undefined && sent.length === failOn) throw new Error("telegram 429");
          sent.push(ctx);
          return { messageId: String(sent.length) };
        },
      };
    },
  };
}

test("sends one message per card to the agent's bound chat with two buttons each", async () => {
  const recorder = adapterRecording();
  const out = await deliverCriticalButtonPush({ agentId: "main", result, config, delivery, loadAdapter: recorder.loadAdapter });
  assert.deepEqual(out, { sent: 2, unsentTexts: [] });
  assert.equal(recorder.sent.length, 2);
  assert.equal(recorder.sent[0].to, "55736530");
  assert.equal(recorder.sent[0].accountId, "default");
  const buttons = recorder.sent[0].payload.channelData.telegram.buttons;
  assert.deepEqual(buttons[0].map((b) => b.callback_data), ["plurc:a:main:47056", "plurc:r:main:47056"]);
  assert.match(recorder.sent[1].payload.text, /Referenz: dd907/);
});

test("hands the unsent cards back as text when a send fails midway", async () => {
  const recorder = adapterRecording({ failOn: 1 });
  const out = await deliverCriticalButtonPush({ agentId: "main", result, config, delivery, loadAdapter: recorder.loadAdapter });
  assert.equal(out.sent, 1);
  assert.deepEqual(out.unsentTexts, ["Text 2"]);
  assert.equal(out.reason, "send_failed");
});

test("falls back to text without a telegram target or adapter", async () => {
  const noTarget = await deliverCriticalButtonPush({ agentId: "main", result, config, delivery: null, loadAdapter: adapterRecording().loadAdapter });
  assert.deepEqual(noTarget, { sent: 0, unsentTexts: ["Text 1", "Text 2"], reason: "no_telegram_target" });
  const noAccount = await deliverCriticalButtonPush({ agentId: "main", result, config, delivery: { channel: "telegram", to: "55736530" }, loadAdapter: adapterRecording().loadAdapter });
  assert.equal(noAccount.reason, "no_telegram_target");

  const noAdapter = await deliverCriticalButtonPush({ agentId: "main", result, config, delivery, loadAdapter: async () => undefined });
  assert.equal(noAdapter.reason, "adapter_unavailable");
  assert.deepEqual(noAdapter.unsentTexts, ["Text 1", "Text 2"]);

  const legacy = await deliverCriticalButtonPush({
    agentId: "main",
    result: { pushMessages: [{ id: "1", shortRef: "47056", text: "Text 1" }] },
    config,
    delivery,
    loadAdapter: adapterRecording().loadAdapter,
  });
  assert.equal(legacy.reason, "not_buttonable");
});

test("finds the push target in the agent's own classify-recent cron and the bot in its bindings", async () => {
  const { findFeatureCronDelivery, boundTelegramAccountId } = await import("../lib/setup/feature-cron-plan.js");
  const job = (agentId, feature, to, extra = {}) => ({
    agentId,
    enabled: true,
    payload: { kind: "command", argv: ["/usr/bin/node", "/x/extensions/memory-lancedb-namespaced/scripts/run-feature-cron.mjs", "--agent", agentId, "--feature", feature] },
    delivery: { mode: "announce", channel: "telegram", to },
    ...extra,
  });
  const jobs = [
    job("main", "classify-recent", "55736530"),
    job("main", "afterthought", "999"),
    job("bernhardine", "classify-recent", "1211667028"),
    job("heisenberg", "classify-recent", "2048378590", { enabled: false }),
  ];
  assert.deepEqual(findFeatureCronDelivery(jobs, "main", "classify-recent"), { channel: "telegram", to: "55736530" });
  assert.deepEqual(findFeatureCronDelivery(jobs, "bernhardine", "classify-recent"), { channel: "telegram", to: "1211667028" });
  assert.equal(findFeatureCronDelivery(jobs, "heisenberg", "classify-recent"), null, "disabled job is no target");
  assert.equal(findFeatureCronDelivery([...jobs, job("main", "classify-recent", "1")], "main", "classify-recent"), null, "disagreeing targets");

  const cfg = { bindings: [
    { agentId: "main", match: { channel: "discord", accountId: "default" } },
    { agentId: "main", match: { channel: "telegram", accountId: "default" } },
    { agentId: "main", match: { channel: "telegram", accountId: "*" } },
    { agentId: "bernhardine", match: { channel: "telegram", accountId: "bernhardine" } },
  ] };
  assert.equal(boundTelegramAccountId("main", cfg), "default");
  assert.equal(boundTelegramAccountId("bernhardine", cfg), "bernhardine");
  assert.equal(boundTelegramAccountId("heisenberg", cfg), null);
});
