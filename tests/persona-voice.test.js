import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasPersonaVoice, generatePersonaSeed, writePersonaVoice,
  loadPersonaDirective, readPersonaFile, appendMarkerToManagedBlock,
} from "../lib/persona-voice.js";

const SEED = "- Kurze, direkte Sätze.\n- Lieblingswendung: „passt schon“.\n- Emojis sparsam: 🙂 gelegentlich.";

describe("persona-voice", () => {
  it("generatePersonaSeed: nutzt LLM und liefert Bullet-Zeilen", async () => {
    const callLlm = async () => SEED;
    const seed = await generatePersonaSeed({ agentId: "anna", llmCfg: { model: "x" }, callLlm });
    assert.ok(seed.split("\n").every((l) => l.startsWith("- ")));
  });

  it("generatePersonaSeed: null ohne LLM oder bei Fehler", async () => {
    assert.strictEqual(await generatePersonaSeed({ agentId: "anna" }), null);
    const callLlm = async () => { throw new Error("boom"); };
    assert.strictEqual(await generatePersonaSeed({ agentId: "anna", llmCfg: { model: "x" }, callLlm }), null);
  });

  it("writePersonaVoice legt Datei mit Managed-Block an, aber nie doppelt", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    assert.strictEqual(hasPersonaVoice(dir), false);
    assert.strictEqual(writePersonaVoice(dir, SEED), true);
    assert.strictEqual(hasPersonaVoice(dir), true);
    const content = readFileSync(join(dir, "persona-voice.md"), "utf8");
    assert.ok(content.includes("<!-- persona:begin -->"));
    assert.ok(content.includes("passt schon"));
    assert.strictEqual(writePersonaVoice(dir, "- anders"), false); // existiert schon → no-op
  });

  it("loadPersonaDirective: kompakt, ≤400 Zeichen, nur Managed-Block", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, SEED);
    // User-Text außerhalb der Marker darf nicht in die Direktive
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\n\nPrivate User-Notiz GEHEIM", "utf8");
    const directive = loadPersonaDirective(dir);
    assert.ok(directive.includes("passt schon"));
    assert.ok(!directive.includes("GEHEIM"));
    assert.ok(directive.length <= 400);
    assert.match(directive, /Grundstimme/);
  });

  it("loadPersonaDirective: null ohne Datei, fail-open bei kaputtem Inhalt", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    assert.strictEqual(loadPersonaDirective(dir), null);
    writeFileSync(join(dir, "persona-voice.md"), "kein marker", "utf8");
    assert.strictEqual(loadPersonaDirective(dir), null);
  });

  it("appendMarkerToManagedBlock hängt im Block an, User-Text bleibt", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, SEED);
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\nUser-Notiz", "utf8");
    assert.strictEqual(appendMarkerToManagedBlock(dir, "- Neue Marotte."), true);
    const { managedBlock, content } = readPersonaFile(dir);
    assert.ok(managedBlock.includes("Neue Marotte"));
    assert.ok(content.includes("User-Notiz"));
  });
});
