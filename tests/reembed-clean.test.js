// 7.20.10: scripts/reembed-clean.mjs — Bestand bereinigt neu einbetten.
// Kleine LanceDB-Tabellen in einem Temp-Verzeichnis, Fake-Embedder, keine API.
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";

import { parseArgs, planCleanReembed, runCli } from "../scripts/reembed-clean.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";

const DIM = 4;
const IDS = {
  audio: "11111111-1111-4111-8111-111111111111",
  plain: "22222222-2222-4222-8222-222222222222",
  stub: "33333333-3333-4333-8333-333333333333",
  filler: "44444444-4444-4444-8444-444444444444",
  archived: "55555555-5555-4555-8555-555555555555",
};
const TEXTS = {
  audio: "[Audio transcript (machine-generated, untrusted)]: \"Christian: [räuspert sich] Das geheime Projekt heißt Nordlicht\"",
  plain: "Der Server läuft auf Node 22 (keine Beschränkung).",
  stub: "[User schickte audio: voice.ogg (audio/ogg)]",
  filler: "Ähm, ich wollte fragen, äh, ob das Backup um 3 Uhr läuft",
  archived: "[Tue 2026-11-24 09:43 GMT+1] Ähm, archivierte Zeile",
};

let root;
let counter = 0;

// Alles unter einem Wurzelverzeichnis des aufräumenden Helfers (löscht beim Prozessende).
function freshDir(name) {
  counter += 1;
  const dir = join(root, `${name}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function makeTable(base, agent, { withMode = true, extraRows = [] } = {}) {
  const db = await lancedb.connect(join(base, agent));
  const row = (key, status = "active") => ({
    id: IDS[key],
    text: TEXTS[key],
    vector: [0.1, 0.2, 0.3, 0.4],
    status,
    category: "fact",
    createdAt: 1_700_000_000_000n,
    importance: 0.5,
    ...(withMode ? { embeddingTextMode: "raw" } : {}),
  });
  const rows = [row("audio"), row("plain"), row("stub"), row("filler"), row("archived", "archived"), ...extraRows];
  return db.createTable("memories", rows);
}

async function readAll(base, agent) {
  const db = await lancedb.connect(join(base, agent));
  const t = await db.openTable("memories");
  const rows = await t.query().toArray();
  return new Map(rows.map((r) => [r.id, { ...r, vector: Array.from(r.vector) }]));
}

function fakeEmbedder({ failOnCall = 0, dims = DIM } = {}) {
  const calls = [];
  return {
    calls,
    create: async () => ({
      model: "fake",
      dimensions: dims,
      embedBatch: async (texts) => {
        calls.push([...texts]);
        if (failOnCall && calls.length === failOnCall) throw new Error("provider down");
        // Nahe am alten Vektor [0.1, 0.2, 0.3, 0.4] (Kosinus ~0,99), aber nicht gleich.
        return texts.map((t) => [0.1, 0.2, 0.3, 0.4 + t.length / 1000]);
      },
    }),
  };
}

function sink() {
  let out = "";
  return { write: (s) => { out += s; }, get text() { return out; } };
}

const stopped = () => ({ systemd: "inactive", processes: [], running: false });
const running = () => ({ systemd: "active", processes: [1], running: true });

before(() => {
  root = makeTempDir("plur1bus-reembed-clean-");
});

describe("parseArgs", () => {
  it("verlangt einen Agenten und lehnt widersprüchliche Modi ab", () => {
    assert.throws(() => parseArgs([]), /--agent/);
    assert.throws(() => parseArgs(["--agent", "main", "--dry-run", "--apply"]), /cannot be combined/);
    assert.throws(() => parseArgs(["--agent", "../x"]), /Invalid agent ID/);
    assert.throws(() => parseArgs(["--agent", "main", "--status", "deleted"]), /active or all/);
    assert.throws(() => parseArgs(["--agent", "main", "--embedding-api-key-env", "lower"]), /valid environment variable/);
    assert.throws(() => parseArgs(["--agent", "main", "--min-cosine", "1.5"]), /--min-cosine/);
    assert.throws(() => parseArgs(["--agent", "main", "--min-cosine", "abc"]), /--min-cosine/);
    assert.equal(parseArgs(["--agent", "main"]).minCosine, 0.2);
    assert.equal(parseArgs(["--agent", "main", "--min-cosine", "0"]).minCosine, 0);
    const opts = parseArgs(["--agent", "main", "--agent", "bernhardine", "--batch-size", "8", "--strip-speaker"]);
    assert.deepEqual(opts.agents, ["main", "bernhardine"]);
    assert.equal(opts.apply, false);
    assert.equal(opts.batchSize, 8);
    assert.equal(opts.stripSpeaker, true);
  });
});

describe("planCleanReembed", () => {
  it("trennt neu einbetten, nur Modus, nur Hülle und ungültige IDs", () => {
    const plan = planCleanReembed([
      { id: IDS.audio, text: TEXTS.audio },
      { id: IDS.plain, text: TEXTS.plain },
      { id: IDS.stub, text: TEXTS.stub },
      { id: "kein-uuid", text: "egal" },
      { id: "mem-1716123456789", text: "Ähm, alte Kennung" },
      { id: "0123456789abcdef0123456789abcdef", text: "Ähm, Hex-Kennung eines alten Imports" },
    ], { stripSpeaker: false });
    assert.deepEqual(plan.reembed.map((r) => r.id), [IDS.audio, "0123456789abcdef0123456789abcdef"]);
    assert.deepEqual(plan.modeOnly, [IDS.plain]);
    assert.deepEqual(plan.envelopeOnly, [IDS.stub]);
    assert.equal(plan.invalidId, 2, "nur UUIDs und Hex-IDs alter Importe");
    assert.equal(plan.reembed[0].cleaned, "Christian: Das geheime Projekt heißt Nordlicht");
  });

  it("Talk-Mode-Zeilen werden neu eingebettet, nicht nur umgestellt (Befund TALK-EMB)", () => {
    const talk = "Talk Mode active. Reply in a concise, spoken tone.\n\nNormal";
    const plan = planCleanReembed([{ id: IDS.plain, text: talk }], { stripSpeaker: false });
    assert.deepEqual(plan.reembed.map((r) => [r.id, r.cleaned]), [[IDS.plain, "Normal"]]);
    assert.deepEqual(plan.modeOnly, []);
    assert.equal(plan.rules.talkMode, 1);
    assert.match(JSON.stringify(plan.examples), /Talk Mode active/, "fester Host-Text, darf im Bericht stehen");
  });

  it("Beispiele zeigen nur Hüllen, keinen privaten Inhalt", () => {
    const plan = planCleanReembed([
      { id: IDS.audio, text: TEXTS.audio },
      { id: IDS.filler, text: "<think>Das geheime Projekt Nordlicht</think> Ähm, Antwort folgt" },
    ], { stripSpeaker: true });
    const json = JSON.stringify(plan.examples);
    assert.doesNotMatch(json, /Nordlicht|geheime|Christian/);
    assert.match(json, /<thinkBlock: \d+ chars>/);
    assert.match(json, /audioEnvelope/);
    assert.match(json, /räuspert sich/);
  });
});

describe("runCli --dry-run", () => {
  it("zählt, schätzt und schreibt nichts", async () => {
    const base = freshDir("dry");
    const table = await makeTable(base, "main");
    const versionBefore = await table.version();
    const out = sink();
    const code = await runCli(["--agent", "main", "--base", base, "--openclaw-home", freshDir("home"), "--json"], { stdout: out, stderr: sink() });
    assert.equal(code, 0);
    const [report] = JSON.parse(out.text);
    assert.equal(report.mode, "dry-run");
    assert.equal(report.textMode, "clean-v1");
    assert.deepEqual(report.counts, { selected: 4, reembed: 2, reembedThisRun: 2, modeOnly: 1, envelopeOnly: 1, invalidId: 0 });
    assert.ok(report.estimate.tokens > 0);
    assert.equal(await table.version(), versionBefore, "Probelauf schreibt nicht");
  });
});

describe("runCli --apply (Kopie außerhalb des OpenClaw-Homes)", () => {
  it("verweigert bei laufendem Gateway ohne --allow-running-gateway", async () => {
    const base = freshDir("gw");
    await makeTable(base, "main");
    const before = await readAll(base, "main");
    const err = sink();
    const code = await runCli(["--agent", "main", "--apply", "--base", base, "--openclaw-home", freshDir("home"), "--workspace-dir", freshDir("ws")], {
      stdout: sink(), stderr: err, gatewayState: running, createEmbedder: fakeEmbedder().create,
    });
    assert.equal(code, 1);
    assert.match(err.text, /gateway is running/);
    assert.deepEqual(await readAll(base, "main"), before);
  });

  it("schreibt nur vector und embeddingTextMode, Text und übrige Spalten bleiben", async () => {
    const base = freshDir("apply");
    const ws = freshDir("ws");
    const out = freshDir("out");
    const HEX = "0123456789abcdef0123456789abcdef";
    await makeTable(base, "main", { extraRows: [{
      id: HEX, text: "Hm, Zeile aus einem alten Import", vector: [0.4, 0.3, 0.2, 0.1], status: "active",
      category: "fact", createdAt: 1_700_000_000_000n, importance: 0.5, embeddingTextMode: "raw",
    }] });
    const before = await readAll(base, "main");
    const embedder = fakeEmbedder();
    const code = await runCli(["--agent", "main", "--apply", "--base", base, "--openclaw-home", freshDir("home"), "--workspace-dir", ws, "--out", out, "--min-interval-ms", "0", "--json"], {
      stdout: sink(), stderr: sink(), gatewayState: stopped, createEmbedder: embedder.create,
    });
    assert.equal(code, 0);
    const afterRows = await readAll(base, "main");
    assert.equal(afterRows.size, before.size);
    // Der Provider sieht nur bereinigte Texte.
    assert.deepEqual(embedder.calls.flat().sort(), [
      "Christian: Das geheime Projekt heißt Nordlicht",
      "Zeile aus einem alten Import",
      "ich wollte fragen, ob das Backup um 3 Uhr läuft",
    ]);
    for (const [id, row] of afterRows) {
      const old = before.get(id);
      assert.equal(row.text, old.text, "Text bleibt wörtlich");
      assert.equal(row.category, old.category);
      assert.equal(row.createdAt, old.createdAt);
      assert.equal(row.status, old.status);
    }
    assert.equal(afterRows.get(IDS.audio).embeddingTextMode, "clean-v1");
    assert.notDeepEqual(afterRows.get(IDS.audio).vector, before.get(IDS.audio).vector);
    assert.equal(afterRows.get(IDS.plain).embeddingTextMode, "clean-v1", "unveränderter Text: nur der Modus");
    assert.deepEqual(afterRows.get(IDS.plain).vector, before.get(IDS.plain).vector);
    assert.equal(afterRows.get(IDS.stub).embeddingTextMode, "raw", "nur Hülle bleibt raw");
    assert.equal(afterRows.get(IDS.archived).embeddingTextMode, "raw", "Standard: nur aktive Zeilen");

    const audit = readFileSync(join(ws, ".adaptive-learning", "destructive-ops.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((e) => e.result), ["started", "committed"]);
    assert.ok(audit.every((e) => e.source === "reembed-clean" && e.agentId === "main"));
    const checkpoint = JSON.parse(readFileSync(join(out, "main.checkpoint.json"), "utf8"));
    assert.equal(checkpoint.done, true);
    assert.equal(checkpoint.rowsReembedded, 3);
    assert.equal(afterRows.get(HEX).embeddingTextMode, "clean-v1", "Hex-ID alter Importe wird mitgenommen");
    assert.equal(checkpoint.rowsModeOnly, 1);
    const [report] = JSON.parse(readFileSync(join(out, readdirReport(out)), "utf8"));
    assert.equal(report.verification.rowsBefore, report.verification.rowsAfter);
    assert.equal(report.verification.nullVectors, 0);
    assert.equal(report.verification.remainingRaw, 1);
    assert.equal(report.verification.cosineOldNew.n, 3);
  });

  it("Abbruch beim Provider: failed im Audit, Wiederaufnahme ohne doppelte Arbeit", async () => {
    const base = freshDir("resume");
    const ws = freshDir("ws");
    const out = freshDir("out");
    await makeTable(base, "main");
    const args = ["--agent", "main", "--apply", "--base", base, "--openclaw-home", freshDir("home"), "--workspace-dir", ws, "--out", out, "--batch-size", "1", "--min-interval-ms", "0", "--no-optimize"];
    const failing = fakeEmbedder({ failOnCall: 2 });
    const err = sink();
    assert.equal(await runCli(args, { stdout: sink(), stderr: err, gatewayState: stopped, createEmbedder: failing.create }), 1);
    assert.match(err.text, /provider down/);
    const partial = await readAll(base, "main");
    const cleanAfterFailure = [...partial.values()].filter((r) => r.embeddingTextMode === "clean-v1" && r.id !== IDS.plain);
    assert.equal(cleanAfterFailure.length, 1, "der erste Block ist geschrieben");
    const checkpoint = JSON.parse(readFileSync(join(out, "main.checkpoint.json"), "utf8"));
    assert.equal(checkpoint.done, false);

    const second = fakeEmbedder();
    assert.equal(await runCli(args, { stdout: sink(), stderr: sink(), gatewayState: stopped, createEmbedder: second.create }), 0);
    assert.equal(second.calls.length, 1, "nur die restliche Zeile wird eingebettet");
    const audit = readFileSync(join(ws, ".adaptive-learning", "destructive-ops.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).result);
    assert.deepEqual(audit, ["started", "failed", "started", "committed"]);
  });

  it("Vektoren aus einem fremden Raum: Abbruch vor dem Schreiben, --min-cosine 0 schaltet ab", async () => {
    const base = freshDir("cos");
    await makeTable(base, "main");
    const before = await readAll(base, "main");
    const orthogonal = {
      create: async () => ({ model: "fake", dimensions: DIM, embedBatch: async (texts) => texts.map(() => [-0.4, 0.3, -0.2, 0.1]) }),
    };
    const ws = freshDir("ws");
    const args = ["--agent", "main", "--apply", "--base", base, "--openclaw-home", freshDir("home"), "--workspace-dir", ws, "--out", freshDir("out"), "--min-interval-ms", "0"];
    const err = sink();
    assert.equal(await runCli(args, { stdout: sink(), stderr: err, gatewayState: stopped, createEmbedder: orthogonal.create }), 1);
    assert.match(err.text, /cosine median 0 is below --min-cosine 0\.2/);
    const after = await readAll(base, "main");
    for (const id of [IDS.audio, IDS.filler]) {
      assert.deepEqual(after.get(id).vector, before.get(id).vector, "kein Vektor geschrieben");
      assert.equal(after.get(id).embeddingTextMode, "raw");
    }
    const audit = readFileSync(join(ws, ".adaptive-learning", "destructive-ops.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).result);
    assert.deepEqual(audit, ["started", "failed"]);

    const base2 = freshDir("cos-off");
    await makeTable(base2, "main");
    assert.equal(await runCli(["--agent", "main", "--apply", "--base", base2, "--openclaw-home", freshDir("home"), "--workspace-dir", freshDir("ws"), "--out", freshDir("out"), "--min-interval-ms", "0", "--min-cosine", "0"], {
      stdout: sink(), stderr: sink(), gatewayState: stopped, createEmbedder: orthogonal.create,
    }), 0);
  });

  it("Checkpoint liegt vor dem ersten Schreibzugriff; SIGINT beendet nach dem Block mit failed und Checkpoint", async () => {
    const base = freshDir("sig");
    const ws = freshDir("ws");
    const out = freshDir("out");
    await makeTable(base, "main");
    const signals = new EventEmitter();
    const checkpointFile = join(out, "main.checkpoint.json");
    let seenAtFirstCall = null;
    const embedder = {
      create: async () => ({
        model: "fake",
        dimensions: DIM,
        embedBatch: async (texts) => {
          if (!seenAtFirstCall) {
            seenAtFirstCall = JSON.parse(readFileSync(checkpointFile, "utf8"));
            signals.emit("SIGINT");
          }
          return texts.map((t) => [0.1, 0.2, 0.3, 0.4 + t.length / 1000]);
        },
      }),
    };
    const args = ["--agent", "main", "--apply", "--base", base, "--openclaw-home", freshDir("home"), "--workspace-dir", ws, "--out", out, "--batch-size", "1", "--min-interval-ms", "0", "--no-optimize"];
    const err = sink();
    assert.equal(await runCli(args, { stdout: sink(), stderr: err, gatewayState: stopped, createEmbedder: embedder.create, signals }), 1);
    assert.equal(seenAtFirstCall.done, false);
    assert.ok(seenAtFirstCall.lanceVersions?.count > 0, "Versionsstand im Checkpoint");
    assert.match(err.text, /interrupted by SIGINT/);
    assert.equal(signals.listenerCount("SIGINT"), 0, "Handler wieder entfernt");
    const partial = await readAll(base, "main");
    for (const id of [IDS.audio, IDS.filler]) assert.equal(partial.get(id).embeddingTextMode, "raw", "der unterbrochene Block wurde nicht geschrieben");
    // Fortsetzen mit demselben Aufruf
    assert.equal(await runCli(args, { stdout: sink(), stderr: sink(), gatewayState: stopped, createEmbedder: fakeEmbedder().create, signals }), 0);
    const audit = readFileSync(join(ws, ".adaptive-learning", "destructive-ops.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).result);
    assert.deepEqual(audit, ["started", "failed", "started", "committed"]);
    assert.equal((await readAll(base, "main")).get(IDS.audio).embeddingTextMode, "clean-v1");
  });

  it("ein unfertiger Checkpoint mit anderem Modus wird nicht weitergeführt", async () => {
    const base = freshDir("mode");
    const out = freshDir("out");
    await makeTable(base, "main");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "main.checkpoint.json"), JSON.stringify({ version: 1, textMode: "clean-v1-nospeaker", statusFilter: "active", done: false }));
    const err = sink();
    const code = await runCli(["--agent", "main", "--apply", "--base", base, "--openclaw-home", freshDir("home"), "--workspace-dir", freshDir("ws"), "--out", out], {
      stdout: sink(), stderr: err, gatewayState: stopped, createEmbedder: fakeEmbedder().create,
    });
    assert.equal(code, 1);
    assert.match(err.text, /unfinished checkpoint/);
  });

  it("fehlende Spalte: Abbruch ohne --add-column, mit --add-column angelegt", async () => {
    const base = freshDir("col");
    await makeTable(base, "main", { withMode: false });
    const common = ["--agent", "main", "--apply", "--base", base, "--openclaw-home", freshDir("home"), "--workspace-dir", freshDir("ws"), "--out", freshDir("out"), "--min-interval-ms", "0"];
    const err = sink();
    assert.equal(await runCli(common, { stdout: sink(), stderr: err, gatewayState: stopped, createEmbedder: fakeEmbedder().create }), 1);
    assert.match(err.text, /embeddingTextMode is missing/);
    assert.equal(await runCli([...common, "--add-column"], { stdout: sink(), stderr: sink(), gatewayState: stopped, createEmbedder: fakeEmbedder().create }), 0);
    const rows = await readAll(base, "main");
    assert.equal(rows.get(IDS.audio).embeddingTextMode, "clean-v1");
    assert.equal(rows.get(IDS.stub).embeddingTextMode, "raw");
  });

  it("falsche Dimension des Providers bricht ab, bevor geschrieben wird", async () => {
    const base = freshDir("dims");
    await makeTable(base, "main");
    const before = await readAll(base, "main");
    const err = sink();
    const code = await runCli(["--agent", "main", "--apply", "--base", base, "--openclaw-home", freshDir("home"), "--workspace-dir", freshDir("ws"), "--out", freshDir("out"), "--max-rows", "0"], {
      stdout: sink(), stderr: err, gatewayState: stopped, createEmbedder: fakeEmbedder({ dims: 3 }).create,
    });
    // --max-rows 0: kein Provider nötig, nur Modus-Umstellung.
    assert.equal(code, 0);
    assert.equal((await readAll(base, "main")).get(IDS.audio).embeddingTextMode, "raw");
    assert.deepEqual((await readAll(base, "main")).get(IDS.audio).vector, before.get(IDS.audio).vector);
    const code2 = await runCli(["--agent", "main", "--apply", "--base", base, "--openclaw-home", freshDir("home"), "--workspace-dir", freshDir("ws"), "--out", freshDir("out")], {
      stdout: sink(), stderr: err, gatewayState: stopped, createEmbedder: fakeEmbedder({ dims: 3 }).create,
    });
    assert.equal(code2, 1);
    assert.match(err.text, /dimensions 3 do not match/);
    assert.deepEqual((await readAll(base, "main")).get(IDS.audio).vector, before.get(IDS.audio).vector);
    // Auf einer frischen Tabelle schreibt der Lauf gar nichts, auch keine Modus-Umstellung.
    const base3 = freshDir("dims-fresh");
    await makeTable(base3, "main");
    const fresh = await readAll(base3, "main");
    assert.equal(await runCli(["--agent", "main", "--apply", "--base", base3, "--openclaw-home", freshDir("home"), "--workspace-dir", freshDir("ws"), "--out", freshDir("out")], {
      stdout: sink(), stderr: sink(), gatewayState: stopped, createEmbedder: fakeEmbedder({ dims: 3 }).create,
    }), 1);
    assert.deepEqual(await readAll(base3, "main"), fresh);
  });
});

describe("runCli --apply im Produktivpfad (<base> unter dem OpenClaw-Home)", () => {
  async function prodSetup() {
    const home = freshDir("home");
    const base = join(home, "memory", "lancedb-namespaced");
    mkdirSync(base, { recursive: true });
    await makeTable(base, "main");
    const ws = join(home, "workspace");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(home, "openclaw.json"), JSON.stringify({
      agents: { entries: { main: { workspace: ws } } },
      plugins: { entries: { "memory-lancedb-namespaced": { config: { embedding: { model: "text-embedding-3-large" } } } } },
    }));
    return { home, base, ws };
  }
  const snapshotOf = (home, base, name) => {
    const snap = join(home, ".snapshots", name);
    mkdirSync(join(snap, "memory"), { recursive: true });
    cpSync(base, join(snap, "memory", "lancedb-namespaced"), { recursive: true });
    writeFileSync(join(snap, "manifest.json"), "{}");
    return snap;
  };

  it("verlangt gestoppten Gateway, Plugin ≥ 7.20.10 und einen passenden Snapshot", async () => {
    const { home, base } = await prodSetup();
    const args = ["--agent", "main", "--apply", "--openclaw-home", home, "--min-interval-ms", "0"];
    const run = (extra, rt) => {
      const err = sink();
      return runCli([...args, ...extra], { stdout: sink(), stderr: err, createEmbedder: fakeEmbedder().create, ...rt }).then((code) => ({ code, err: err.text }));
    };
    let r = await run([], { gatewayState: running, livePluginVersion: () => "7.20.10" });
    assert.equal(r.code, 1); assert.match(r.err, /stop it first/);
    r = await run(["--allow-running-gateway"], { gatewayState: running, livePluginVersion: () => "7.20.10" });
    assert.equal(r.code, 1); assert.match(r.err, /stop it first/, "die Ausnahme gilt nicht im Produktivpfad");
    r = await run([], { gatewayState: stopped, livePluginVersion: () => "7.20.9" });
    assert.equal(r.code, 1); assert.match(r.err, /older than 7\.20\.10/);
    r = await run([], { gatewayState: stopped, livePluginVersion: () => "7.20.10" });
    assert.equal(r.code, 1); assert.match(r.err, /requires --snapshot/);
    const outside = freshDir("snap-outside");
    writeFileSync(join(outside, "manifest.json"), "{}");
    r = await run(["--snapshot", outside], { gatewayState: stopped, livePluginVersion: () => "7.20.10" });
    assert.equal(r.code, 1); assert.match(r.err, /snapshot must live under/);

    const stale = snapshotOf(home, base, "plur1bus-stale");
    // Eine Schreiboperation nach dem Snapshot: Versionen weichen ab.
    const t = await (await lancedb.connect(join(base, "main"))).openTable("memories");
    await t.update({ where: `id = '${IDS.plain}'`, values: { category: "config" } });
    r = await run(["--snapshot", stale], { gatewayState: stopped, livePluginVersion: () => "7.20.10" });
    assert.equal(r.code, 1); assert.match(r.err, /LanceDB versions differ/);

    const fresh = snapshotOf(home, base, "plur1bus-fresh");
    r = await run(["--snapshot", fresh], { gatewayState: stopped, livePluginVersion: () => "7.20.10" });
    assert.equal(r.code, 0, r.err);
    // Audit-Log im Workspace aus openclaw.json, Bericht neben der Basis.
    assert.ok(existsSync(join(home, "workspace", ".adaptive-learning", "destructive-ops.jsonl")));
    assert.ok(existsSync(join(home, "memory", "reembed-clean", "main.checkpoint.json")));
  });

  it("ein abgebrochener Lauf lässt sich mit demselben Snapshot fortsetzen", async () => {
    const { home, base } = await prodSetup();
    const snap = snapshotOf(home, base, "plur1bus-resume");
    const args = ["--agent", "main", "--apply", "--openclaw-home", home, "--snapshot", snap, "--batch-size", "1", "--min-interval-ms", "0"];
    const rt = { stdout: sink(), gatewayState: stopped, livePluginVersion: () => "7.20.10" };
    const err = sink();
    assert.equal(await runCli(args, { ...rt, stderr: err, createEmbedder: fakeEmbedder({ failOnCall: 2 }).create }), 1);
    assert.match(err.text, /provider down/);
    const out = sink();
    const second = fakeEmbedder();
    assert.equal(await runCli([...args, "--json"], { ...rt, stdout: out, stderr: sink(), createEmbedder: second.create }), 0);
    const [report] = JSON.parse(out.text);
    assert.equal(report.preconditions.snapshot.resumedWithSupersetSnapshot, true);
    assert.equal(second.calls.length, 1, "nur die restliche Zeile");
    const checkpoint = JSON.parse(readFileSync(join(home, "memory", "reembed-clean", "main.checkpoint.json"), "utf8"));
    assert.equal(checkpoint.done, true);
    assert.equal(checkpoint.snapshot, snap);
    // Ein neuer Lauf mit dem alten Snapshot ist kein Fortsetzen mehr: live hat jetzt mehr Versionen.
    const errFresh = sink();
    assert.equal(await runCli(args, { ...rt, stderr: errFresh, createEmbedder: fakeEmbedder().create }), 1);
    assert.match(errFresh.text, /LanceDB versions differ/);
  });

  it("ein fremder Schreiber zwischen zwei Teilläufen: Abbruch, ein frischer Snapshot wird die neue Basis", async () => {
    const { home, base } = await prodSetup();
    const snap = snapshotOf(home, base, "plur1bus-staged-foreign");
    const args = ["--agent", "main", "--apply", "--openclaw-home", home, "--min-interval-ms", "0", "--max-rows", "1", "--batch-size", "1", "--json"];
    const rt = { stderr: sink(), gatewayState: stopped, livePluginVersion: () => "7.20.10", createEmbedder: fakeEmbedder().create };
    assert.equal(await runCli([...args, "--snapshot", snap], { ...rt, stdout: sink() }), 0);
    // Gateway lief dazwischen und hat eine Zeile geändert.
    const t = await (await lancedb.connect(join(base, "main"))).openTable("memories");
    await t.update({ where: `id = '${IDS.plain}'`, values: { category: "config" } });
    const err = sink();
    assert.equal(await runCli([...args, "--snapshot", snap], { ...rt, stdout: sink(), stderr: err }), 1);
    assert.match(err.text, /table changed since the last checkpoint .*take a fresh snapshot/);
    const fresh = snapshotOf(home, base, "plur1bus-staged-fresh");
    const out = sink();
    assert.equal(await runCli([...args, "--snapshot", fresh], { ...rt, stdout: out }), 0);
    const [report] = JSON.parse(out.text);
    assert.equal(report.preconditions.rebasedOnSnapshot, true);
    assert.equal(report.preconditions.snapshot.lanceVersions.identical, true);
    const checkpoint = JSON.parse(readFileSync(join(home, "memory", "reembed-clean", "main.checkpoint.json"), "utf8"));
    assert.equal(checkpoint.snapshot, fresh);
    assert.equal(checkpoint.done, true);
  });

  it("ein Abbruch ohne Schreibzugriff öffnet keine Lücke für fremde Versionen", async () => {
    const { home, base } = await prodSetup();
    const snap = snapshotOf(home, base, "plur1bus-dims-foreign");
    const args = ["--agent", "main", "--apply", "--openclaw-home", home, "--snapshot", snap, "--min-interval-ms", "0"];
    const rt = { stdout: sink(), gatewayState: stopped, livePluginVersion: () => "7.20.10" };
    const err = sink();
    assert.equal(await runCli(args, { ...rt, stderr: err, createEmbedder: fakeEmbedder({ dims: 3 }).create }), 1);
    assert.match(err.text, /dimensions 3 do not match/);
    const t = await (await lancedb.connect(join(base, "main"))).openTable("memories");
    await t.update({ where: `id = '${IDS.plain}'`, values: { category: "config" } });
    const err2 = sink();
    assert.equal(await runCli(args, { ...rt, stderr: err2, createEmbedder: fakeEmbedder().create }), 1);
    assert.match(err2.text, /table changed since the last checkpoint/);
  });

  it("ein gestaffelter Lauf (--max-rows) kompaktiert erst am Ende", async () => {
    const { home, base } = await prodSetup();
    const snap = snapshotOf(home, base, "plur1bus-staged");
    const args = ["--agent", "main", "--apply", "--openclaw-home", home, "--snapshot", snap, "--min-interval-ms", "0", "--max-rows", "1", "--json"];
    const rt = { stderr: sink(), gatewayState: stopped, livePluginVersion: () => "7.20.10", createEmbedder: fakeEmbedder().create };
    let out = sink();
    assert.equal(await runCli(args, { ...rt, stdout: out }), 0);
    let [report] = JSON.parse(out.text);
    assert.equal(report.optimize, undefined, "Teillauf ohne optimize()");
    out = sink();
    assert.equal(await runCli(args, { ...rt, stdout: out }), 0);
    [report] = JSON.parse(out.text);
    assert.equal(report.preconditions.snapshot.resumedWithSupersetSnapshot, true);
    assert.ok(report.optimize, "letzter Teil kompaktiert");
  });
});

function readdirReport(dir) {
  const files = readdirSync(dir).filter((f) => f.startsWith("report-"));
  assert.equal(files.length, 1);
  return files[0];
}
