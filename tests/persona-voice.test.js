import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasPersonaVoice, generatePersonaSeed, writePersonaVoice,
  loadPersonaDirective, readPersonaFile, appendMarkerToManagedBlock,
  evolvePersonaVoice, proposePersonaEvolution, acceptPersonaProposal,
  loadPersonaEmojiPalette, ensurePersonaVoiceSeed,
  scheduleEnsurePersonaVoiceSeed, PROPOSAL_HEADER,
  replaceLearnedMarkerInManagedBlock, splitManagedBullets, parseEvolutionReply,
  isHeartbeatOutcome, readPersonaEvolutionState, selectEvolutionEvidence,
  directiveCharsForBullets, resolvePersonaMaxBullets,
  DEFAULT_PERSONA_MAX_BULLETS, DEFAULT_MAX_DIRECTIVE_CHARS, PERSONA_EVOLUTION_STATE_FILE,
} from "../lib/persona-voice.js";
import { makeTempDir } from "./helpers/temp-dir.js";

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
    const dir = makeTempDir("pv-");
    assert.strictEqual(hasPersonaVoice(dir), false);
    assert.strictEqual(writePersonaVoice(dir, SEED), true);
    assert.strictEqual(hasPersonaVoice(dir), true);
    const content = readFileSync(join(dir, "persona-voice.md"), "utf8");
    assert.ok(content.includes("<!-- persona:begin -->"));
    assert.ok(content.includes("passt schon"));
    assert.strictEqual(writePersonaVoice(dir, "- anders"), false); // existiert schon → no-op
  });

  it("loadPersonaDirective: kompakt, ≤ Default-Deckel, nur Managed-Block", () => {
    const dir = makeTempDir("pv-");
    writePersonaVoice(dir, SEED);
    // User-Text außerhalb der Marker darf nicht in die Direktive
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\n\nPrivate User-Notiz GEHEIM", "utf8");
    const directive = loadPersonaDirective(dir);
    assert.ok(directive.includes("passt schon"));
    assert.ok(!directive.includes("GEHEIM"));
    assert.ok(directive.length <= DEFAULT_MAX_DIRECTIVE_CHARS);
    assert.match(directive, /Grundstimme/);
  });

  it("loadPersonaDirective (7.12.38): 24 Zeilen passen ohne Kappung, Grenze konfigurierbar, Cache kennt die Grenze", () => {
    const dir = makeTempDir("pv-");
    const n = DEFAULT_PERSONA_MAX_BULLETS;
    const bullets = Array.from({ length: n }, (_, i) => `- Marker ${i + 1}: ${"x".repeat(110)} Ende${i + 1}.`);
    writePersonaVoice(dir, bullets.join("\n"));
    const full = loadPersonaDirective(dir);
    assert.ok(full.includes(`Ende${n}`), "the last bullet survives the default cap");
    assert.ok(full.length <= DEFAULT_MAX_DIRECTIVE_CHARS);
    assert.strictEqual(DEFAULT_MAX_DIRECTIVE_CHARS, directiveCharsForBullets(n));
    assert.strictEqual(directiveCharsForBullets(12), 12 * 130 + 80);
    assert.strictEqual(resolvePersonaMaxBullets("abc"), n);
    assert.strictEqual(resolvePersonaMaxBullets(3), n, "below the minimum falls back");
    assert.strictEqual(resolvePersonaMaxBullets(30.7), 30);
    const small = loadPersonaDirective(dir, { maxChars: 400 });
    assert.ok(small.length <= 400 && small.endsWith("…"), "an explicit smaller cap truncates");
    assert.ok(!small.includes(`Ende${n}`));
    const again = loadPersonaDirective(dir);
    assert.ok(again.includes(`Ende${n}`), "the cache does not serve the truncated text for the default cap");
    const tiny = loadPersonaDirective(dir, { maxChars: 50 });
    assert.ok(tiny.length <= DEFAULT_MAX_DIRECTIVE_CHARS && tiny.includes(`Ende${n}`), "caps below the minimum fall back to the default");
  });

  it("loadPersonaDirective: null ohne Datei, fail-open bei kaputtem Inhalt", () => {
    const dir = makeTempDir("pv-");
    assert.strictEqual(loadPersonaDirective(dir), null);
    writeFileSync(join(dir, "persona-voice.md"), "kein marker", "utf8");
    assert.strictEqual(loadPersonaDirective(dir), null);
  });

  it("loadPersonaEmojiPalette liest nur den Managed-Block", () => {
    const dir = makeTempDir("pv-");
    writePersonaVoice(dir, "- Emoji-Palette: 🌊 🧭 ✨, selten\n- Lieblingswendung: „passt schon“.");
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\nUser-Notiz: 😀 😈", "utf8");
    assert.strictEqual(loadPersonaEmojiPalette(dir), "🌊 🧭 ✨");
  });

  it("loadPersonaEmojiPalette behandelt Frequenz-Notizen nicht als Palette", () => {
    const dir = makeTempDir("pv-");
    writePersonaVoice(dir, "- Emojis sparsam: 🙂 gelegentlich.\n- Lieblingswendung: „passt schon“.");
    assert.strictEqual(loadPersonaEmojiPalette(dir), null);
  });

  it("loadPersonaEmojiPalette: null ohne offensichtliche Emoji-Palette", () => {
    const dir = makeTempDir("pv-");
    writePersonaVoice(dir, "- Lieblingswendung: „passt schon“.\n- Satzlängen-Neigung: kurz.");
    assert.strictEqual(loadPersonaEmojiPalette(dir), null);
  });

  it("appendMarkerToManagedBlock hängt im Block an, User-Text bleibt", () => {
    const dir = makeTempDir("pv-");
    writePersonaVoice(dir, SEED);
    const path = join(dir, "persona-voice.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\nUser-Notiz", "utf8");
    assert.strictEqual(appendMarkerToManagedBlock(dir, "- Neue Marotte."), true);
    const { managedBlock, content } = readPersonaFile(dir);
    assert.ok(managedBlock.includes("Neue Marotte"));
    assert.ok(content.includes("User-Notiz"));
  });

  it("loadPersonaEmojiPalette: ZWJ-Komposit-Emoji zählt als EIN Match, kein Split", () => {
    const dir = makeTempDir("pv-");
    writePersonaVoice(dir, "- Emoji-Palette: 🏳️‍🌈 🌊, ab und zu\n- Lieblingswendung: „passt schon“.");
    const palette = loadPersonaEmojiPalette(dir);
    assert.strictEqual(palette, "🏳️‍🌈 🌊");
  });

  it("loadPersonaEmojiPalette: ein einzelnes ZWJ-Familien-Emoji besteht die ≥2-Heuristik nicht", () => {
    const dir = makeTempDir("pv-");
    writePersonaVoice(dir, "- Emoji-Palette: 👨‍👩‍👧, selten\n- Lieblingswendung: „passt schon“.");
    assert.strictEqual(loadPersonaEmojiPalette(dir), null);
  });
});

describe("scheduleEnsurePersonaVoiceSeed (hot-path throttle)", () => {
  it("blockiert den Aufrufer nie, auch wenn callLlm hängt", () => {
    const dir = makeTempDir("pv-");
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
    const dir = makeTempDir("pv-");
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
    const dir = makeTempDir("pv-");
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
    const dir = makeTempDir("pv-");
    writePersonaVoice(dir, SEED);
    return dir;
  }

  it("ensurePersonaVoiceSeed erzeugt beim Erststart ein Persona-Profil", async () => {
    const dir = makeTempDir("pv-");
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
    const dir = makeTempDir("pv-");
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

describe("appendMarkerToManagedBlock: Kappung (explizit 12; Default seit 7.12.38: 24)", () => {
  function seededDir() {
    const dir = makeTempDir("pv-");
    writePersonaVoice(dir, SEED); // 3 Seed-Bullets
    return dir;
  }

  it("(a) unter der Kappe wird nur angehängt", () => {
    const dir = seededDir();
    for (let i = 1; i <= 5; i++) {
      assert.strictEqual(appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`, { maxBullets: 12 }), true);
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
      assert.strictEqual(appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`, { maxBullets: 12 }), true);
    }
    let bullets = readPersonaFile(dir).managedBlock.split("\n").filter((l) => l.trim().startsWith("- "));
    assert.strictEqual(bullets.length, 12);
    assert.ok(bullets[3].includes("Gelernt 1."));

    // 13. Bullet (10. gelernte) überschreitet die Kappe → Gelernt 1 (Bullet-Zeile 4) fliegt raus.
    assert.strictEqual(appendMarkerToManagedBlock(dir, "- Gelernt 10.", { maxBullets: 12 }), true);
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
    const dir = makeTempDir("pv-");
    const seed6 = [
      "- Seed A.", "- Seed B.", "- Seed C.", "- Seed D.", "- Seed E.", "- Seed F.",
    ].join("\n");
    writePersonaVoice(dir, seed6);
    // 6 Seed + 7 gelernte = 13 → über der Kappe: Gelernt 1 fliegt, Seed bleibt komplett.
    for (let i = 1; i <= 7; i++) {
      assert.strictEqual(appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`, { maxBullets: 12 }), true);
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
    const dir = makeTempDir("pv-");
    // Legacy-Datei manuell ohne Boundary schreiben (wie vor dieser Änderung).
    const legacy = [
      "# Persona-Voice", "",
      "<!-- persona:begin -->",
      SEED, // 3 Seed-Bullets, keine Boundary
      "<!-- persona:end -->", "",
    ].join("\n");
    writeFileSync(join(dir, "persona-voice.md"), legacy, "utf8");
    for (let i = 1; i <= 10; i++) {
      assert.strictEqual(appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`, { maxBullets: 12 }), true);
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
    const dir = makeTempDir("pv-");
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
      appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`, { maxBullets: 12 });
    }
    const { managedBlock } = readPersonaFile(dir);
    assert.ok(managedBlock.includes("Hinweis: Diese Zeile ist kein Bullet."));
    const bullets = managedBlock.split("\n").filter((l) => l.trim().startsWith("- "));
    assert.strictEqual(bullets.length, 12);
  });

  it("(f) Default-Kappe 24: 3 Seed + 21 gelernte passen, die 22. gelernte verdrängt die älteste", () => {
    const dir = seededDir();
    for (let i = 1; i <= 21; i++) assert.strictEqual(appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`), true);
    let bullets = readPersonaFile(dir).managedBlock.split("\n").filter((l) => l.trim().startsWith("- "));
    assert.strictEqual(bullets.length, DEFAULT_PERSONA_MAX_BULLETS);
    assert.ok(readPersonaFile(dir).managedBlock.includes("Gelernt 1."));
    assert.strictEqual(appendMarkerToManagedBlock(dir, "- Gelernt 22."), true);
    const { managedBlock } = readPersonaFile(dir);
    bullets = managedBlock.split("\n").filter((l) => l.trim().startsWith("- "));
    assert.strictEqual(bullets.length, DEFAULT_PERSONA_MAX_BULLETS);
    assert.ok(!managedBlock.includes("Gelernt 1."));
    assert.ok(managedBlock.includes("Gelernt 22."));
    assert.ok(bullets[0].includes("Kurze, direkte Sätze."));
    const split = splitManagedBullets(managedBlock);
    assert.strictEqual(split.seed.length, 3);
    assert.strictEqual(split.learned.length, 21);
    assert.ok(split.learned[0].includes("Gelernt 2."));
  });

  it("(g) replaceLearnedMarkerInManagedBlock ersetzt nur gelernte Zeilen, nie den Seed", () => {
    const dir = seededDir();
    for (let i = 1; i <= 3; i++) assert.strictEqual(appendMarkerToManagedBlock(dir, `- Gelernt ${i}.`), true);
    assert.strictEqual(replaceLearnedMarkerInManagedBlock(dir, 2, "- Ersetzt 2."), true);
    let { managedBlock } = readPersonaFile(dir);
    let split = splitManagedBullets(managedBlock);
    assert.deepStrictEqual(split.learned, ["- Gelernt 1.", "- Ersetzt 2.", "- Gelernt 3."]);
    assert.deepStrictEqual(split.seed, SEED.split("\n"));
    assert.ok(managedBlock.includes("<!-- persona:seed-end -->"), "boundary survives");
    // Ausserhalb des gelernten Bereichs: nichts passiert.
    assert.strictEqual(replaceLearnedMarkerInManagedBlock(dir, 0, "- Nope."), false);
    assert.strictEqual(replaceLearnedMarkerInManagedBlock(dir, 4, "- Nope."), false);
    assert.strictEqual(replaceLearnedMarkerInManagedBlock(dir, 1, "kein Bullet"), false);
    // Duplikat einer bestehenden Zeile wird nicht eingesetzt.
    assert.strictEqual(replaceLearnedMarkerInManagedBlock(dir, 1, "- Gelernt 3."), false);
    ({ managedBlock } = readPersonaFile(dir));
    split = splitManagedBullets(managedBlock);
    assert.deepStrictEqual(split.learned, ["- Gelernt 1.", "- Ersetzt 2.", "- Gelernt 3."]);
    assert.ok(!managedBlock.includes("Nope."));
    assert.ok(loadPersonaDirective(dir).includes("Ersetzt 2"));
  });
});

describe("evolvePersonaVoice (7.12.38): Belege, ADD/REPLACE/NONE, Bremsen, Heartbeat-Filter", () => {
  function seededDir() {
    const dir = makeTempDir("pv-");
    writePersonaVoice(dir, SEED);
    return dir;
  }
  function rich(ts, kind, i) {
    return {
      timestamp: ts,
      outcome: kind,
      sessionKey: "agent:main:telegram:default:direct:1",
      userPrompt: `Frage ${i}`,
      assistantText: `Antwort ${i} des Agenten`,
      replyText: `Reaktion ${i}`,
    };
  }
  const positives = (n, offset = 0) => Array.from({ length: n }, (_, i) => rich(T1 - (i + offset) * 1000, "confirmed_or_continued", i + offset));

  it("isHeartbeatOutcome erkennt Heartbeat-Turns über sessionKey und Prompt", () => {
    assert.strictEqual(isHeartbeatOutcome({ sessionKey: "agent:main:main:heartbeat" }), true);
    assert.strictEqual(isHeartbeatOutcome({ userPrompt: "Read HEARTBEAT.md if it exists. If nothing…" }), true);
    assert.strictEqual(isHeartbeatOutcome({ sessionKey: "agent:main:telegram:default:direct:1", userPrompt: "Hallo" }), false);
    assert.strictEqual(isHeartbeatOutcome({}), false);
  });

  it("parseEvolutionReply versteht ADD, REPLACE n, NONE und nackte Bullet-Zeilen", () => {
    assert.deepStrictEqual(parseEvolutionReply("ADD: - Neue Wendung."), { action: "add", marker: "- Neue Wendung." });
    assert.deepStrictEqual(parseEvolutionReply("replace 3: - Ersatz."), { action: "replace", index: 3, marker: "- Ersatz." });
    assert.deepStrictEqual(parseEvolutionReply("Hier mein Vorschlag:\nNONE"), { action: "none" });
    assert.deepStrictEqual(parseEvolutionReply("- Alt-Format."), { action: "add", marker: "- Alt-Format." });
    assert.strictEqual(parseEvolutionReply("nichts brauchbares"), null);
    assert.strictEqual(parseEvolutionReply(null), null);
  });

  it("Heartbeat-Outcomes öffnen das Tor nicht und tauchen nicht als Beleg auf", async () => {
    const dir = seededDir();
    const heartbeats = Array.from({ length: 12 }, (_, i) => ({
      timestamp: T1 - i * 1000, outcome: "continued_topic", sessionKey: "agent:main:main:heartbeat",
      userPrompt: "Read HEARTBEAT.md if it exists.", replyText: "Read HEARTBEAT.md if it exists.",
    }));
    let calls = 0;
    const res = await evolvePersonaVoice({ workspaceDir: dir, outcomes: [...heartbeats, ...positives(3)], llmCfg: { model: "x" }, callLlm: async () => { calls++; return "- x"; }, now: T1 });
    assert.strictEqual(res.evolved, false);
    assert.strictEqual(res.reason, "too_few_outcomes");
    assert.strictEqual(res.outcomes, 3);
    assert.strictEqual(calls, 0);
  });

  it("das Modell sieht Seed, nummerierte gelernte Zeilen und Belege beider Seiten", async () => {
    const dir = seededDir();
    appendMarkerToManagedBlock(dir, "- Gelernt A.");
    const outcomes = [
      ...positives(9),
      { ...rich(T1 - 20000, "corrected", 99), assistantText: "Antwort mit Stolperstein", replyText: "Nein, das stimmt nicht" },
    ];
    let seen = null;
    const callLlm = async (messages) => { seen = messages; return "ADD: - Neue Wendung: „alles klar soweit\"."; };
    const res = await evolvePersonaVoice({ workspaceDir: dir, outcomes, llmCfg: { model: "x" }, callLlm, now: T1 });
    assert.strictEqual(res.evolved, true);
    assert.strictEqual(res.action, "add");
    assert.strictEqual(res.positive, 9);
    assert.strictEqual(res.negative, 1);
    const user = seen[1].content;
    assert.ok(user.includes("Geschuetzter Kern"));
    assert.ok(user.includes("passt schon"));
    assert.ok(user.includes("1. - Gelernt A."));
    assert.ok(user.includes("Positive Belege (9 von 10"));
    assert.ok(user.includes("Antwort 0 des Agenten"));
    assert.ok(user.includes("Negative Belege (1 von 10"));
    assert.ok(user.includes("Antwort mit Stolperstein"));
    assert.ok(user.includes("Nein, das stimmt nicht"));
    assert.match(seen[0].content, /REPLACE <n>/);
    assert.ok(readPersonaFile(dir).managedBlock.includes("alles klar soweit"));
    const state = readPersonaEvolutionState(dir);
    assert.strictEqual(state.lastEvolvedAt, T1);
    assert.strictEqual(state.lastAction, "add");
    assert.strictEqual(state.runs, 1);
    assert.ok(existsSync(join(dir, PERSONA_EVOLUTION_STATE_FILE)));
  });

  it("selectEvolutionEvidence bevorzugt Einträge mit Antworttext, neueste zuerst, je Seite gedeckelt", () => {
    const outcomes = [
      ...positives(8),
      { timestamp: T1 + 5000, outcome: "acknowledged", userPrompt: "ohne Antwort", assistantText: "" },
    ];
    const ev = selectEvolutionEvidence(outcomes);
    assert.strictEqual(ev.positive.length, 6);
    assert.strictEqual(ev.positive[0].userPrompt, "Frage 0", "the newest entry WITH an answer leads");
    assert.ok(!ev.positive.some((o) => o.userPrompt === "ohne Antwort"));
    assert.strictEqual(ev.negative.length, 0);
  });

  it("REPLACE ersetzt die gelernte Zeile, eine ungültige Nummer wird zu ADD", async () => {
    const dir = seededDir();
    appendMarkerToManagedBlock(dir, "- Gelernt A.");
    appendMarkerToManagedBlock(dir, "- Gelernt B.");
    let res = await evolvePersonaVoice({ workspaceDir: dir, outcomes: positives(12), llmCfg: { model: "x" }, callLlm: async () => "REPLACE 1: - Besser als A.", now: T1 });
    assert.strictEqual(res.evolved, true);
    assert.strictEqual(res.action, "replace");
    assert.strictEqual(res.replacedIndex, 1);
    assert.deepStrictEqual(splitManagedBullets(readPersonaFile(dir).managedBlock).learned, ["- Besser als A.", "- Gelernt B."]);
    assert.strictEqual(readPersonaEvolutionState(dir).lastAction, "replace:1");

    // Nummer zeigt in den Seed/ins Leere → ADD, Seed unangetastet. Bremse
    // umgehen: minDaysBetween 0 und neue Outcomes.
    res = await evolvePersonaVoice({ workspaceDir: dir, outcomes: positives(12, 0).map((o) => ({ ...o, timestamp: o.timestamp + 60000 })), llmCfg: { model: "x" }, callLlm: async () => "REPLACE 7: - Hinten dran.", now: T1 + 60000, minDaysBetween: 0 });
    assert.strictEqual(res.evolved, true);
    assert.strictEqual(res.action, "add");
    const split = splitManagedBullets(readPersonaFile(dir).managedBlock);
    assert.deepStrictEqual(split.seed, SEED.split("\n"));
    assert.deepStrictEqual(split.learned, ["- Besser als A.", "- Gelernt B.", "- Hinten dran."]);
  });

  it("ein bereits vorhandener Marker (ADD oder REPLACE) zählt nicht als Evolution und setzt keine Zeit-Bremse", async () => {
    const dir = seededDir();
    appendMarkerToManagedBlock(dir, "- Gelernt A.");
    const before = readFileSync(join(dir, "persona-voice.md"), "utf8");
    for (const reply of ["ADD: - Gelernt A.", "REPLACE 1: - Kurze, direkte Sätze."]) {
      const res = await evolvePersonaVoice({ workspaceDir: dir, outcomes: positives(12), llmCfg: { model: "x" }, callLlm: async () => reply, now: T1 });
      assert.strictEqual(res.evolved, false, reply);
      assert.strictEqual(res.reason, "duplicate_marker", reply);
      assert.strictEqual(readFileSync(join(dir, "persona-voice.md"), "utf8"), before);
      const state = readPersonaEvolutionState(dir);
      assert.strictEqual(state.lastEvolvedAt, null);
      assert.strictEqual(state.lastAction, "duplicate");
      // Zweiter Durchlauf mit denselben Outcomes: verbraucht → too_few, daher frische Zeitstempel für die Schleife.
      writeFileSync(join(dir, PERSONA_EVOLUTION_STATE_FILE), "{}", "utf8");
    }
  });

  it("NONE verbraucht die Belege, ändert nichts und setzt keine Zeit-Bremse", async () => {
    const dir = seededDir();
    const before = readFileSync(join(dir, "persona-voice.md"), "utf8");
    const res = await evolvePersonaVoice({ workspaceDir: dir, outcomes: positives(12), llmCfg: { model: "x" }, callLlm: async () => "NONE", now: T1 });
    assert.strictEqual(res.evolved, false);
    assert.strictEqual(res.reason, "llm_none");
    assert.strictEqual(readFileSync(join(dir, "persona-voice.md"), "utf8"), before);
    const state = readPersonaEvolutionState(dir);
    assert.strictEqual(state.lastEvolvedAt, null);
    assert.strictEqual(state.lastOutcomeTimestamp, T1);
    // Dieselben Outcomes noch einmal: verbraucht → too_few_outcomes, kein LLM-Aufruf.
    let calls = 0;
    const again = await evolvePersonaVoice({ workspaceDir: dir, outcomes: positives(12), llmCfg: { model: "x" }, callLlm: async () => { calls++; return "- x"; }, now: T1 + 1000 });
    assert.strictEqual(again.reason, "too_few_outcomes");
    assert.strictEqual(calls, 0);
  });

  it("Bremsen: minDaysBetween sperrt nach einer Änderung, danach zählen nur NEUE Outcomes", async () => {
    const dir = seededDir();
    const first = await evolvePersonaVoice({ workspaceDir: dir, outcomes: positives(12), llmCfg: { model: "x" }, callLlm: async () => "- Erste.", now: T1 });
    assert.strictEqual(first.evolved, true);
    const day = 86400000;
    const tooSoon = await evolvePersonaVoice({ workspaceDir: dir, outcomes: positives(12), llmCfg: { model: "x" }, callLlm: async () => "- Zweite.", now: T1 + day });
    assert.strictEqual(tooSoon.evolved, false);
    assert.strictEqual(tooSoon.reason, "too_soon");
    assert.strictEqual(tooSoon.nextEligibleAt, T1 + 2 * day);
    // Zeit-Bremse vorbei, aber dieselben (verbrauchten) Outcomes → too_few.
    const stale = await evolvePersonaVoice({ workspaceDir: dir, outcomes: positives(12), llmCfg: { model: "x" }, callLlm: async () => "- Zweite.", now: T1 + 2 * day });
    assert.strictEqual(stale.reason, "too_few_outcomes");
    // Neun neue reichen bei minOutcomes 10 nicht, zehn schon.
    const fresh = (n) => positives(n).map((o) => ({ ...o, timestamp: o.timestamp + 2 * day }));
    const nine = await evolvePersonaVoice({ workspaceDir: dir, outcomes: [...fresh(9), ...positives(12)], llmCfg: { model: "x" }, callLlm: async () => "- Zweite.", now: T1 + 2 * day });
    assert.strictEqual(nine.reason, "too_few_outcomes");
    assert.strictEqual(nine.outcomes, 9);
    const ten = await evolvePersonaVoice({ workspaceDir: dir, outcomes: [...fresh(10), ...positives(12)], llmCfg: { model: "x" }, callLlm: async () => "- Zweite.", now: T1 + 2 * day });
    assert.strictEqual(ten.evolved, true);
    assert.deepStrictEqual(splitManagedBullets(readPersonaFile(dir).managedBlock).learned, ["- Erste.", "- Zweite."]);
    // Eigene Schwelle: minOutcomes 3 lässt drei neue durch.
    const three = await evolvePersonaVoice({ workspaceDir: dir, outcomes: positives(3).map((o) => ({ ...o, timestamp: o.timestamp + 5 * day })), llmCfg: { model: "x" }, callLlm: async () => "- Dritte.", now: T1 + 5 * day, minOutcomes: 3 });
    assert.strictEqual(three.evolved, true);
  });
});
