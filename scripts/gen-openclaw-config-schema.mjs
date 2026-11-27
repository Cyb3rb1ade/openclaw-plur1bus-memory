#!/usr/bin/env node
/**
 * scripts/gen-openclaw-config-schema.mjs [--check] [--manifest <path>]
 *
 * Regenerates openclaw.plugin.json `configSchema` and
 * `configContracts.secretInputs.paths` from engine/config/engine-config.schema.json
 * (adapter/openclaw/config-schema.js); every other manifest field is kept as is.
 * The manifest is written as `JSON.stringify(manifest, null, 2)` plus a newline.
 *
 * --check writes nothing: exit 0 when the manifest is byte-identical to the
 * generated result, otherwise print a hint and exit 1.
 * --manifest defaults to the repository's openclaw.plugin.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyEngineSchemaToManifest } from "../adapter/openclaw/config-schema.js";
import { loadEngineConfigSchema } from "../engine/config/engine-config-schema.js";

function parseArgs(argv) {
  const opts = { check: false, manifest: fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url)) };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      opts.check = true;
    } else if (arg === "--manifest" && i + 1 < argv.length) {
      opts.manifest = resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`${err.message}\nusage: gen-openclaw-config-schema.mjs [--check] [--manifest <path>]`);
  process.exit(2);
}

const current = readFileSync(opts.manifest, "utf8");
const next = JSON.stringify(applyEngineSchemaToManifest(JSON.parse(current), loadEngineConfigSchema()), null, 2) + "\n";

if (opts.check) {
  if (current !== next) {
    console.log("openclaw.plugin.json is out of date: run npm run gen:config-schema");
    process.exit(1);
  }
} else if (current !== next) {
  writeFileSync(opts.manifest, next);
}
