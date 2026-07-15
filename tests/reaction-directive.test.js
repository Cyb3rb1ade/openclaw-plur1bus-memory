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
