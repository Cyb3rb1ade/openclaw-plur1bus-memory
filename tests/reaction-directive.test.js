import { describe, it } from "node:test";
import assert from "node:assert";
import { detectReactionsCapability, buildReactionDirective } from "../lib/reaction-directive.js";

describe("detectReactionsCapability", () => {
  it("erkennt reactions in channel actions", () => {
    assert.strictEqual(detectReactionsCapability({ channels: { telegram: { actions: ["send", "reactions"] } } }), true);
    assert.strictEqual(detectReactionsCapability({ agents: { a: { actionGroups: ["react"] } } }), true);
  });

  it("false ohne reactions, bei null und bei zu tiefer Verschachtelung", () => {
    assert.strictEqual(detectReactionsCapability({ channels: { telegram: { actions: ["send"] } } }), false);
    assert.strictEqual(detectReactionsCapability(null), false);
    let deep = { actions: ["reactions"] };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    assert.strictEqual(detectReactionsCapability(deep), false);
  });

  it("verkraftet zyklische Objekte", () => {
    const a = { channels: {} };
    a.channels.self = a;
    assert.strictEqual(detectReactionsCapability(a), false);
  });

  it("erkennt Default-on-Kanäle (OpenClaw 2026.7: reactionLevel-Default minimal)", () => {
    // Live-Schema: enabled-Channel mit Accounts ohne actions/reactionLevel →
    // Gateway-Gate defaultet auf true, Reaktionen sind verfügbar.
    assert.strictEqual(
      detectReactionsCapability({
        channels: { telegram: { enabled: true, accounts: { default: { enabled: true } } } },
      }),
      true
    );
    // Channel ohne Accounts, aber explizit enabled → ebenfalls default-on.
    assert.strictEqual(
      detectReactionsCapability({ channels: { googlechat: { enabled: true } } }),
      true
    );
  });

  it("respektiert explizite Deaktivierung trotz Default-on", () => {
    // reactionLevel off/ack schaltet Agent-Reaktionen ab.
    assert.strictEqual(
      detectReactionsCapability({
        channels: { telegram: { enabled: true, accounts: { default: { enabled: true, reactionLevel: "off" } } } },
      }),
      false
    );
    assert.strictEqual(
      detectReactionsCapability({
        channels: { telegram: { enabled: true, reactionLevel: "ack", accounts: { default: { enabled: true } } } },
      }),
      false
    );
    // Action-Gate-Objekt: reactions === false.
    assert.strictEqual(
      detectReactionsCapability({
        channels: { telegram: { enabled: true, accounts: { default: { enabled: true, actions: { reactions: false } } } } },
      }),
      false
    );
    // Array-Allowlist ohne reactions.
    assert.strictEqual(
      detectReactionsCapability({
        channels: { telegram: { enabled: true, actions: ["send"] } },
      }),
      false
    );
    // Deaktivierter Account/Channel zählt nicht.
    assert.strictEqual(
      detectReactionsCapability({
        channels: { telegram: { enabled: true, accounts: { default: { enabled: false } } } },
      }),
      false
    );
    assert.strictEqual(
      detectReactionsCapability({ channels: { telegram: { enabled: false } } }),
      false
    );
    // Ein Account off, ein anderer default → Capability vorhanden.
    assert.strictEqual(
      detectReactionsCapability({
        channels: { telegram: { enabled: true, accounts: { a: { enabled: true, reactionLevel: "off" }, b: { enabled: true } } } },
      }),
      true
    );
  });

  it("erkennt das reale Gateway-Schema tools.message.actions.allow", () => {
    assert.strictEqual(
      detectReactionsCapability({ tools: { message: { actions: { allow: ["react"] } } } }),
      true
    );
    assert.strictEqual(
      detectReactionsCapability({ actions: { allow: ["send"] } }),
      false
    );
  });
});

describe("buildReactionDirective", () => {
  it("liefert Direktive ≤400 mit Default-Palette", () => {
    const d = buildReactionDirective();
    assert.match(d, /Emoji-Reaktion/);
    assert.match(d, /👍/);
    assert.ok(d.length <= 400);
  });

  it("nutzt übergebene Palette", () => {
    const d = buildReactionDirective({ palette: "🐢 🌊" });
    assert.match(d, /🐢/);
    assert.doesNotMatch(d, /👍/);
  });

  it("bevorzugt explizite Palette vor Persona-Palette", () => {
    const d = buildReactionDirective({ palette: "🐢 🌊", personaPalette: "🌊 🧭 ✨" });
    assert.match(d, /🐢 🌊/);
    assert.doesNotMatch(d, /🌊 🧭 ✨/);
  });

  it("nutzt Persona-Palette wenn keine explizite Palette gesetzt ist", () => {
    const d = buildReactionDirective({ personaPalette: "🌊 🧭 ✨" });
    assert.match(d, /🌊 🧭 ✨/);
    assert.doesNotMatch(d, /👍 ❤️ 😂 🎉 🤔/);
  });
});
