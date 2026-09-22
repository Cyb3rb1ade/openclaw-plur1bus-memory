import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DIARY_END_MARKER,
  DIARY_START_MARKER,
  appendDreamDiaryEntry,
  buildDiaryEntry,
  diaryScopeAllowed,
  emitDreamCompletedEvent,
  formatDiaryDate,
  insertDiaryEntry,
  narrativeFingerprint,
} from "../lib/dreaming/dream-diary.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const NARRATIVE = "Ich schwebe über einer Stadt aus Zahlen, und jede Straße kennt meinen Namen.";
const HOST_FILE = `# Dream Diary

${DIARY_START_MARKER}
---

*September 3, 2026 at 3:00 AM GMT+2*

Ein Traum, den der Host geschrieben hat.
${DIARY_END_MARKER}

<!-- openclaw:dreaming:deep:start -->
deep block
<!-- openclaw:dreaming:deep:end -->
`;

function tempWorkspace() {
  const dir = makeTempDir("plur1bus-diary-");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the entry has the host's shape and names its source", () => {
  const entry = buildDiaryEntry({ narrative: NARRATIVE, mode: "rem", dateText: "September 4, 2026 at 3:06 AM GMT+2" });
  assert.match(entry, /^\n---\n\n\*September 4, 2026 at 3:06 AM GMT\+2\*\n\n/);
  assert.match(entry, /Stadt aus Zahlen/);
  assert.match(entry, /PLUR1BUS · REM dream · [0-9a-f]{16}/);
  assert.throws(() => buildDiaryEntry({ narrative: "   ", mode: "rem", dateText: "x" }), /needs a narrative/);
});

test("the date reads like the host's own diary stamps", () => {
  const text = formatDiaryDate(Date.UTC(2026, 8, 4, 1, 6), "Europe/Berlin");
  assert.match(text, /^September 4, 2026 at 3:06 AM GMT\+2$/);
  // An unknown zone falls back instead of throwing.
  assert.match(formatDiaryDate(Date.UTC(2026, 8, 4, 1, 6), "Not/AZone"), /2026/);
});

test("an entry goes before the end marker and leaves the host's blocks alone", () => {
  const entry = buildDiaryEntry({ narrative: NARRATIVE, mode: "rem", dateText: "now" });
  const next = insertDiaryEntry(HOST_FILE, entry, { narrative: NARRATIVE });
  assert.equal(next.changed, true);
  assert.ok(next.content.includes("Ein Traum, den der Host geschrieben hat."), "host entry kept");
  assert.ok(next.content.includes("deep block"), "deep block kept");
  assert.ok(next.content.indexOf("Stadt aus Zahlen") < next.content.indexOf(DIARY_END_MARKER), "inside the diary block");
  assert.ok(next.content.indexOf("Stadt aus Zahlen") > next.content.indexOf("Host geschrieben"), "after the older entry");
});

test("without a diary block one is created at the top and existing content is kept", () => {
  const entry = buildDiaryEntry({ narrative: NARRATIVE, mode: "light", dateText: "now" });
  const next = insertDiaryEntry("# Notes\n\nsomething else\n", entry, { narrative: NARRATIVE });
  assert.ok(next.content.startsWith("# Dream Diary\n\n" + DIARY_START_MARKER));
  assert.ok(next.content.includes(DIARY_END_MARKER));
  assert.ok(next.content.trimEnd().endsWith("something else"));
});

test("the same dream is not written twice", () => {
  const entry = buildDiaryEntry({ narrative: NARRATIVE, mode: "rem", dateText: "now" });
  const once = insertDiaryEntry(HOST_FILE, entry, { narrative: NARRATIVE });
  const twice = insertDiaryEntry(once.content, entry, { narrative: NARRATIVE });
  assert.equal(twice.changed, false);
  assert.equal(twice.reason, "already_present");
  // Case and spacing do not change identity. (Not toUpperCase(): "ß" becomes
  // "SS" and would not round-trip, which is a Unicode fact, not a diary one.)
  assert.equal(narrativeFingerprint(NARRATIVE), narrativeFingerprint(`  ${NARRATIVE.replace("Stadt", "STADT").replace(", und", ",   und")}\n`), "fingerprint ignores case and spacing");
});

test("appending writes the file atomically and reports what it did", () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    writeFileSync(join(dir, "DREAMS.md"), HOST_FILE);
    const logs = [];
    const first = appendDreamDiaryEntry({ workspaceDir: dir, narrative: NARRATIVE, mode: "rem", timezone: "Europe/Berlin", now: () => Date.UTC(2026, 8, 4, 1, 6), logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
    assert.equal(first.written, true);
    const content = readFileSync(join(dir, "DREAMS.md"), "utf8");
    assert.ok(content.includes("Stadt aus Zahlen"));
    assert.ok(content.includes("September 4, 2026 at 3:06 AM GMT+2"));
    const second = appendDreamDiaryEntry({ workspaceDir: dir, narrative: NARRATIVE, mode: "rem" });
    assert.equal(second.written, false);
    assert.equal(second.reason, "already_present");
    assert.equal(readFileSync(join(dir, "DREAMS.md"), "utf8"), content, "second call leaves the file untouched");
    assert.ok(logs.some((line) => /entry appended/.test(line)));
  } finally {
    cleanup();
  }
});

test("a missing file is created, a symlink is refused, and nothing ever throws", () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    const created = appendDreamDiaryEntry({ workspaceDir: dir, narrative: NARRATIVE, mode: "light" });
    assert.equal(created.written, true);
    assert.ok(readFileSync(join(dir, "DREAMS.md"), "utf8").startsWith("# Dream Diary"));
    rmSync(join(dir, "DREAMS.md"));
    writeFileSync(join(dir, "elsewhere.md"), "x");
    symlinkSync(join(dir, "elsewhere.md"), join(dir, "DREAMS.md"));
    const warned = [];
    const refused = appendDreamDiaryEntry({ workspaceDir: dir, narrative: NARRATIVE, mode: "light", logger: { warn: (m) => warned.push(m) } });
    assert.equal(refused.written, false);
    assert.equal(refused.reason, "write_failed");
    assert.match(warned.join("\n"), /symbolic link/);
    assert.equal(readFileSync(join(dir, "elsewhere.md"), "utf8"), "x", "the link target was not touched");
    assert.deepEqual(appendDreamDiaryEntry({ workspaceDir: "", narrative: NARRATIVE }), { written: false, path: null, reason: "no_workspace" });
    assert.deepEqual(appendDreamDiaryEntry({ workspaceDir: dir, narrative: "" }), { written: false, path: null, reason: "empty_narrative" });
  } finally {
    cleanup();
  }
});

test("the completion event uses the host's shape and fails open", async () => {
  const seen = [];
  const ok = await emitDreamCompletedEvent({
    workspaceDir: "/ws",
    mode: "rem",
    narrative: "line one\nline two\n\nline three",
    now: () => Date.UTC(2026, 8, 4, 1, 6),
    importHostEvents: async () => ({ appendMemoryHostEvent: async (dir, event) => { seen.push([dir, event]); } }),
  });
  assert.equal(ok, true);
  assert.deepEqual(seen, [["/ws", {
    type: "memory.dream.completed",
    timestamp: "2026-09-04T01:06:00.000Z",
    phase: "rem",
    outcome: "completed",
    lineCount: 3,
    storageMode: "inline",
  }]]);
  const warned = [];
  const failed = await emitDreamCompletedEvent({
    workspaceDir: "/ws",
    mode: "light",
    narrative: "x",
    importHostEvents: async () => { throw new Error("no such module"); },
    logger: { warn: (m) => warned.push(m) },
  });
  assert.equal(failed, false);
  assert.match(warned.join("\n"), /fail-open/);
  assert.equal(await emitDreamCompletedEvent({ workspaceDir: "/ws", mode: "light", narrative: "x", importHostEvents: async () => ({}) }), false, "a host without the function is not an error");
});

test("diaryScopeAllowed admits the agent's own scope under both spellings and refuses shared ones", () => {
  assert.equal(diaryScopeAllowed(undefined), true);
  assert.equal(diaryScopeAllowed("agent"), true);
  assert.equal(diaryScopeAllowed("agent-private"), true, "ACL bindings spell the private scope this way");
  assert.equal(diaryScopeAllowed("workspace"), false);
  assert.equal(diaryScopeAllowed("user"), false);
});

// Die Bruecke ist von lightDream aus injizierbar. Ohne diese Verdrahtung laedt
// jeder Testlauf das echte OpenClaw-SDK: 305 ms fuer den Load plus 1929 ms fuer
// das erste Event je Prozess. Das hat die 2000-ms-Frist in
// abort-commit-barriers.test.js gerissen, und zwar nur auf Hosts, auf denen
// OpenClaw installiert ist — ohne das Paket scheitert der Loader nach 20 ms
// und der Test lief gruen durch.
test("lightDream reicht die Host-Event-Bruecke durch, statt das SDK zu laden", async () => {
  const { lightDream } = await import("../lib/dreaming/light-dream.js");
  const workspaceDir = mkdtempSync(join(tmpdir(), "light-dream-host-events-"));
  const seen = [];
  const createdAt = new Date().toISOString();
  try {
    await lightDream({
      turns: Array.from({ length: 3 }, (_, i) => ({
        id: `turn-${i}`, agentId: "diary-agent", workspaceKey: "default",
        role: i % 2 === 0 ? "user" : "assistant", content: `Nachricht ${i} mit etwas Inhalt`, createdAt,
      })),
      workspaceDir,
      neoStore: { readReactions: () => [], appendDreams: () => {}, appendBehaviorCards: () => {} },
      db: { search: async () => [], store: async () => {} },
      insightLlmCfg: { feature: "conversation-insights" },
      narrativeLlmCfg: { feature: "dream-narrative" },
      echoLlmCfg: { feature: "dream-echo" },
      personaLlmCfg: { feature: "persona-voice" },
      narrativeCfg: { enabled: true, storeAsMemory: false },
      logger: { info: () => {}, warn: () => {} },
      callLlm: async (_messages, cfg) => ({
        "conversation-insights": JSON.stringify(["A durable project insight for the dream."]),
        "dream-narrative": "A sufficiently long dream narrative crosses a quiet archive and returns with one clear project decision.",
        "dream-echo": JSON.stringify({ sentence: "Die Entscheidung ging mir durch den Kopf.", topics: ["decision"] }),
      })[cfg.feature],
      importHostEvents: async () => ({
        appendMemoryHostEvent: async (_dir, event) => { seen.push(event.type); },
      }),
    });
    assert.deepEqual(seen, ["memory.dream.completed"], "die injizierte Bruecke muss das Ereignis erhalten");
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
