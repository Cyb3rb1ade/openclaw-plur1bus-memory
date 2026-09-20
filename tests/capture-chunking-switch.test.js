import { strict as assert } from "node:assert";
import test from "node:test";

import {
  CAPTURE_CHUNKING_CHOICES,
  activeCaptureChunkingId,
  applyControlUiWriteAction,
  captureChunkingChoice,
  createCaptureChunkingMutator,
  createFormTokenStore,
} from "../lib/setup/control-ui-write.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { createControlUiHttpHandler } from "../lib/setup/control-ui-plugin-runtime.js";
import { resolveEffectiveConfig } from "../lib/setup/config-contract.js";

const ids = CAPTURE_CHUNKING_CHOICES.map((choice) => choice.id);

test("bietet genau die drei Speicherweisen an", () => {
  assert.deepEqual(ids.slice().sort(), ["beides", "ganz", "geteilt"]);
  assert.equal(captureChunkingChoice("beides")?.enabled, true);
  assert.equal(captureChunkingChoice("ganz")?.enabled, false);
  assert.equal(captureChunkingChoice("ganz")?.mode, null, "ganz laesst den zuletzt gewaehlten Modus stehen");
  assert.equal(captureChunkingChoice("jev"), null, "eine unbekannte Kennung ist keine Auswahl");
});

test("liest die laufende Weise so, wie der Capture-Pfad sie auslegt", () => {
  // Beide Schluessel fehlen in einer frischen Konfiguration; der Capture-Pfad
  // liest dann captureChunking !== false und captureChunkingMode !== "geteilt".
  assert.equal(activeCaptureChunkingId({}), "beides");
  assert.equal(activeCaptureChunkingId({ captureChunkingMode: "geteilt" }), "geteilt");
  assert.equal(activeCaptureChunkingId({ captureChunking: false }), "ganz");
  assert.equal(
    activeCaptureChunkingId({ captureChunking: false, captureChunkingMode: "geteilt" }),
    "ganz",
    "der Hauptschalter schlaegt den Modus",
  );
});

test("die Projektion meldet die laufende Weise", () => {
  const modeOf = (config) => buildControlPlaneProjection({ config: resolveEffectiveConfig(config) }).captureChunking.mode;
  assert.equal(modeOf({}), "beides");
  assert.equal(modeOf({ captureChunkingMode: "geteilt" }), "geteilt");
  assert.equal(modeOf({ captureChunking: false }), "ganz");
});

test("die Schreib-Aktion nimmt nur bekannte Weisen und nur den vollen Schreibmodus", async () => {
  const calls = [];
  const deps = { setCaptureChunking: async (choice) => { calls.push(choice.id); } };
  const form = new URLSearchParams({ choice: "geteilt" });
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "capture.chunking", form, mode: "off", deps }),
    { ok: false, code: "denied_mode" },
  );
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "capture.chunking", form, mode: "reranker", deps }),
    { ok: false, code: "denied_mode" },
    "der Reranker-Modus schaltet die Speicherweise nicht frei",
  );
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "capture.chunking", form: new URLSearchParams({ choice: "jev" }), mode: "all", deps }),
    { ok: false, code: "denied_choice" },
  );
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "capture.chunking", form, mode: "all", deps: {} }),
    { ok: false, code: "denied_action" },
  );
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "capture.chunking", form, mode: "all", deps }),
    { ok: true, code: "capture_chunking_switched" },
  );
  assert.deepEqual(calls, ["geteilt"], "nur der eine erlaubte Aufruf erreicht den Mutator");
});

test("der Mutator schreibt beide Schluessel und laesst den Rest stehen", async () => {
  const draft = { plugins: { entries: { "memory-lancedb-namespaced": { config: { autoCapture: true, captureChunkingMode: "beides" } } } } };
  const mutate = createCaptureChunkingMutator({
    api: { runtime: { config: { mutateConfigFile: async ({ mutate: fn }) => fn(draft) } } },
  });
  const entry = () => draft.plugins.entries["memory-lancedb-namespaced"].config;

  assert.deepEqual(await mutate(captureChunkingChoice("geteilt")), { mode: "geteilt" });
  assert.equal(entry().captureChunking, true);
  assert.equal(entry().captureChunkingMode, "geteilt");
  assert.equal(entry().autoCapture, true, "andere Einstellungen bleiben unberuehrt");

  await mutate(captureChunkingChoice("ganz"));
  assert.equal(entry().captureChunking, false);
  assert.equal(entry().captureChunkingMode, "geteilt", "die vorige Weise bleibt fuer das Zurueckschalten erhalten");

  await mutate(captureChunkingChoice("beides"));
  assert.equal(entry().captureChunking, true);
  assert.equal(entry().captureChunkingMode, "beides");
});

test("ohne OpenClaws Konfigurationsschreiber gibt es keinen Schalter", () => {
  assert.throws(() => createCaptureChunkingMutator({ api: {} }), /mutateConfigFile/);
});

test("das Schema kennt beide Schluessel, die der Mutator schreibt", async () => {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const props = manifest.configSchema.properties;
  assert.equal(props.captureChunking.type, "boolean");
  assert.deepEqual(props.captureChunkingMode.enum.slice().sort(), ["beides", "geteilt"]);
  for (const choice of CAPTURE_CHUNKING_CHOICES) {
    if (choice.mode) assert.ok(props.captureChunkingMode.enum.includes(choice.mode), `${choice.id} ist im Schema erlaubt`);
  }
});

function collectingResponse() {
  const headers = new Map();
  return {
    statusCode: 0, body: "", headers,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(body = "") { this.body = body; },
  };
}

const htmlFor = async (config, write) => {
  const handler = createControlUiHttpHandler({
    getProjection: async () => buildControlPlaneProjection({ config: resolveEffectiveConfig(config) }),
    ...(write ? { write } : {}),
  });
  const res = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control" }, res);
  assert.equal(res.statusCode, 200);
  return String(res.body);
};

test("die Capture-Karte zeigt den Schalter mit der laufenden Weise", async () => {
  const html = await htmlFor({ captureChunkingMode: "geteilt" }, {
    mode: "all", tokens: createFormTokenStore(), applyAction: async () => ({ ok: true, code: "capture_chunking_switched" }),
  });
  assert.match(html, /<legend>Storage mode<\/legend>/);
  assert.match(html, /name="choice" value="ganz"/);
  assert.match(html, /name="choice" value="beides"/);
  assert.doesNotMatch(html, /name="choice" value="geteilt"/, "die laufende Weise hat keinen Schaltknopf");
  assert.match(html, /value="capture\.chunking"/);
  // Der Schalter gehoert auf die Capture-Karte, nicht auf jede.
  assert.equal(html.split("<legend>Storage mode</legend>").length - 1, 1);
});

test("ohne Schreibrecht zeigt die Karte die Weisen, aber kein Formular dafuer", async () => {
  const html = await htmlFor({});
  assert.match(html, /<legend>Storage mode<\/legend>/);
  assert.doesNotMatch(html, /value="capture\.chunking"/);
  assert.match(html, /controlUi\.writeActions/);
});
