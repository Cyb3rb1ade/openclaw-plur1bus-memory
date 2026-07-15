import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasPersonaVoice, generatePersonaSeed, writePersonaVoice,
  loadPersonaDirective, readPersonaFile, appendMarkerToManagedBlock,
  evolvePersonaVoice, proposePersonaEvolution, acceptPersonaProposal,
  loadPersonaEmojiPalette, ensurePersonaVoiceSeed,
  scheduleEnsurePersonaVoiceSeed, PROPOSAL_HEADER,
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

  it("loadPersonaEmojiPalette liest nur den Managed-Block", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, "- Emoji-Palette: 🌊 🧭 ✨, selten\n- Lieblingswendung: „passt schon“.");
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\nUser-Notiz: 😀 😈", "utf8");
    assert.strictEqual(loadPersonaEmojiPalette(dir), "🌊 🧭 ✨");
  });

  it("loadPersonaEmojiPalette behandelt Frequenz-Notizen nicht als Palette", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, "- Emojis sparsam: 🙂 gelegentlich.\n- Lieblingswendung: „passt schon“.");
    assert.strictEqual(loadPersonaEmojiPalette(dir), null);
  });

  it("loadPersonaEmojiPalette: null ohne offensichtliche Emoji-Palette", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, "- Lieblingswendung: „passt schon“.\n- Satzlängen-Neigung: kurz.");
    assert.strictEqual(loadPersonaEmojiPalette(dir), null);
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

  it("loadPersonaEmojiPalette: ZWJ-Komposit-Emoji zählt als EIN Match, kein Split", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, "- Emoji-Palette: 🏳️‍🌈 🌊, ab und zu\n- Lieblingswendung: „passt schon“.");
    const palette = loadPersonaEmojiPalette(dir);
    assert.strictEqual(palette, "🏳️‍🌈 🌊");
  });

  it("loadPersonaEmojiPalette: ein einzelnes ZWJ-Familien-Emoji besteht die ≥2-Heuristik nicht", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, "- Emoji-Palette: 👨‍👩‍👧, selten\n- Lieblingswendung: „passt schon“.");
    assert.strictEqual(loadPersonaEmojiPalette(dir), null);
  });
});

describe("scheduleEnsurePersonaVoiceSeed (hot-path throttle)", () => {
  it("blockiert den Aufrufer nie, auch wenn callLlm hängt", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    const callLlm = () => new Promise(() => {}); // hängt für immer
    let returned = false;
    scheduleEnsurePersonaVoiceSeed(
      { workspaceDir: dir, agentId: "anna", llmCfg: { model: "x" }, callLlm },
      { attempts: new Map(), inFlight: new Set() },
    );
    returned = true;
    assert.strictEqual(returned, true);
  });

  it("in-flight guard: gleichzeitige Aufrufe feuern callLlm nur einmal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    let calls = 0;
    let resolveLlm;
    const callLlm = () => new Promise((resolve) => { calls += 1; resolveLlm = resolve; });
    const attempts = new Map();
    const inFlight = new Set();
    const p1 = scheduleEnsurePersonaVoiceSeed(
      { workspaceDir: dir, agentId: "anna", llmCfg: { model: "x" }, callLlm },
      { attempts, inFlight },
    );
    const p2 = scheduleEnsurePersonaVoiceSeed(
      { workspaceDir: dir, agentId: "anna", llmCfg: { model: "x" }, callLlm },
      { attempts, inFlight },
    );
    assert.strictEqual(calls, 1);
    resolveLlm(SEED);
    await p1;
    await p2;
  });

  it("6h Backoff nach fehlgeschlagenem Versuch: kein erneuter callLlm-Aufruf im Fenster", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    let calls = 0;
    const callLlm = async () => { calls += 1; return null; }; // generatePersonaSeed liefert null → Fehlschlag
    const attempts = new Map();
    const inFlight = new Set();
    let now = 1_000_000;
    await scheduleEnsurePersonaVoiceSeed(
      { workspaceDir: dir, agentId: "anna", llmCfg: { model: "x" }, callLlm },
      { attempts, inFlight, now },
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual(hasPersonaVoice(dir), false);

    // Innerhalb des 6h-Fensters: kein erneuter Aufruf
    now += 60 * 60 * 1000; // +1h
    await scheduleEnsurePersonaVoiceSeed(
      { workspaceDir: dir, agentId: "anna", llmCfg: { model: "x" }, callLlm },
      { attempts, inFlight, now },
    );
    assert.strictEqual(calls, 1);

    // Nach 6h: erneuter Versuch erlaubt
    now += 6 * 60 * 60 * 1000 + 1;
    await scheduleEnsurePersonaVoiceSeed(
      { workspaceDir: dir, agentId: "anna", llmCfg: { model: "x" }, callLlm },
      { attempts, inFlight, now },
    );
    assert.strictEqual(calls, 2);
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

  it("ensurePersonaVoiceSeed erzeugt beim Erststart ein Persona-Profil", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writeFileSync(join(dir, "IDENTITY.md"), "identity fallback", "utf8");
    writeFileSync(join(dir, "SOUL.md"), "soul first", "utf8");
    let seenMessages = null;
    const callLlm = async (messages) => {
      seenMessages = messages;
      return "- Emoji-Palette: 🌊 🧭 ✨, selten\n- Lieblingswendung: „passt schon“.\n- Satzlängen-Neigung: kurz.";
    };

    assert.strictEqual(await ensurePersonaVoiceSeed({
      workspaceDir: dir,
      agentId: "anna",
      lang: "de",
      llmCfg: { model: "x" },
      callLlm,
    }), true);
    assert.ok(hasPersonaVoice(dir));
    assert.match(seenMessages[1].content, /soul first/);
    assert.doesNotMatch(seenMessages[1].content, /identity fallback/);
  });

  it("ensurePersonaVoiceSeed bleibt ohne LLM inert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writeFileSync(join(dir, "SOUL.md"), "soul first", "utf8");
    assert.strictEqual(await ensurePersonaVoiceSeed({ workspaceDir: dir, agentId: "anna" }), false);
    assert.strictEqual(hasPersonaVoice(dir), false);
  });

  it("ensurePersonaVoiceSeed überschreibt kein bestehendes Persona-Profil", async () => {
    const dir = seededDir();
    const before = readFileSync(join(dir, "persona-voice.md"), "utf8");
    const callLlm = async () => "- Emoji-Palette: 🐢";

    assert.strictEqual(await ensurePersonaVoiceSeed({
      workspaceDir: dir,
      agentId: "anna",
      llmCfg: { model: "x" },
      callLlm,
    }), false);
    assert.strictEqual(readFileSync(join(dir, "persona-voice.md"), "utf8"), before);
  });

  it("wendet bei positivem Trend den Marker DIREKT an — keine Proposal-Sektion", async () => {
    const dir = seededDir();
    const outcomes = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "confirmed_or_continued"));
    const callLlm = async () => "- Neue Wendung: „alles klar soweit\".";
    const res = await evolvePersonaVoice({ workspaceDir: dir, outcomes, llmCfg: { model: "x" }, callLlm, now: T1 });
    assert.strictEqual(res.evolved, true);
    assert.ok(res.marker.includes("alles klar soweit"));
    const content = readFileSync(join(dir, "persona-voice.md"), "utf8");
    assert.ok(!content.includes(PROPOSAL_HEADER));
    assert.ok(content.includes("alles klar soweit"));
    // Marker steht im Managed Block, nicht nur irgendwo in der Datei.
    assert.ok(readPersonaFile(dir).managedBlock.includes("alles klar soweit"));
    // Direktive greift den neuen Marker sofort, ohne accept.
    assert.ok(loadPersonaDirective(dir).includes("alles klar soweit"));
  });

  it("kein evolve bei zu wenigen oder negativen Outcomes", async () => {
    const dir = seededDir();
    const few = [outcome(T1, "confirmed_or_continued")];
    assert.strictEqual((await evolvePersonaVoice({ workspaceDir: dir, outcomes: few, llmCfg: { model: "x" }, callLlm: async () => "- x", now: T1 })).evolved, false);
    const negative = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "ignored_or_topic_shifted"));
    assert.strictEqual((await evolvePersonaVoice({ workspaceDir: dir, outcomes: negative, llmCfg: { model: "x" }, callLlm: async () => "- x", now: T1 })).evolved, false);
  });

  it("proposePersonaEvolution bleibt als Alias erhalten (Rückwärtskompatibilität)", () => {
    assert.strictEqual(proposePersonaEvolution, evolvePersonaVoice);
  });

  it("Auto-Apply lässt eine bestehende alte Proposal-Sektion unangetastet stehen", async () => {
    const dir = seededDir();
    const outcomes = Array.from({ length: 12 }, (_, i) => outcome(T1 - i * 1000, "confirmed_or_continued"));
    // Simuliert eine Alt-Installation mit noch offener Proposal-Sektion.
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + `\n\n${PROPOSAL_HEADER}\n\nÜbernehmen mit /plur1bus persona accept — oder diese Sektion einfach löschen.\n\n- Alte Marotte.\n`, "utf8");

    const res = await evolvePersonaVoice({ workspaceDir: dir, outcomes, llmCfg: { model: "x" }, callLlm: async () => "- Neue Marotte.", now: T1 });
    assert.strictEqual(res.evolved, true);
    const content = readFileSync(path, "utf8");
    assert.ok(content.includes(PROPOSAL_HEADER));
    assert.ok(content.includes("Alte Marotte"));
    assert.ok(readPersonaFile(dir).managedBlock.includes("Neue Marotte"));
  });

  it("accept übernimmt weiterhin eine bestehende Alt-Proposal-Sektion", async () => {
    const dir = seededDir();
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + `\n\n${PROPOSAL_HEADER}\n\nÜbernehmen mit /plur1bus persona accept — oder diese Sektion einfach löschen.\n\n- Marotte: zählt gern auf.\n`, "utf8");

    assert.ok(!loadPersonaDirective(dir).includes("zählt gern auf"));
    const res = acceptPersonaProposal(dir);
    assert.strictEqual(res.accepted, true);
    assert.ok(loadPersonaDirective(dir).includes("zählt gern auf"));
    assert.ok(!readFileSync(path, "utf8").includes(PROPOSAL_HEADER));
  });

  it("accept ohne Vorschlag → accepted false", () => {
    const dir = seededDir();
    assert.strictEqual(acceptPersonaProposal(dir).accepted, false);
  });

  it("User-Notiz unterhalb einer bestehenden Vorschlagssektion übersteht acceptPersonaProposal", async () => {
    const dir = seededDir();
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + `\n\n${PROPOSAL_HEADER}\n\nÜbernehmen mit /plur1bus persona accept — oder diese Sektion einfach löschen.\n\n- Marotte: zählt gern auf.\n\n## Meine eigene Notiz\n\nDas darf nie verschwinden.\n`, "utf8");

    const res = acceptPersonaProposal(dir);
    assert.strictEqual(res.accepted, true);
    const content = readFileSync(path, "utf8");
    assert.ok(content.includes("## Meine eigene Notiz"));
    assert.ok(content.includes("Das darf nie verschwinden."));
    assert.ok(!content.includes(PROPOSAL_HEADER));
    assert.ok(loadPersonaDirective(dir).includes("zählt gern auf"));
  });
});

describe("appendMarkerToManagedBlock: 12er-Kappung", () => {
  function seededDir() {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, SEED); // 3 Seed-Bullets
    return dir;
  }

  it("(a) unter der Kappe wird nur angehängt", () => {
    const dir = seededDir();
    for (let i = 1; i <= 5; i++) {
      assert.strictEqual(appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`), true);
    }
    const { managedBlock } = readPersonaFile(dir);
    const bullets = managedBlock.split("\n").filter((l) => l.trim().startsWith("- "));
    assert.strictEqual(bullets.length, 8); // 3 Seed + 5 gelernt
    for (let i = 1; i <= 5; i++) assert.ok(managedBlock.includes(`Gelernt ${i}.`));
  });

  it("(b) an der Kappe verschwindet Bullet-Zeile 4 (älteste gelernte), Seed 1-3 und neueste bleiben", () => {
    const dir = seededDir();
    // 3 Seed-Bullets + 9 gelernte = 12 (an der Kappe)
    for (let i = 1; i <= 9; i++) {
      assert.strictEqual(appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`), true);
    }
    let bullets = readPersonaFile(dir).managedBlock.split("\n").filter((l) => l.trim().startsWith("- "));
    assert.strictEqual(bullets.length, 12);
    assert.ok(bullets[3].includes("Gelernt 1."));

    // 13. Bullet (10. gelernte) überschreitet die Kappe → Gelernt 1 (Bullet-Zeile 4) fliegt raus.
    assert.strictEqual(appendMarkerToManagedBlock(dir, "- Gelernt 10."), true);
    const { managedBlock } = readPersonaFile(dir);
    bullets = managedBlock.split("\n").filter((l) => l.trim().startsWith("- "));
    assert.strictEqual(bullets.length, 12);
    // Seed-Zeilen 1-3 bleiben erhalten.
    assert.ok(bullets[0].includes("Kurze, direkte Sätze."));
    assert.ok(bullets[1].includes("passt schon"));
    assert.ok(bullets[2].includes("Emojis sparsam"));
    // Älteste gelernte Zeile (Gelernt 1.) ist weg.
    assert.ok(!managedBlock.includes("Gelernt 1."));
    // Gelernt 2..10 bleiben, inkl. der neuesten.
    for (let i = 2; i <= 10; i++) assert.ok(managedBlock.includes(`Gelernt ${i}.`));
  });

  it("(d) 6-Bullet-Seed via writePersonaVoice: ALLE 6 Seed-Zeilen überleben die Kappung", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    const seed6 = [
      "- Seed A.", "- Seed B.", "- Seed C.", "- Seed D.", "- Seed E.", "- Seed F.",
    ].join("\n");
    writePersonaVoice(dir, seed6);
    // 6 Seed + 7 gelernte = 13 → über der Kappe: Gelernt 1 fliegt, Seed bleibt komplett.
    for (let i = 1; i <= 7; i++) {
      assert.strictEqual(appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`), true);
    }
    const { managedBlock } = readPersonaFile(dir);
    const bullets = managedBlock.split("\n").filter((l) => l.trim().startsWith("- "));
    assert.strictEqual(bullets.length, 12);
    for (const s of ["Seed A.", "Seed B.", "Seed C.", "Seed D.", "Seed E.", "Seed F."]) {
      assert.ok(managedBlock.includes(s), `Seed-Zeile fehlt: ${s}`);
    }
    assert.ok(!managedBlock.includes("Gelernt 1."));
    for (let i = 2; i <= 7; i++) assert.ok(managedBlock.includes(`Gelernt ${i}.`));
  });

  it("(e) Legacy-Block OHNE seed-end-Boundary: Fallback schützt die ersten 3 Bullets", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    // Legacy-Datei manuell ohne Boundary schreiben (wie vor dieser Änderung).
    const legacy = [
      "# Persona-Voice", "",
      "<!-- persona:begin -->",
      SEED, // 3 Seed-Bullets, keine Boundary
      "<!-- persona:end -->", "",
    ].join("\n");
    writeFileSync(join(dir, "persona-voice.md"), legacy, "utf8");
    for (let i = 1; i <= 10; i++) {
      assert.strictEqual(appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`), true);
    }
    const { managedBlock } = readPersonaFile(dir);
    const bullets = managedBlock.split("\n").filter((l) => l.trim().startsWith("- "));
    assert.strictEqual(bullets.length, 12);
    assert.ok(bullets[0].includes("Kurze, direkte Sätze."));
    assert.ok(bullets[1].includes("passt schon"));
    assert.ok(bullets[2].includes("Emojis sparsam"));
    assert.ok(!managedBlock.includes("Gelernt 1."));
    assert.ok(managedBlock.includes("Gelernt 10."));
  });

  it("(f) seed-end-Boundary leakt weder in Direktive noch Palette", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    writePersonaVoice(dir, "- Emoji-Palette: 🌊 🧭 ✨, selten\n- Lieblingswendung: „passt schon“.\n- Satzlängen-Neigung: kurz.");
    const raw = readFileSync(join(dir, "persona-voice.md"), "utf8");
    assert.ok(raw.includes("persona:seed-end"), "writePersonaVoice muss die Boundary schreiben");
    const directive = loadPersonaDirective(dir);
    assert.ok(directive.includes("passt schon"));
    assert.ok(!directive.includes("seed-end"));
    assert.ok(!directive.includes("<!--"));
    assert.strictEqual(loadPersonaEmojiPalette(dir), "🌊 🧭 ✨");
  });

  it("(g) Dedup: identische Bullet-Zeile wird nicht doppelt angehängt, Rückgabe true", () => {
    const dir = seededDir();
    assert.strictEqual(appendMarkerToManagedBlock(dir, "- Neue Marotte."), true);
    assert.strictEqual(appendMarkerToManagedBlock(dir, "- Neue Marotte."), true);
    // Auch getrimmt identisch (Whitespace-Variante) wird dedupliziert.
    assert.strictEqual(appendMarkerToManagedBlock(dir, "  - Neue Marotte.  "), true);
    const { managedBlock } = readPersonaFile(dir);
    const hits = managedBlock.split("\n").filter((l) => l.trim() === "- Neue Marotte.");
    assert.strictEqual(hits.length, 1);
  });

  it("(c) Nicht-Bullet-Inhalt im Managed Block bleibt unangetastet", () => {
    const dir = seededDir();
    const path = join(dir, "persona-voice.md");
    // Nicht-Bullet-Zeile innerhalb des Managed Blocks einfügen (z.B. Kommentarzeile).
    const content = readFileSync(path, "utf8");
    const withNote = content.replace(SEED, `${SEED}\nHinweis: Diese Zeile ist kein Bullet.`);
    writeFileSync(path, withNote, "utf8");

    for (let i = 1; i <= 10; i++) {
      appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`);
    }
    const { managedBlock } = readPersonaFile(dir);
    assert.ok(managedBlock.includes("Hinweis: Diese Zeile ist kein Bullet."));
    const bullets = managedBlock.split("\n").filter((l) => l.trim().startsWith("- "));
    assert.strictEqual(bullets.length, 12);
  });
});
