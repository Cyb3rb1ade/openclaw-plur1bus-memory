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
    assert.ok(result?.prependContext?.includes("Füge am Beginn"), "display instruction missing");
  } finally { cleanup(dir); }
});

test("joy dominant → 😊 emoji in display line", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "fröhlich", dominant: "joy", intensity: "hoch", nuances: [], details: {}
    }));
    const result = await handler()({}, { workspaceDir: dir });
    assert.ok(result?.prependContext?.includes("😊"), "joy emoji missing");
    assert.ok(result?.prependContext?.includes("<i>Stimmung:"), "display line missing");
  } finally { cleanup(dir); }
});

test("trust dominant → 🤝 emoji in display line", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "vertrauensvoll", dominant: "trust", intensity: "mittel", nuances: [], details: {}
    }));
    const result = await handler()({}, { workspaceDir: dir });
    assert.ok(result?.prependContext?.includes("🤝"), "trust emoji missing");
  } finally { cleanup(dir); }
});

test("unknown dominant → 😌 fallback emoji", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "eigenartig", dominant: "unknown_emotion", intensity: "niedrig", nuances: [], details: {}
    }));
    const result = await handler()({}, { workspaceDir: dir });
    assert.ok(result?.prependContext?.includes("😌"), "fallback emoji missing");
  } finally { cleanup(dir); }
});

test("null dominant → 😌 fallback emoji", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "ausgeglichen", intensity: "niedrig", nuances: [], details: {}
    }));
    const result = await handler()({}, { workspaceDir: dir });
    assert.ok(result?.prependContext?.includes("😌"), "null dominant fallback emoji missing");
  } finally { cleanup(dir); }
});

test("display line contains intensity", async () => {
  const { api, handler } = makeApi();
  register(api);
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".emotional-state.json"), JSON.stringify({
      label: "fröhlich", dominant: "joy", intensity: "hoch", nuances: [], details: {}
    }));
    const result = await handler()({}, { workspaceDir: dir });
    assert.ok(result?.prependContext?.includes("hoch"), "intensity missing from display line");
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
