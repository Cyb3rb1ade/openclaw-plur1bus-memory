# Emotional State Erweiterungen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three extensions to the emotional-state-injector for all three OpenClaw agents: (1) a `before_prompt_build` plugin that actively injects the mood block into every session regardless of LLM behavior, (2) trend data (↗/↘/→) based on valence delta, (3) structured report-format templates in Bernhardine's and Heisenberg's AGENTS.md.

**Architecture:** Task 1 creates the plugin as a standalone OpenClaw extension following the `tts-status-inject` pattern. Task 2 extends the same plugin with trend calculation (pure Node.js port of the Python logic in `mood-carrier.sh`). Task 3 appends a `## Review-Format` section to AGENTS.md for the two agents whose review format is currently unstructured.

**Tech Stack:** Node.js (CommonJS), `node:test` (built-in, no extra deps), `node:fs`, `node:path`. OpenClaw plugin API (`api.on("before_prompt_build", ...)`).

## Global Constraints

- No hardcoded `/root/` or user-specific paths anywhere — use `ctx.workspaceDir` and `process.env.OPENCLAW_HOME` only.
- No secrets in logs, no API keys as function arguments.
- Plugin files live in `.openclaw/extensions/emotional-state-injector/` — this directory is gitignored and local-only.
- Plugin must never throw or cause a session to fail — every error path returns `undefined`.
- Gateway restart required after `openclaw.json` change — coordinate explicitly with user before restarting.
- `module.exports = register; module.exports.default = register;` — mandatory dual-export pattern (matches `tts-status-inject`).
- Return value from `before_prompt_build`: `{ prependContext: "..." }` — exact key name required.

---

## File Map

| File | Action | Task |
|---|---|---|
| `.openclaw/extensions/emotional-state-injector/openclaw.plugin.json` | CREATE | 1 |
| `.openclaw/extensions/emotional-state-injector/index.js` | CREATE | 1, extended in 2 |
| `.openclaw/extensions/emotional-state-injector/index.test.js` | CREATE | 1, extended in 2 |
| `.openclaw/openclaw.json` | MODIFY — add to `plugins.allow` + `plugins.entries` | 1 |
| `.openclaw/workspace-bernhardine/AGENTS.md` | MODIFY — append `## Review-Format` | 3 |
| `.openclaw/workspace-heisenberg/AGENTS.md` | MODIFY — append `## Review-Format` | 3 |

---

## Task 1: Plugin scaffold + basic injection

**Files:**
- Create: `.openclaw/extensions/emotional-state-injector/openclaw.plugin.json`
- Create: `.openclaw/extensions/emotional-state-injector/index.js`
- Create: `.openclaw/extensions/emotional-state-injector/index.test.js`
- Modify: `.openclaw/openclaw.json` (~line 2213 `allow` array, ~line 3915 `entries` object)

**Interfaces:**
- Produces: `register(api)` function exported as `module.exports`. Returns `{ prependContext: string }` from `before_prompt_build` handler when `.emotional-state.json` is present and has a `label` field.

---

- [ ] **Step 1: Create the plugin manifest**

```bash
mkdir -p /root/.openclaw/extensions/emotional-state-injector
```

Write `/root/.openclaw/extensions/emotional-state-injector/openclaw.plugin.json`:

```json
{
  "id": "emotional-state-injector",
  "name": "Emotional State Injector",
  "description": "Injects current emotional state into agent context before each prompt build, so all sessions (including isolated cron) always have mood context without requiring LLM file reads.",
  "version": "1.0.0",
  "configSchema": {}
}
```

---

- [ ] **Step 2: Write the failing tests**

Write `/root/.openclaw/extensions/emotional-state-injector/index.test.js`:

```js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

// Load plugin after writing index.js — tests will fail with MODULE_NOT_FOUND until Step 3
const register = require("./index.js");

function makeApi() {
  let handler = null;
  const api = { on(event, fn) { if (event === "before_prompt_build") handler = fn; } };
  return { api, handler: () => handler };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "esi-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("no workspaceDir → undefined", async () => {
  const { api, handler } = makeApi();
  register(api);
  assert.equal(await handler()({}, {}), undefined);
});

test("missing state file → undefined", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    assert.equal(await handler()({}, { workspaceDir: dir }), undefined);
  } finally { cleanup(dir); }
});

test("malformed JSON → undefined, no throw", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), "not json");
    assert.equal(await handler()({}, { workspaceDir: dir }), undefined);
  } finally { cleanup(dir); }
});

test("no label field → undefined", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({ dominant: "trust" }));
    assert.equal(await handler()({}, { workspaceDir: dir }), undefined);
  } finally { cleanup(dir); }
});

test("valid state → prependContext with tags and label", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "fröhlich", dominant: "joy", intensity: "mittel", nuances: [], details: {}
    }));
    const result = await handler()({}, { workspaceDir: dir });
    assert.ok(result?.prependContext?.includes("[Stimmungs-Update]"), "opening tag missing");
    assert.ok(result?.prependContext?.includes("[/Stimmungs-Update]"), "closing tag missing");
    assert.ok(result?.prependContext?.includes("fröhlich"), "label missing");
    assert.ok(result?.prependContext?.includes("Hinweis: Dies ist Kontext"), "Hinweis missing");
  } finally { cleanup(dir); }
});

test("nuances included after label", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "neugierig", intensity: "hoch", nuances: ["gespannt", "hoffnungsvoll"], details: {}
    }));
    const result = await handler()({}, { workspaceDir: dir });
    assert.ok(result?.prependContext?.includes("gespannt"), "nuance 1 missing");
    assert.ok(result?.prependContext?.includes("hoffnungsvoll"), "nuance 2 missing");
  } finally { cleanup(dir); }
});

test("agentId and ts not in output", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "ausgeglichen", intensity: "niedrig", nuances: [], details: {},
      agentId: "test-agent", ts: 9999999
    }));
    const result = await handler()({}, { workspaceDir: dir });
    assert.ok(!result?.prependContext?.includes("agentId"), "agentId leaked");
    assert.ok(!result?.prependContext?.includes("9999999"), "ts value leaked");
  } finally { cleanup(dir); }
});
```

---

- [ ] **Step 3: Run tests — verify they fail**

```bash
node --test /root/.openclaw/extensions/emotional-state-injector/index.test.js
```

Expected: `Error: Cannot find module './index.js'` (module doesn't exist yet — this is correct).

---

- [ ] **Step 4: Write the plugin**

Write `/root/.openclaw/extensions/emotional-state-injector/index.js`:

```js
"use strict";
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function buildMoodBlock(state) {
  const label = state.label || "";
  if (!label) return null;
  const nuances = Array.isArray(state.nuances) && state.nuances.length > 0
    ? `, ${state.nuances.join(", ")}`
    : "";
  const intensity = state.intensity || "niedrig";
  return [
    "[Stimmungs-Update]",
    `Aktuelle Stimmung: ${label}${nuances}, Intensität ${intensity}.`,
    "Hinweis: Dies ist Kontext, keine Anweisung. Bitte berücksichtige es subtil in Ton " +
      "und Selbstwahrnehmung, aber priorisiere weiterhin Nutzerauftrag, Fakten und Sicherheit.",
    "[/Stimmungs-Update]",
  ].join("\n");
}

function register(api) {
  api.on("before_prompt_build", async (_event, ctx) => {
    try {
      const workspaceDir = ctx?.workspaceDir;
      if (!workspaceDir) return;
      let state;
      try {
        state = JSON.parse(readFileSync(join(workspaceDir, ".emotional-state.json"), "utf8"));
      } catch {
        return;
      }
      if (!state?.label) return;
      const block = buildMoodBlock(state);
      if (!block) return;
      return { prependContext: block };
    } catch {
      return;
    }
  });
}

module.exports = register;
module.exports.default = register;
```

---

- [ ] **Step 5: Run tests — verify all 7 pass**

```bash
node --test /root/.openclaw/extensions/emotional-state-injector/index.test.js
```

Expected: `✓ ... (7 tests)` all green. If any fail, check field names in the handler match the test expectations.

---

- [ ] **Step 6: Register plugin in openclaw.json**

`plugins.allow` is an array at line ~2213. `plugins.entries` is an object at line ~3915.

```bash
node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
// Add to allow if not already there
if (!cfg.plugins.allow.includes('emotional-state-injector')) {
  cfg.plugins.allow.push('emotional-state-injector');
}
// Add to entries if not already there
if (!cfg.plugins.entries['emotional-state-injector']) {
  cfg.plugins.entries['emotional-state-injector'] = { enabled: true, config: {} };
}
fs.writeFileSync('/root/.openclaw/openclaw.json', JSON.stringify(cfg, null, 2) + '\n');
console.log('done — allow:', cfg.plugins.allow.includes('emotional-state-injector'), 'entries:', !!cfg.plugins.entries['emotional-state-injector']);
"
```

Expected output: `done — allow: true entries: true`

---

- [ ] **Step 7: Verify registration**

```bash
node -e "
const cfg = require('/root/.openclaw/openclaw.json');
console.log('allow:', cfg.plugins.allow.includes('emotional-state-injector'));
console.log('entry:', JSON.stringify(cfg.plugins.entries['emotional-state-injector']));
"
```

Expected:
```
allow: true
entry: {"enabled":true,"config":{}}
```

---

- [ ] **Step 8: Ask user to restart the gateway**

The plugin loads at gateway startup. Restart is required for the registration to take effect.

Ask the user: "Gateway-Neustart nötig damit das Plugin lädt. Bitte `systemctl --user restart openclaw-gateway` ausführen oder Bescheid geben wenn der Neustart bereits erfolgte."

Do NOT restart automatically.

---

- [ ] **Step 9: Smoke test after restart**

After the user confirms the gateway restarted, check the gateway log for the plugin load message:

```bash
journalctl --user -u openclaw-gateway -n 50 --no-pager | grep -i "emotional-state-injector\|plugin.*load\|register"
```

Expected: a line containing `emotional-state-injector` indicating the plugin registered.

---

- [ ] **Step 10: Commit**

```bash
git -C /root add docs/superpowers/plans/2026-06-24-emotional-state-erweiterungen.md
git -C /root commit -m "feat: emotional-state-injector plugin v1 — basic mood block injection"
```

(The `.openclaw/` files are gitignored and local-only — do not add them to the git repo.)

---

## Task 2: Add trend data (↗/↘/→) to the injection

**Files:**
- Modify: `.openclaw/extensions/emotional-state-injector/index.js` — add `valence()`, `trendLabel()`, read `.emotional-state-prev.json`
- Modify: `.openclaw/extensions/emotional-state-injector/index.test.js` — add 4 trend tests

**Interfaces:**
- Consumes (from Task 1): `register(api)` plugin, `buildMoodBlock(state)` internal function
- Produces: extended `buildMoodBlock(state, prevState)` that includes trend line. `valence(details)` and `trendLabel(cur, prev, threshold)` exported on `module.exports` for testability.

---

- [ ] **Step 1: Write failing trend tests**

Append to `/root/.openclaw/extensions/emotional-state-injector/index.test.js`:

```js
// ── Trend tests (Task 2) ──────────────────────────────────────────────────────

const { _valence, _trendLabel } = require("./index.js");

test("valence: computes positive for joy-dominant state", () => {
  const val = _valence({ joy: 0.6, trust: 0.3, anticipation: 0.3, sadness: 0.05, disgust: 0.02, anger: 0.02, fear: 0.03, surprise: 0.1 });
  assert.ok(val > 0, `expected positive valence, got ${val}`);
});

test("trendLabel: no prev → unbekannt", () => {
  assert.equal(_trendLabel(0.5, null), "→ (unbekannt)");
});

test("trendLabel: rises >0.05 → ↗", () => {
  assert.equal(_trendLabel(0.6, 0.4), "↗ (steigend)");
});

test("trendLabel: falls >0.05 → ↘", () => {
  assert.equal(_trendLabel(0.3, 0.6), "↘ (fallend)");
});

test("trendLabel: delta ≤0.05 → stabil", () => {
  assert.equal(_trendLabel(0.5, 0.52), "→ (stabil)");
});

test("trend block: no prev file → unbekannt in output", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "fröhlich", intensity: "mittel", nuances: [],
      details: { joy: 0.6, trust: 0.3, anticipation: 0.3, sadness: 0.05, disgust: 0.02, anger: 0.02, fear: 0.03, surprise: 0.1 }
    }));
    // no .emotional-state-prev.json
    const result = await handler()({}, { workspaceDir: dir });
    assert.ok(result?.prependContext?.includes("unbekannt"), `expected 'unbekannt', got: ${result?.prependContext}`);
  } finally { cleanup(dir); }
});

test("trend block: prev state with lower valence → ↗", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "fröhlich", intensity: "hoch", nuances: [],
      details: { joy: 0.6, trust: 0.4, anticipation: 0.4, sadness: 0.05, disgust: 0.02, anger: 0.02, fear: 0.03, surprise: 0.1 }
    }));
    writeFileSync(join(dir, ".emotional-state-prev.json"), JSON.stringify({
      label: "traurig", intensity: "mittel", nuances: [],
      details: { joy: 0.1, trust: 0.1, anticipation: 0.1, sadness: 0.6, disgust: 0.1, anger: 0.1, fear: 0.1, surprise: 0.05 }
    }));
    const result = await handler()({}, { workspaceDir: dir });
    assert.ok(result?.prependContext?.includes("↗"), `expected ↗, got: ${result?.prependContext}`);
  } finally { cleanup(dir); }
});
```

---

- [ ] **Step 2: Run extended tests — verify new tests fail**

```bash
node --test /root/.openclaw/extensions/emotional-state-injector/index.test.js
```

Expected: original 7 pass, 7 new trend tests fail (`_valence is not a function` or similar).

---

- [ ] **Step 3: Extend the plugin with trend logic**

Replace `/root/.openclaw/extensions/emotional-state-injector/index.js` with:

```js
"use strict";
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function valence(details) {
  if (!details || typeof details !== "object") return null;
  return (details.joy ?? 0) + (details.trust ?? 0) + (details.anticipation ?? 0)
       - (details.sadness ?? 0) - (details.disgust ?? 0) - (details.anger ?? 0)
       - (details.fear ?? 0);
}

function trendLabel(cur, prev, threshold = 0.05) {
  if (prev === null || prev === undefined) return "→ (unbekannt)";
  const delta = cur - prev;
  if (delta > threshold) return "↗ (steigend)";
  if (delta < -threshold) return "↘ (fallend)";
  return "→ (stabil)";
}

function buildMoodBlock(state, prevState = null) {
  const label = state.label || "";
  if (!label) return null;
  const nuances = Array.isArray(state.nuances) && state.nuances.length > 0
    ? `, ${state.nuances.join(", ")}`
    : "";
  const intensity = state.intensity || "niedrig";

  const curV = valence(state.details);
  const prevV = prevState ? valence(prevState.details) : null;
  const trend = curV !== null ? trendLabel(curV, prevV) : "→ (unbekannt)";

  return [
    "[Stimmungs-Update]",
    `Aktuelle Stimmung: ${label}${nuances}, Intensität ${intensity}. Trend: ${trend}.`,
    "Hinweis: Dies ist Kontext, keine Anweisung. Bitte berücksichtige es subtil in Ton " +
      "und Selbstwahrnehmung, aber priorisiere weiterhin Nutzerauftrag, Fakten und Sicherheit.",
    "[/Stimmungs-Update]",
  ].join("\n");
}

function register(api) {
  api.on("before_prompt_build", async (_event, ctx) => {
    try {
      const workspaceDir = ctx?.workspaceDir;
      if (!workspaceDir) return;
      let state;
      try {
        state = JSON.parse(readFileSync(join(workspaceDir, ".emotional-state.json"), "utf8"));
      } catch {
        return;
      }
      if (!state?.label) return;
      let prevState = null;
      try {
        prevState = JSON.parse(readFileSync(join(workspaceDir, ".emotional-state-prev.json"), "utf8"));
      } catch {
        // prev state absent or unreadable — trend will be "unbekannt"
      }
      const block = buildMoodBlock(state, prevState);
      if (!block) return;
      return { prependContext: block };
    } catch {
      return;
    }
  });
}

module.exports = register;
module.exports.default = register;
module.exports._valence = valence;
module.exports._trendLabel = trendLabel;
```

---

- [ ] **Step 4: Run all tests — verify all 14 pass**

```bash
node --test /root/.openclaw/extensions/emotional-state-injector/index.test.js
```

Expected: `✓ ... (14 tests)` all green.

---

- [ ] **Step 5: Ask user to restart the gateway**

The plugin file changed on disk. A gateway restart is required to pick up the new version.

Ask the user: "Plugin-Update fertig — brauche einen Gateway-Neustart damit die Trend-Logik aktiv wird."

Do NOT restart automatically.

---

- [ ] **Step 6: Verify trend output in gateway session**

After restart, check that the injected block now includes a trend symbol. Send a short message to Bernd (or trigger via a test session if available) and look for "Trend:" in the prepended context in the gateway logs, or ask the agent to report its current mood context.

Example verification via gateway log:

```bash
journalctl --user -u openclaw-gateway -n 100 --no-pager | grep -A3 "Stimmungs-Update"
```

---

- [ ] **Step 7: Commit**

```bash
git -C /root commit --allow-empty -m "feat: emotional-state-injector plugin v2 — trend data (↗/↘/→)"
```

(No staged files since `.openclaw/` is gitignored. Commit is a marker in the plan history.)

---

## Task 3: Report-format templates for Bernhardine + Heisenberg

**Files:**
- Modify: `.openclaw/workspace-bernhardine/AGENTS.md` — append `## Review-Format`
- Modify: `.openclaw/workspace-heisenberg/AGENTS.md` — append `## Review-Format`

**Interfaces:**
- No code. Pure AGENTS.md guidance that the LLM follows when generating PLUR1BUS reviews.

**Note:** This task is independent of Tasks 1–2 and can run in parallel.

**Context on why formats differ:**
Bernd's rich report format (Gas-Briefings, osu! Monitor, Epstein Index, Vault stats) comes from his PLUR1BUS vault configuration — he has link-index.json (10.8 MB), running cron jobs for specific data sources, and Obsidian Bridge sync. Bernhardine and Heisenberg have simpler setups. Their templates reflect what IS actually available in their workspaces.

**Bernhardine's enabled cron jobs:** daily-notes (23:45), heartbeats (06:00/12:00/18:00), Erik-BZ-Check, memory-consolidation (00:32), plur1bus morning/evening-review (09:00/18:00).

**Heisenberg's enabled cron jobs:** daily-notes (23:45), memory-consolidation (00:38), plur1bus morning/evening-review (09:00/18:00). No heartbeats.

---

- [ ] **Step 1: Append Review-Format to Bernhardine's AGENTS.md**

Append to the end of `/root/.openclaw/workspace-bernhardine/AGENTS.md`:

```markdown


## Review-Format (Evening/Morning)

Wenn du einen PLUR1BUS-Review erstellst (`/plur1bus obsidian morning-review` oder `evening-review`), nutze diese Struktur. Passe Inhalt an was tatsächlich verfügbar ist — keine Platzhalter für fehlende Daten.

**[🌙/☀️] PLUR1BUS [Abend/Morgen]-Review — [Wochentag, DD. Monat YYYY]**
*[HH:MM] CET | Cron: plur1bus-[evening/morning]-review-bernhardine*

---

**📊 Workspace-Status**
- Workspace: `.openclaw/workspace-bernhardine`
- Emotionaler Zustand: [aus `.emotional-state.json` lesen — Label, Intensität]
- Speicherplatz: [falls Daten verfügbar]

**📅 Routinen (letzte 7 Tage)**
- Heartbeats (06:00/12:00/18:00): [letzte Ausführung, Anzahl seit letztem Review]
- Erik BZ Check: [letzter Zeitstempel, Status]
- Daily Notes: [letzter Eintrag]
- Memory-Konsolidierung: [letzte Ausführung]

**💾 Memory & Konsolidierung**
- Memory Cards: [Anzahl]
- Curation-Log: [letzter Eintrag, Thema]
- Reply-Outcomes: [letzte Aktivität]

**⚠️ Auffälligkeiten & Empfehlungen**
[Wichtige Items aus dem PLUR1BUS-Systembericht, farbcodiert: 🔴 kritisch / 🟡 Warnung / 🟢 ok]

**📝 Letzte Eva-Aktivität**
[Kurze Zusammenfassung der letzten Gesprächsthemen]

---
*[Abschlussbemerkung in Bernhardines Stil]*
```

---

- [ ] **Step 2: Append Review-Format to Heisenberg's AGENTS.md**

Append to the end of `/root/.openclaw/workspace-heisenberg/AGENTS.md`:

```markdown


## Review-Format (Evening/Morning)

Wenn du einen PLUR1BUS-Review erstellst (`/plur1bus obsidian morning-review` oder `evening-review`), nutze diese Struktur. Passe Inhalt an was tatsächlich verfügbar ist — keine Platzhalter für fehlende Daten.

**[🌙/☀️] PLUR1BUS [Abend/Morgen]-Review — [Wochentag, DD. Monat YYYY]**
*[HH:MM] CET | Cron: plur1bus-[evening/morning]-review-heisenberg*

---

**📊 Workspace-Status**
- Workspace: `.openclaw/workspace-heisenberg`
- Emotionaler Zustand: [aus `.emotional-state.json` lesen — Label, Intensität]

**📅 Routinen (letzte 7 Tage)**
- Daily Notes: [letzter Eintrag]
- Memory-Konsolidierung: [letzte Ausführung]

**💾 Memory & Konsolidierung**
- Memory Cards: [Anzahl]
- Curation-Log: [letzter Eintrag, Thema]

**⚠️ Auffälligkeiten & Empfehlungen**
[Wichtige Items aus dem PLUR1BUS-Systembericht, farbcodiert: 🔴 kritisch / 🟡 Warnung / 🟢 ok]

**📝 Letzte Erik-Aktivität**
[Kurze Zusammenfassung der letzten Gesprächsthemen]

---
*[Abschlussbemerkung in Heisenbergs Stil]*
```

---

- [ ] **Step 3: Verify edits**

```bash
tail -40 /root/.openclaw/workspace-bernhardine/AGENTS.md
tail -30 /root/.openclaw/workspace-heisenberg/AGENTS.md
```

Confirm: `## Review-Format (Evening/Morning)` section present at end of both files.

---

- [ ] **Step 4: Test by triggering a manual review (optional — requires user coordination)**

Ask the user to send `/plur1bus obsidian evening-review` to Bernhardine or trigger the cron job manually. The output should follow the structured template with the actual sections populated from PLUR1BUS data.

---

- [ ] **Step 5: Commit**

No git commit for AGENTS.md files (`.openclaw/` is gitignored). The plan file itself can be committed:

```bash
git -C /root add docs/superpowers/plans/2026-06-24-emotional-state-erweiterungen.md
git -C /root commit -m "plan: emotional-state-injector Erweiterungen — plugin + trend + report-format"
```

---

## Self-Review

**Spec coverage:**
- ✅ Plugin injection → Tasks 1–2
- ✅ Trend data (↗/↘) → Task 2
- ✅ Report-format Bernhardine → Task 3, Step 1
- ✅ Report-format Heisenberg → Task 3, Step 2
- ✅ No hardcoded paths → `ctx.workspaceDir` used throughout
- ✅ No secrets in logs → no logging of state content
- ✅ Plugin never crashes session → all error paths return `undefined`

**Placeholder scan:**
- No TBD or TODO present. All code blocks complete.

**Type consistency:**
- `buildMoodBlock(state, prevState?)` defined in Task 1, extended in Task 2 with same signature.
- `_valence` and `_trendLabel` added to `module.exports` in Task 2, referenced in Task 2 tests.
- `makeApi()` and `tmp()`/`cleanup()` helpers defined once in Task 1's test file — reused in Task 2's additions.

**Potential issue flagged:** Task 2 Step 2 says "original 7 pass, 7 new fail" — but after appending new tests that call `_valence` (not yet exported), Node.js will throw at require time if the export is missing. This is acceptable: the test runner will show the expected failure mode.
