#!/usr/bin/env node
/**
 * tests/helpers/check-node-pins.mjs — the plugin-dist `node-pins` job (HM2 Task 11, HM2-R16, F33).
 *
 * node tests/helpers/check-node-pins.mjs --pins scripts/dist/node-pins.json --shasums <SHASUMS256.txt> [--lock <hermes-sidecar.lock.json>]
 *
 * Every target in node-pins.json must carry exactly the SHA-256 nodejs.org's SHASUMS256.txt lists for its archive
 * (node-v<version>-<target>.<tar.gz|zip>), the pins must pass render-bootstraps.mjs checkNodePins, and with --lock the
 * pinned version must equal the sidecar lock's nodeVersion. Prints one JSON line; exit 0, or 1 naming every mismatch.
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import { checkNodePins, NODE_TARGETS } from "../../scripts/dist/render-bootstraps.mjs";

/** `<sha256>  <file>` lines → Map(file → sha256). */
export function parseShasums(text) {
  const m = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const r = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (r) m.set(r[2], r[1]);
  }
  return m;
}

/**
 * @param {{ pins: object, shasums: string, lock?: object|null }} a
 * @returns {{ ok: boolean, errors: string[], checked: string[] }}
 */
export function comparePins({ pins, shasums, lock = null }) {
  const errors = [];
  const checked = [];
  try {
    checkNodePins(pins);
  } catch (err) {
    errors.push(err.message);
  }
  const sums = parseShasums(shasums);
  for (const t of NODE_TARGETS) {
    const p = pins.targets?.[t];
    if (!p) continue;
    const file = basename(new URL(p.url).pathname);
    const want = sums.get(file);
    if (!want) errors.push(`${t}: ${file} is not in SHASUMS256.txt`);
    else if (want !== p.sha256) errors.push(`${t}: node-pins.json says ${p.sha256}, nodejs.org says ${want}`);
    else checked.push(t);
  }
  if (lock && lock.nodeVersion !== pins.version) errors.push(`the sidecar lock pins Node ${lock.nodeVersion}, node-pins.json ${pins.version} (F33)`);
  return { ok: errors.length === 0, errors, checked };
}

if (import.meta.filename && resolve(process.argv[1] ?? "") === import.meta.filename) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { pins: { type: "string" }, shasums: { type: "string" }, lock: { type: "string" } } });
    if (!values.pins || !values.shasums) throw new Error("--pins and --shasums are required");
    const pins = JSON.parse(readFileSync(values.pins, "utf8"));
    const r = comparePins({ pins, shasums: readFileSync(values.shasums, "utf8"), lock: values.lock ? JSON.parse(readFileSync(values.lock, "utf8")) : null });
    process.stdout.write(`${JSON.stringify({ ok: r.ok, version: pins.version, checked: r.checked })}\n`);
    if (!r.ok) {
      process.stderr.write(`check-node-pins: ${r.errors.join("\n  ")}\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`check-node-pins: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
