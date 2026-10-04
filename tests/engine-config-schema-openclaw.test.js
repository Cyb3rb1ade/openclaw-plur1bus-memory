/**
 * tests/engine-config-schema-openclaw.test.js — E5 Task 4: openclaw.plugin.json's
 * configSchema and configContracts.secretInputs.paths are generated from
 * engine/config/engine-config.schema.json (scripts/gen-openclaw-config-schema.mjs),
 * and --check catches drift.
 *
 * The owner's VPS runs this plugin, so the generated configSchema must validate
 * exactly as the pre-E5 manifest did: the last test compares it with the manifest
 * at 72b6697f (the E5 base) after stripping only descriptions and annotation
 * keywords, and checks that every other manifest field is unchanged. The one
 * allowed schema addition is runtime.lancedbCompaction (E5 Task 6); the one
 * allowed change elsewhere is five new sensitive uiHints (owner ruling on
 * E5-R24: the four `*.headers` maps and reminders.webhookUrl are masked, but
 * secretInputs keeps its eight paths).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENGINE_ONLY_KEYWORDS,
  ENGINE_ONLY_ROOT_KEYS,
  applyEngineSchemaToManifest,
  deriveOpenClawConfigSchema,
  deriveSecretInputPaths,
} from "../adapter/openclaw/config-schema.js";
import { loadEngineConfigSchema, readAtOf, secretInputPaths, sensitivePaths } from "../engine/config/engine-config-schema.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_FILE = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/gen-openclaw-config-schema.mjs", import.meta.url));
const PRE_E5_COMMIT = "72b6697f";

const readManifest = (file = MANIFEST_FILE) => JSON.parse(readFileSync(file, "utf8"));
const runGenerator = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });

const SECRET_INPUTS = [
  "embedding.apiKey",
  "embedding.fallback.apiKey",
  "reranker.apiKey",
  "merging.apiKey",
  "schicht15.apiKey",
  "skillMiner.apiKey",
  "criticalPush.apiKey",
  "emotion.t3.apiKey",
];
// x-sensitive but not a secret input (E5-R24 owner ruling): masked, plain values only.
const SENSITIVE_PLAIN = [
  "reminders.webhookUrl",
  "merging.headers",
  "schicht15.headers",
  "skillMiner.headers",
  "criticalPush.headers",
];

/** Deep copy without `description` and the engine-only keywords, in every object node. */
function stripAnnotations(node) {
  if (Array.isArray(node)) return node.map(stripAnnotations);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" || ENGINE_ONLY_KEYWORDS.includes(key)) continue;
    out[key] = stripAnnotations(value);
  }
  return out;
}

describe("openclaw.plugin.json generated from engine-config.schema.json", () => {
  it("the manifest configSchema is derived from the engine schema", () => {
    const manifest = readManifest();
    assert.deepStrictEqual(manifest.configSchema, deriveOpenClawConfigSchema(loadEngineConfigSchema()));
    const text = JSON.stringify(manifest.configSchema);
    for (const word of ["readAt", "x-tier", "x-sensitive", "x-contract"]) {
      assert.ok(!text.includes(word), `configSchema must not contain ${word}`);
    }
    for (const key of ENGINE_ONLY_ROOT_KEYS) assert.ok(!Object.hasOwn(manifest.configSchema, key), key);
    assert.equal(Object.keys(manifest.configSchema.properties).length, 56);
  });

  it("secretInputs follow the $ref secretInput nodes, not every x-sensitive path", () => {
    const schema = loadEngineConfigSchema();
    const paths = readManifest().configContracts.secretInputs.paths;
    assert.deepStrictEqual(paths, deriveSecretInputPaths(schema));
    assert.deepStrictEqual(paths, SECRET_INPUTS.map((path) => ({ path, expected: "string" })));
    assert.deepStrictEqual(paths.map((e) => e.path), secretInputPaths(schema));
    const declared = new Set(paths.map((e) => e.path));
    for (const path of SENSITIVE_PLAIN) {
      assert.ok(sensitivePaths(schema).includes(path), `${path} is x-sensitive`);
      assert.ok(!declared.has(path) && !declared.has(`${path}.*`), `${path} must not be a SecretRef surface`);
    }
  });

  it("uiHints sensitive flags agree with x-sensitive", () => {
    const { uiHints } = readManifest();
    const flagged = Object.entries(uiHints).filter(([, hint]) => hint.sensitive === true).map(([key]) => key);
    assert.deepStrictEqual(flagged, sensitivePaths());
    for (const key of Object.keys(uiHints)) assert.notEqual(readAtOf(key), null, `uiHints key ${key} is not in the schema`);
  });

  it("--check passes on the repository and fails on a drifted copy", () => {
    const clean = runGenerator(["--check"]);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);

    const copy = join(makeTempDir("plur1bus-manifest-"), "openclaw.plugin.json");
    copyFileSync(MANIFEST_FILE, copy);
    const drifted = readManifest(copy);
    drifted.configSchema.properties.gc.default = "x";
    writeFileSync(copy, JSON.stringify(drifted, null, 2) + "\n");

    const check = runGenerator(["--check", "--manifest", copy]);
    assert.equal(check.status, 1);
    assert.match(check.stdout, /out of date/);
    assert.deepStrictEqual(readManifest(copy), drifted, "--check must not write");

    const fix = runGenerator(["--manifest", copy]);
    assert.equal(fix.status, 0, fix.stdout + fix.stderr);
    assert.equal(readFileSync(copy, "utf8"), readFileSync(MANIFEST_FILE, "utf8"));
    assert.equal(runGenerator(["--check", "--manifest", copy]).status, 0);
  });

  it("deriving is idempotent and leaves the input untouched", () => {
    const schema = loadEngineConfigSchema();
    const first = deriveOpenClawConfigSchema(schema);
    assert.deepStrictEqual(deriveOpenClawConfigSchema(schema), first);
    assert.ok(!Object.isFrozen(first), "the derived schema is a copy");
    assert.ok(Object.isFrozen(schema) && Object.isFrozen(schema.properties.gc));
    assert.equal(schema.properties.gc.readAt, "construction");
    assert.deepStrictEqual(Object.keys(first), ["$defs", "type", "additionalProperties", "properties"]);

    const manifest = readManifest();
    assert.deepStrictEqual(applyEngineSchemaToManifest(manifest, schema), manifest);
    assert.deepStrictEqual(Object.keys(applyEngineSchemaToManifest(manifest, schema)), Object.keys(manifest));
  });

  it("the generated manifest validates exactly as the pre-E5 manifest did", (t) => {
    const git = spawnSync("git", ["show", `${PRE_E5_COMMIT}:openclaw.plugin.json`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (git.status !== 0) {
      t.skip(`git show ${PRE_E5_COMMIT} unavailable (shallow clone?)`);
      return;
    }
    const before = JSON.parse(git.stdout);
    const after = readManifest();
    // Allow-list of schema additions since 72b6697f (E5-R25): exactly
    // runtime.lancedbCompaction (E5 Task 6), and from the merged health-watch
    // release line healthWatch (7.18.0) and runtime.detachPostTurnWork
    // (7.18.3). Anything else must still match.
    const afterSchema = structuredClone(after.configSchema);
    assert.ok(Object.hasOwn(afterSchema.properties.runtime.properties, "lancedbCompaction"));
    delete afterSchema.properties.runtime.properties.lancedbCompaction;
    assert.ok(Object.hasOwn(afterSchema.properties.runtime.properties, "detachPostTurnWork"));
    delete afterSchema.properties.runtime.properties.detachPostTurnWork;
    assert.ok(Object.hasOwn(afterSchema.properties.runtime.properties, "traceRegistrations"));
    delete afterSchema.properties.runtime.properties.traceRegistrations;
    assert.ok(Object.hasOwn(afterSchema.properties, "healthWatch"));
    delete afterSchema.properties.healthWatch;

    assert.deepStrictEqual(stripAnnotations(afterSchema), stripAnnotations(before.configSchema));
    assert.deepStrictEqual(Object.keys(afterSchema.properties), Object.keys(before.configSchema.properties));

    assert.deepStrictEqual(Object.keys(after), Object.keys(before));
    // Allow-list of uiHints additions since 72b6697f (E5-R24 owner ruling):
    // exactly the five plain-only sensitive paths, each sensitive and advanced.
    const afterHints = structuredClone(after.uiHints);
    for (const path of SENSITIVE_PLAIN) {
      assert.ok(!Object.hasOwn(before.uiHints, path), `${path} was not hinted before`);
      assert.equal(afterHints[path]?.sensitive, true, path);
      assert.equal(afterHints[path]?.advanced, true, path);
      delete afterHints[path];
    }
    assert.deepStrictEqual(afterHints, before.uiHints);
    assert.deepStrictEqual(Object.keys(afterHints), Object.keys(before.uiHints));
    // Allow-list of cliCommands additions since 72b6697f (HM1-R5): exactly
    // the maintenance root `plur1bus` (`openclaw plur1bus selftest`).
    const selftestRoot = after.cliCommands.filter((entry) => entry.name === "plur1bus");
    assert.deepStrictEqual(selftestRoot, [{ name: "plur1bus", description: "PLUR1BUS maintenance commands (selftest)", hasSubcommands: true }]);
    const afterCli = after.cliCommands.filter((entry) => entry.name !== "plur1bus");
    // The release version moves with every release (HM1 Task 10); it must equal package.json, nothing else.
    assert.equal(after.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    for (const key of Object.keys(before)) {
      if (key === "configSchema" || key === "uiHints" || key === "version") continue;
      assert.deepStrictEqual(key === "cliCommands" ? afterCli : after[key], before[key], `manifest field ${key} changed`);
    }
  });
});
