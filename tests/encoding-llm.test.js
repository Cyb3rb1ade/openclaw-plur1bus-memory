import { describe, it } from "node:test";
import assert from "node:assert";
import { parseEncodingResponse, buildEncodingPrompt, classifyEncoding } from "../lib/encoding-llm.js";

describe("encoding llm", () => {
  it("asks for both judgements in one prompt", () => {
    const prompt = buildEncodingPrompt("Mein Hund ist heute eingeschlaefert worden.");
    assert.match(prompt, /importance/i);
    assert.match(prompt, /intensity/i);
    assert.match(prompt, /Mein Hund/);
  });

  it("parses a well formed answer", () => {
    const parsed = parseEncodingResponse(JSON.stringify({
      importance: 0.88, intensity: 0.9, dominant: "sadness", reason: "Verlust eines Haustiers",
    }));
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.importance, 0.88);
    assert.strictEqual(parsed.emotion.emotionalDominant, "sadness");
    assert.strictEqual(parsed.reason, "Verlust eines Haustiers");
  });

  it("caps the model at the automatic ceiling", () => {
    const parsed = parseEncodingResponse(JSON.stringify({ importance: 0.99, intensity: 0.4, dominant: "joy" }));
    assert.strictEqual(parsed.importance, 0.94);
  });

  it("refuses garbage instead of inventing a value", () => {
    for (const raw of ["", "kein json", JSON.stringify({ intensity: 0.5 })]) {
      assert.strictEqual(parseEncodingResponse(raw).ok, false);
    }
  });

  it("classifyEncoding baut Messages wie Tier 3 und liefert das geparste Urteil", async () => {
    let seenMessages = null;
    let seenContext = null;
    const callLlm = async (messages, context) => {
      seenMessages = messages;
      seenContext = context;
      return JSON.stringify({ importance: 0.7, intensity: 0.6, dominant: "trust", reason: "Zusage gemacht" });
    };

    const result = await classifyEncoding("Wir treffen uns nächsten Dienstag.", {
      agentId: "bernd",
      callLlm,
      signal: undefined,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.importance, 0.7);
    assert.strictEqual(result.emotion.emotionalDominant, "trust");

    // Aufbau folgt lib/tier3-llm.js: [{role:"system",...},{role:"user",...}]
    assert.strictEqual(Array.isArray(seenMessages), true);
    assert.strictEqual(seenMessages.length, 2);
    assert.strictEqual(seenMessages[0].role, "system");
    assert.strictEqual(seenMessages[1].role, "user");
    assert.match(seenMessages[1].content, /Wir treffen uns nächsten Dienstag/);
    assert.strictEqual(seenContext.agentId, "bernd");
  });

  it("liefert ok:false statt eines geratenen Werts, wenn callLlm wirft", async () => {
    const callLlm = async () => {
      throw new Error("Provider nicht erreichbar");
    };

    const result = await classifyEncoding("Irgendein Text.", { agentId: "bernd", callLlm });
    assert.strictEqual(result.ok, false);
  });

  it("liefert ok:false, wenn kein callLlm übergeben wird", async () => {
    const result = await classifyEncoding("Irgendein Text.", { agentId: "bernd" });
    assert.strictEqual(result.ok, false);
  });
});
