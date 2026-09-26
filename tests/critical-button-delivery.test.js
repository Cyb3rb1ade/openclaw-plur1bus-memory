// Versand des Critical Push mit Knöpfen über den Telegram-Adapter, mit
// Rückfall auf die Textzustellung (7.16.10).
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverCriticalButtonPush } from "../lib/critical-button-delivery.js";

const config = {
  bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "default", peer: { kind: "direct", id: "55736530" } } }],
  channels: { telegram: { accounts: { default: { botToken: "x" } } } },
};
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
  const out = await deliverCriticalButtonPush({ agentId: "main", result, config, loadAdapter: recorder.loadAdapter });
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
  const out = await deliverCriticalButtonPush({ agentId: "main", result, config, loadAdapter: recorder.loadAdapter });
  assert.equal(out.sent, 1);
  assert.deepEqual(out.unsentTexts, ["Text 2"]);
  assert.equal(out.reason, "send_failed");
});

test("falls back to text without a telegram target or adapter", async () => {
  const noTarget = await deliverCriticalButtonPush({ agentId: "heisenberg", result, config, loadAdapter: adapterRecording().loadAdapter });
  assert.deepEqual(noTarget, { sent: 0, unsentTexts: ["Text 1", "Text 2"], reason: "no_telegram_target" });

  const noAdapter = await deliverCriticalButtonPush({ agentId: "main", result, config, loadAdapter: async () => undefined });
  assert.equal(noAdapter.reason, "adapter_unavailable");
  assert.deepEqual(noAdapter.unsentTexts, ["Text 1", "Text 2"]);

  const legacy = await deliverCriticalButtonPush({
    agentId: "main",
    result: { pushMessages: [{ id: "1", shortRef: "47056", text: "Text 1" }] },
    config,
    loadAdapter: adapterRecording().loadAdapter,
  });
  assert.equal(legacy.reason, "not_buttonable");
});
