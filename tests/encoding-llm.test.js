import { describe, it } from "node:test";
import assert from "node:assert";
import { parseEncodingResponse, buildEncodingPrompt, classifyEncoding } from "../lib/encoding-llm.js";
import { EMOTION_DIMENSIONS } from "../lib/emotion.js";

describe("encoding llm", () => {
  // R17 (Abschluss-Review, Critical 2): eine lokale Sieben-Elemente-Liste in
  // encoding-llm.js hatte `disgust` vergessen. Das Modell bekam die
  // Dimension nie angeboten, und antwortete es trotzdem so, wurde daraus
  // `neutral` mit leerer Valenz geschrieben — ein falscher Endzustand, nie
  // wieder angefasst. Die Divergenz selbst ist der Defekt, nicht nur die
  // Anwesenheit des Strings — deshalb hier gegen die im Prompt tatsächlich
  // angebotene Liste prüfen, nicht gegen eine erneut hartkodierte Kopie.
  it("bietet dem Modell exakt die kanonischen acht Emotionsdimensionen an", () => {
    const prompt = buildEncodingPrompt("Testtext");
    const match = prompt.match(/dominant: eine von (.+) oder neutral\./);
    assert.ok(match, "Prompt muss die dominant-Zeile enthalten");
    const offeredDimensions = match[1].split(", ");
    assert.deepStrictEqual([...offeredDimensions].sort(), [...EMOTION_DIMENSIONS].sort());
    assert.ok(offeredDimensions.includes("disgust"), "disgust darf nicht fehlen");
  });

  it("akzeptiert disgust als dominant, statt es zu neutral zu machen", () => {
    const parsed = parseEncodingResponse(JSON.stringify({
      importance: 0.6, intensity: 0.9, dominant: "disgust", reason: "Ekel vor Verdorbenem",
    }));
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.emotion.emotionalDominant, "disgust");
    assert.notStrictEqual(parsed.emotion.emotionalDominant, "neutral");
  });

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

  it("refuses coercible-aber-nicht-echte importance-Werte statt sie zu erraten", () => {
    // Number(null) === 0, Number("") === 0, Number(true) === 1, Number([]) === 0 —
    // alle würden Number.isFinite(...) bestehen, obwohl das Modell keine
    // echte Zahl geliefert hat. Ein verweigertes Urteil darf nie als
    // "völlig unwichtig" (0) durchgehen.
    for (const bad of [null, "", true, []]) {
      const parsed = parseEncodingResponse(JSON.stringify({ importance: bad, intensity: 0.5, dominant: "joy" }));
      assert.strictEqual(parsed.ok, false, `importance=${JSON.stringify(bad)} muss ok:false liefern`);
    }
    // Fehlendes Feld ebenfalls.
    const parsed = parseEncodingResponse(JSON.stringify({ intensity: 0.5, dominant: "joy" }));
    assert.strictEqual(parsed.ok, false);
  });

  it("clamps importance in beide Richtungen", () => {
    assert.strictEqual(
      parseEncodingResponse(JSON.stringify({ importance: 5, intensity: 0.1, dominant: "joy" })).importance,
      0.94,
    );
    assert.strictEqual(
      parseEncodingResponse(JSON.stringify({ importance: -3.5, intensity: 0.1, dominant: "joy" })).importance,
      0,
    );
  });

  it("fällt bei kaputter intensity auf 0 zurück, ohne das ganze Urteil zu verwerfen", () => {
    for (const bad of [null, "", true, [], "hoch"]) {
      const parsed = parseEncodingResponse(JSON.stringify({ importance: 0.5, intensity: bad, dominant: "joy" }));
      assert.strictEqual(parsed.ok, true, `importance bleibt gültig, intensity=${JSON.stringify(bad)}`);
      assert.strictEqual(parsed.emotion.emotionalIntensity, 0);
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
