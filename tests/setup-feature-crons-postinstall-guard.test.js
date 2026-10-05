// tests/setup-feature-crons-postinstall-guard.test.js — der npm-postinstall darf in einem
// Dev-Checkout/CI keine echten Cron-Jobs verändern.
//
// Safety: `openclaw` ist immer ein Stub im temporären PATH, nie die echte CLI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSyncBounded } from "./helpers/run-sync.js";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers/temp-dir.js";
import { postinstallSkipReason } from "../scripts/setup-feature-crons.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = { timeout: 30_000 };
const posixOnly = { ...T, skip: process.platform === "win32" && "Stub-Binary braucht POSIX-PATH-Auflösung" };

/** Paket-Kopie (scripts + lib) im Temp-Verzeichnis, optional mit `.git`, plus `openclaw`-Stub. */
function fixture(prefix, { git }) {
  const base = makeTempDir(prefix);
  const pkg = join(base, "pkg");
  mkdirSync(pkg);
  for (const d of ["scripts", "lib"]) cpSync(join(REPO, d), join(pkg, d), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  symlinkSync(join(REPO, "node_modules"), join(pkg, "node_modules"), "dir");
  if (git) mkdirSync(join(pkg, ".git"));
  const bin = join(base, "bin");
  mkdirSync(bin);
  const calls = join(base, "calls.log");
  const stub = join(bin, "openclaw");
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${calls}"\nexit 1\n`);
  chmodSync(stub, 0o755);
  return { base, pkg, bin, calls };
}

function runPostinstall(fx, env) {
  const clean = { ...process.env };
  for (const k of ["CI", "INIT_CWD", "PLUR1BUS_SETUP_CRONS", "npm_lifecycle_event"]) delete clean[k];
  return spawnSyncBounded(process.execPath, [join(fx.pkg, "scripts", "setup-feature-crons.mjs")], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...clean, PATH: `${fx.bin}:${dirname(process.execPath)}`, npm_lifecycle_event: "postinstall", ...env },
  });
}

const called = (fx) => existsSync(fx.calls) && readFileSync(fx.calls, "utf8").length > 0;

describe("setup-feature-crons postinstall guard (Prozess, openclaw-Stub)", () => {
  it("Dev-Checkout (INIT_CWD = Root, .git vorhanden): Stub nicht aufgerufen, exit 0", posixOnly, () => {
    const fx = fixture("sfc-guard-dev-", { git: true });
    const r = runPostinstall(fx, { INIT_CWD: fx.pkg });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[setup-feature-crons\] skipped: development checkout/);
    assert.equal(called(fx), false);
  });

  it("CI=true ohne Opt-in: Stub nicht aufgerufen", posixOnly, () => {
    const fx = fixture("sfc-guard-ci-", { git: false });
    const r = runPostinstall(fx, { CI: "true", INIT_CWD: join(fx.base, "project") });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skipped: CI/);
    assert.equal(called(fx), false);
  });

  it("Opt-in PLUR1BUS_SETUP_CRONS=1 läuft auch im Dev-Checkout", posixOnly, () => {
    const fx = fixture("sfc-guard-optin-", { git: true });
    const r = runPostinstall(fx, { INIT_CWD: fx.pkg, PLUR1BUS_SETUP_CRONS: "1", CI: "true" });
    assert.equal(r.status, 0);
    assert.equal(called(fx), true);
  });

  it("Dependency-Install (INIT_CWD = fremdes Projekt, kein .git): läuft wie bisher", posixOnly, () => {
    const fx = fixture("sfc-guard-dep-", { git: false });
    const r = runPostinstall(fx, { INIT_CWD: join(fx.base, "project") });
    assert.equal(r.status, 0);
    assert.equal(called(fx), true);
  });

  it("Entpacktes Paket mit npm install im Paketordner (INIT_CWD = Root, kein .git): läuft", posixOnly, () => {
    const fx = fixture("sfc-guard-unpacked-", { git: false });
    const r = runPostinstall(fx, { INIT_CWD: fx.pkg });
    assert.equal(r.status, 0);
    assert.equal(called(fx), true);
  });

  it("ohne postinstall-Lifecycle (Bootstrap/Slash-Command) läuft das Skript auch im Dev-Checkout", posixOnly, () => {
    const fx = fixture("sfc-guard-manual-", { git: true });
    const r = runPostinstall(fx, { INIT_CWD: fx.pkg, npm_lifecycle_event: "" });
    assert.equal(r.status, 0);
    assert.equal(called(fx), true);
  });
});

describe("postinstallSkipReason (Matrix)", () => {
  const root = makeTempDir("sfc-guard-unit-");
  mkdirSync(join(root, ".git"));
  const noGit = makeTempDir("sfc-guard-unit-nogit-");
  const base = { npm_lifecycle_event: "postinstall" };

  it("klassifiziert die Fälle", T, () => {
    assert.equal(postinstallSkipReason({ env: { ...base, INIT_CWD: root }, packageRoot: root }), "development-checkout");
    assert.equal(postinstallSkipReason({ env: { ...base, INIT_CWD: noGit }, packageRoot: root }), null);
    assert.equal(postinstallSkipReason({ env: { ...base, INIT_CWD: noGit }, packageRoot: noGit }), null);
    assert.equal(postinstallSkipReason({ env: { ...base, CI: "true" }, packageRoot: noGit }), "ci");
    assert.equal(postinstallSkipReason({ env: { ...base, CI: "true", PLUR1BUS_SETUP_CRONS: "1" }, packageRoot: noGit }), null);
    assert.equal(postinstallSkipReason({ env: { INIT_CWD: root }, packageRoot: root }), null);
  });
});
