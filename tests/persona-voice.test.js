import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasPersonaVoice, generatePersonaSeed, writePersonaVoice,
  loadPersonaDirective, readPersonaFile, appendMarkerToManagedBlock,
  proposePersonaEvolution, acceptPersonaProposal,
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

const T1 = 1750000000000;
function outcome(ts, kind) { return { timestamp: ts, outcome: kind }; }

describe("persona evolution", () => {
  function seededDir() {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, SEED);
    return dir;
  }

  it("schlägt bei positivem Trend genau EINEN Marker vor", async () => {
    const dir = seededDir();
    const outcomes = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "confirmed_or_continued"));
    const callLlm = async () => "- Neue Wendung: „alles klar soweit\".";
    const res = await proposePersonaEvolution({ workspaceDir: dir, outcomes, llmCfg: { model: "x" }, callLlm, now: T1 });
    assert.strictEqual(res.proposed, true);
    const content = readFileSync(join(dir, "persona-voice.md"), "utf8");
    assert.ok(content.includes("## Vorschlag (nicht aktiv)"));
    assert.ok(content.includes("alles klar soweit"));
  });

  it("kein Vorschlag bei zu wenigen oder negativen Outcomes", async () => {
    const dir = seededDir();
    const few = [outcome(T1, "confirmed_or_continued")];
    assert.strictEqual((await proposePersonaEvolution({ workspaceDir: dir, outcomes: few, llmCfg: { model: "x" }, callLlm: async () => "- x", now: T1 })).proposed, false);
    const negative = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "ignored_or_topic_shifted"));
    assert.strictEqual((await proposePersonaEvolution({ workspaceDir: dir, outcomes: negative, llmCfg: { model: "x" }, callLlm: async () => "- x", now: T1 })).proposed, false);
  });

  it("Vorschlag landet NICHT in der Direktive, accept übernimmt ihn", async () => {
    const dir = seededDir();
    const outcomes = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "confirmed_or_continued"));
    await proposePersonaEvolution({ workspaceDir: dir, outcomes, llmCfg: { model: "x" }, callLlm: async () => "- Marotte: zählt gern auf.", now: T1 });
    assert.ok(!loadPersonaDirective(dir).includes("zählt gern auf"));
    const res = acceptPersonaProposal(dir);
    assert.strictEqual(res.accepted, true);
    assert.ok(loadPersonaDirective(dir).includes("zählt gern auf"));
    assert.ok(!readFileSync(join(dir, "persona-voice.md"), "utf8").includes("## Vorschlag (nicht aktiv)"));
  });

  it("accept ohne Vorschlag → accepted false", () => {
    const dir = seededDir();
    assert.strictEqual(acceptPersonaProposal(dir).accepted, false);
  });

  it("User-Notiz unterhalb einer bestehenden Vorschlagssektion übersteht erneutes proposePersonaEvolution", async () => {
    const dir = seededDir();
    const outcomes = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "confirmed_or_continued"));
    await proposePersonaEvolution({ workspaceDir: dir, outcomes, llmCfg: { model: "x" }, callLlm: async () => "- Erste Marotte.", now: T1 });
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\n\n## Meine eigene Notiz\n\nDas darf nie verschwinden.\n", "utf8");

    const res = await proposePersonaEvolution({ workspaceDir: dir, outcomes, llmCfg: { model: "x" }, callLlm: async () => "- Zweite Marotte.", now: T1 });
    assert.strictEqual(res.proposed, true);
    const content = readFileSync(path, "utf8");
    assert.ok(content.includes("## Meine eigene Notiz"));
    assert.ok(content.includes("Das darf nie verschwinden."));
    assert.ok(content.includes("Zweite Marotte"));
  });

  it("User-Notiz unterhalb einer bestehenden Vorschlagssektion übersteht acceptPersonaProposal", async () => {
    const dir = seededDir();
    const outcomes = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "confirmed_or_continued"));
    await proposePersonaEvolution({ workspaceDir: dir, outcomes, llmCfg: { model: "x" }, callLlm: async () => "- Marotte: zählt gern auf.", now: T1 });
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\n\n## Meine eigene Notiz\n\nDas darf nie verschwinden.\n", "utf8");

    const res = acceptPersonaProposal(dir);
    assert.strictEqual(res.accepted, true);
    const content = readFileSync(path, "utf8");
    assert.ok(content.includes("## Meine eigene Notiz"));
    assert.ok(content.includes("Das darf nie verschwinden."));
    assert.ok(!content.includes("## Vorschlag (nicht aktiv)"));
    assert.ok(loadPersonaDirective(dir).includes("zählt gern auf"));
  });
});
