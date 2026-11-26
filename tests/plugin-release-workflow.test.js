import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers/temp-dir.js";

const readRepoFile = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const WORKFLOW = ".github/workflows/plugin-release.yml";

// Schneidet einen Job aus dem Workflow: von `  <name>:` bis zum naechsten Job
// auf derselben Einrueckung oder bis zum Dateiende. Bewusst ohne YAML-Parser,
// `yaml` ist nur eine transitive Dev-Abhaengigkeit von `openclaw`.
function jobBlock(text, name) {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `Job ${name} fehlt in ${WORKFLOW}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-z][a-z0-9-]*:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// Der Kopfkommentar: alle Kommentarzeilen vor dem ersten Schluessel nach `name:`.
function headerComment(text) {
  const lines = text.split("\n");
  const end = lines.findIndex((line, i) => i > 0 && /^[a-z]/.test(line));
  return lines
    .slice(0, end)
    .filter((line) => line.startsWith("#"))
    .join("\n");
}

// Bis 7.21.4 lud der Release-Workflow nach GitHub Packages nichts hoch; jede
// Version wurde von Hand aus dem Release-Tarball veroeffentlicht (eigene
// userconfig, absoluter Pfad, weil /root/.npmrc den Scope auf ClawHub lenkt).
// Der Job github-packages macht das jetzt mit dem automatischen Token.
test("github-packages runs after the GitHub Release and only in a real run", () => {
  const job = jobBlock(readRepoFile(WORKFLOW), "github-packages");

  const needs = job.match(/^ {4}needs:\s*\[([^\]]*)\]\s*$/m);
  assert.ok(needs, "github-packages braucht eine needs-Liste");
  const needed = needs[1].split(",").map((s) => s.trim());
  for (const dep of ["check", "pack", "github-release"]) {
    assert.ok(needed.includes(dep), `github-packages muss auf ${dep} warten`);
  }
  assert.match(job, /^ {4}if: needs\.check\.outputs\.dry-run != 'true'\s*$/m);
  // Kein Environment und keine Repo-Variable: GitHub Packages ist nicht abschaltbar wie npmjs.
  assert.doesNotMatch(job, /^ {4}environment:/m);
});

test("github-packages gets contents: read and packages: write, nothing else", () => {
  const job = jobBlock(readRepoFile(WORKFLOW), "github-packages");
  const perms = job.match(/^ {4}permissions:\n((?: {6}.+\n?)+)/m);
  assert.ok(perms, "github-packages braucht einen permissions-Block");
  const entries = perms[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(entries, ["contents: read", "packages: write"]);
  // Ohne id-token versucht npm 11 keinen OIDC-Austausch; Provenienz kommt aus dem attest-Job.
  assert.doesNotMatch(job, /id-token:/);
  assert.doesNotMatch(job, /contents:\s*write/);
  assert.doesNotMatch(job, /attestations:/);
});

test("the token comes from github.token and is only expanded by npm, never written", () => {
  const workflow = readRepoFile(WORKFLOW);
  const job = jobBlock(workflow, "github-packages");

  // "Secrets used: none" im Kopf muss stimmen.
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.match(job, /^ {10}NODE_AUTH_TOKEN: \$\{\{ github\.token \}\}\s*$/m);

  // Die userconfig nennt nur die Variable, in einfachen Anfuehrungszeichen.
  assert.ok(
    job.includes("'//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}'"),
    "der authToken-Eintrag muss die Variable woertlich enthalten",
  );
  assert.match(job, /^ {10}umask 077\s*$/m);
  for (const line of job.split("\n")) {
    if (!line.includes("NODE_AUTH_TOKEN")) continue;
    assert.ok(
      /^ {10}NODE_AUTH_TOKEN: \$\{\{ github\.token \}\}\s*$/.test(line) ||
        line.includes("'//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}'"),
      `NODE_AUTH_TOKEN ausserhalb von env und userconfig: ${line.trim()}`,
    );
  }
});

test("every registry call is routed to npm.pkg.github.com, whatever the host npmrc says", () => {
  const job = jobBlock(readRepoFile(WORKFLOW), "github-packages");

  assert.ok(job.includes("'@cyb3rb1ade:registry=https://npm.pkg.github.com'"));
  // --registry allein reicht nicht: ein @scope:registry in einer npmrc schlaegt es.
  assert.match(
    job,
    /gpr\(\) \{ npm --userconfig "\$npmrc" --@cyb3rb1ade:registry=https:\/\/npm\.pkg\.github\.com "\$@"; \}/,
  );
  assert.match(job, /gpr config get @cyb3rb1ade:registry\)" = https:\/\/npm\.pkg\.github\.com \]/);
  // Kein npm-Aufruf, der die Registry beruehrt, an gpr() vorbei.
  assert.doesNotMatch(job, /(^\s*|[;&|]\s*|\$\()npm (publish|view|dist-tag|unpublish|deprecate)\b/m);
  // setup-node schreibt ohne registry-url keine eigene npmrc.
  assert.doesNotMatch(job, /registry-url:/);
  assert.doesNotMatch(job, /registry\.npmjs\.org/);
  assert.doesNotMatch(job, /--provenance/);
  assert.doesNotMatch(job, /--access/);
});

test("github-packages publishes the release tarball by absolute path", () => {
  const job = jobBlock(readRepoFile(WORKFLOW), "github-packages");

  assert.match(job, /^ {10}tgz="\$RUNNER_TEMP\/release\/\$TGZ"\s*$/m);
  assert.match(job, /gpr publish "\$tgz" --tag "\$dist_tag" --ignore-scripts/);
  assert.doesNotMatch(job, /publish\s+"?\.\//);
  assert.doesNotMatch(job, /publish\s+"?\$TGZ/);
  // Dasselbe Artefakt wie das Release: SHA256SUMS lokal und gegen das Release-Asset.
  assert.match(job, /^ {10}sha256sum -c SHA256SUMS\s*$/m);
  assert.match(job, /gh release download "v\$VERSION" .*--pattern SHA256SUMS/);
  assert.match(job, /cmp SHA256SUMS "\$RUNNER_TEMP\/release-SHA256SUMS"/);
  assert.match(job, /actions\/download-artifact@/);
  assert.match(job, /name: \$\{\{ needs\.pack\.outputs\.artifact \}\}/);
  assert.doesNotMatch(job, /npm pack/);
});

test("an existing version is skipped only with the same integrity, a new one is read back", () => {
  const job = jobBlock(readRepoFile(WORKFLOW), "github-packages");

  // `npm view pkg@x.y.z` endet bei fehlender Version mit E404 = rc 1, deshalb die Versionsliste.
  assert.match(job, /gpr view "\$PKG" versions --json/);
  assert.match(job, /createHash\("sha512"\)/);
  assert.match(job, /gpr view "\$PKG@\$VERSION" dist\.integrity/);
  const compare = job.match(/\[ "\$remote" = "\$local_integrity" \]/g) || [];
  // vorhanden, gleichzeitiger Publish, Rueckleseprobe
  assert.ok(compare.length >= 3, `nur ${compare.length} Integritaetsvergleiche`);
  assert.match(job, /::error::\$PKG@\$VERSION is already on GitHub Packages with another tarball/);
  assert.match(job, /::error::published integrity/);
  // Der Kanal bestimmt den dist-tag wie bei npm-publish.
  assert.match(job, /stable\) dist_tag=latest ;; beta\) dist_tag=beta ;;/);
});

// Das explizite --tag schaltet npm 11 die eigenen Sperren ab (Vorabversion und
// niedrigere Version unter dem Standard-Tag). Ein Tag-Push laeuft immer als
// stable, auch v7.22.0-beta.1 oder v7.18.32-jev.1; ohne eigene Sperre landete
// so etwas als `latest` auf GitHub Packages.
test("latest only moves up to a plain x.y.z, checked by the job itself", () => {
  const job = jobBlock(readRepoFile(WORKFLOW), "github-packages");
  const script = publishScript(job);

  const prerelease = script.indexOf(
    'if [ "$dist_tag" = latest ] && ! [[ "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
  );
  assert.ok(prerelease >= 0, "Sperre gegen Vorabversionen unter latest fehlt");
  // Vor jedem Registry-Zugriff.
  assert.ok(prerelease < script.indexOf("npm --version"), "Vorabversions-Sperre kommt zu spaet");
  assert.match(script, /::error::\$VERSION is a prerelease on the stable channel/);

  const backport = script.indexOf("would move latest backwards");
  assert.ok(backport >= 0, "Sperre gegen Rueckportierungen unter latest fehlt");
  // Nach der Vorhanden-Pruefung (ein Re-run bleibt gruen), vor dem Publish.
  assert.ok(backport > script.indexOf('if [ "$present" = yes ]; then'));
  assert.ok(backport < script.indexOf("gpr publish"));
  assert.doesNotMatch(script, /sort -V/);
});

test("a failed publish is read back with lag tolerance and explains E403", () => {
  const script = publishScript(jobBlock(readRepoFile(WORKFLOW), "github-packages"));

  assert.match(script, /^read_back\(\) \{$/m);
  const failure = script.slice(script.indexOf("if ! gpr publish"));
  assert.match(failure, /remote=\$\(read_back\)/);
  assert.match(failure, /::error::publishing \$PKG@\$VERSION failed; on E403 .*Manage Actions access.*Re-run failed jobs/);
  // Jeder Ausstieg mit Fehler traegt eine Annotation.
  for (const [i, line] of script.split("\n").entries()) {
    if (!/\bexit 1\b/.test(line)) continue;
    const context = script.split("\n").slice(Math.max(0, i - 1), i + 1).join("\n");
    assert.match(context, /::error::/, `exit 1 ohne ::error:: bei: ${line.trim()}`);
  }
});

// --- Verhalten des Publish-Schritts mit einem falschen npm ---------------------

const PKG = "@cyb3rb1ade/plur1bus-memory";
const FAKE_TOKEN = "fake-token-for-the-test";

// Der run-Block des Schritts "Publish to GitHub Packages", ohne Einrueckung.
function publishScript(job) {
  const lines = job.split("\n");
  const step = lines.findIndex((line) => line === "      - name: Publish to GitHub Packages");
  assert.ok(step >= 0, "Schritt Publish to GitHub Packages fehlt");
  const run = lines.findIndex((line, i) => i > step && line === "        run: |");
  assert.ok(run > step, "run-Block des Publish-Schritts fehlt");
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

// Ein npm, das nur die Aufrufe des Schritts kennt. Zustand in registry.json:
// { versions: { "<version>": "<integrity>" }, publish: "ok" | "e403" | "landed-then-error" }.
const FAKE_NPM = String.raw`
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const state = process.env.FAKE_NPM_STATE;
const file = path.join(state, "registry.json");
const reg = JSON.parse(fs.readFileSync(file, "utf8"));
const args = [];
const raw = process.argv.slice(2);
for (let i = 0; i < raw.length; i += 1) {
  if (raw[i] === "--userconfig") { i += 1; continue; }
  if (raw[i] === "--@cyb3rb1ade:registry=https://npm.pkg.github.com") continue;
  args.push(raw[i]);
}
fs.appendFileSync(path.join(state, "calls.log"), JSON.stringify(args) + "\n");
const [cmd, a1, a2, a3] = args;
if (cmd === "--version") { console.log("11.0.0-fake"); process.exit(0); }
if (cmd === "config" && a1 === "get" && a2 === "@cyb3rb1ade:registry") {
  console.log("https://npm.pkg.github.com");
  process.exit(0);
}
if (cmd === "view" && a2 === "versions" && a3 === "--json") {
  console.log(JSON.stringify(Object.keys(reg.versions)));
  process.exit(0);
}
if (cmd === "view" && a2 === "dist.integrity") {
  const v = a1.slice(a1.lastIndexOf("@") + 1);
  if (reg.versions[v]) { console.log(reg.versions[v]); process.exit(0); }
  console.error("npm error code E404");
  process.exit(1);
}
if (cmd === "publish") {
  const integrity = "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(a1)).digest("base64");
  if (reg.publish === "e403") { console.error("npm error code E403"); process.exit(1); }
  reg.versions[process.env.VERSION] = integrity;
  fs.writeFileSync(file, JSON.stringify(reg));
  process.exit(reg.publish === "landed-then-error" ? 1 : 0);
}
console.error("fake npm: unexpected call " + JSON.stringify(args));
process.exit(2);
`;

const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function runPublish({ version, channel = "stable", versions = {}, publish = "ok", sameBytesAs = null }) {
  const script = publishScript(jobBlock(readRepoFile(WORKFLOW), "github-packages"));
  const root = makeTempDir("plugin-release-gpr-");
  try {
    const runnerTemp = join(root, "runner");
    const release = join(runnerTemp, "release");
    const bin = join(root, "bin");
    const state = join(root, "state");
    for (const dir of [release, bin, state]) mkdirSync(dir, { recursive: true });

    const tgz = `cyb3rb1ade-plur1bus-memory-${version}.tgz`;
    const bytes = Buffer.from(`fake tarball ${version}\n`);
    writeFileSync(join(release, tgz), bytes);
    const registry = { ...versions };
    if (sameBytesAs) registry[sameBytesAs] = integrityOf(bytes);
    writeFileSync(join(state, "registry.json"), JSON.stringify({ versions: registry, publish }));

    writeFileSync(join(bin, "fake-npm.cjs"), FAKE_NPM);
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-npm.cjs")}" "$@"\n`,
    );
    // Die Rueckleseprobe wartet 3 x 5 s; hier zaehlt nur, wie oft.
    writeFileSync(join(bin, "sleep"), `#!/bin/sh\necho "$1" >> "${join(state, "sleep.log")}"\n`);
    chmodSync(join(bin, "npm"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    writeFileSync(join(root, "publish.sh"), script);

    const result = spawnSync("bash", [join(root, "publish.sh")], {
      cwd: release,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
        HOME: root,
        RUNNER_TEMP: runnerTemp,
        VERSION: version,
        CHANNEL: channel,
        TGZ: tgz,
        PKG,
        NODE_AUTH_TOKEN: FAKE_TOKEN,
        FAKE_NPM_STATE: state,
      },
    });
    const read = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8") : "");
    const calls = read("calls.log").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const npmrc = join(runnerTemp, "github-packages.npmrc");
    return {
      status: result.status,
      out: `${result.stdout}${result.stderr}`,
      calls,
      publishes: calls.filter((call) => call[0] === "publish"),
      sleeps: read("sleep.log").split("\n").filter(Boolean).length,
      registry: JSON.parse(read("registry.json")).versions,
      tgzPath: join(release, tgz),
      bytes,
      npmrc: existsSync(npmrc) ? { text: readFileSync(npmrc, "utf8"), mode: statSync(npmrc).mode } : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const bashOnly = {
  skip: process.platform === "win32" && "the release workflow's run blocks are bash on ubuntu-24.04; not run on Windows",
};

test("publish step: a new x.y.z above the highest becomes latest and is read back", bashOnly, () => {
  const r = runPublish({
    version: "7.21.5",
    // Eine hoehere Vorabversion zaehlt nicht fuer latest.
    versions: { "7.21.4": "sha512-old", "7.22.0-hermes.0": "sha512-side" },
  });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.publishes, [["publish", r.tgzPath, "--tag", "latest", "--ignore-scripts"]]);
  assert.equal(r.registry["7.21.5"], integrityOf(r.bytes));
  assert.match(r.out, /published @cyb3rb1ade\/plur1bus-memory@7\.21\.5 to GitHub Packages \(dist-tag latest\)/);
  // Die userconfig nennt nur die Variable, nur fuer den Eigentuemer lesbar.
  assert.ok(r.npmrc.text.includes("_authToken=${NODE_AUTH_TOKEN}"));
  assert.ok(!r.npmrc.text.includes(FAKE_TOKEN));
  assert.equal(r.npmrc.mode & 0o077, 0);
});

test("publish step: a prerelease on the stable channel never becomes latest", bashOnly, () => {
  for (const version of ["7.22.0-beta.1", "7.18.32-jev.3", "7.21.5-hermes.0"]) {
    const r = runPublish({ version, versions: { "7.21.4": "sha512-old" } });
    assert.equal(r.status, 1, `${version}: ${r.out}`);
    assert.match(r.out, new RegExp(`::error::${version.replace(/\./g, "\\.")} is a prerelease on the stable channel`));
    // Abgelehnt, bevor npm ueberhaupt laeuft.
    assert.deepEqual(r.calls, [], version);
  }
});

test("publish step: the beta channel publishes under beta, also below the highest x.y.z", bashOnly, () => {
  for (const version of ["7.22.0-beta.1", "7.20.11"]) {
    const r = runPublish({ version, channel: "beta", versions: { "7.21.4": "sha512-old" } });
    assert.equal(r.status, 0, `${version}: ${r.out}`);
    assert.deepEqual(r.publishes, [["publish", r.tgzPath, "--tag", "beta", "--ignore-scripts"]]);
  }
});

test("publish step: a backport below the highest x.y.z does not move latest back", bashOnly, () => {
  const r = runPublish({ version: "7.20.11", versions: { "7.20.10": "sha512-a", "7.21.4": "sha512-b" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::@cyb3rb1ade\/plur1bus-memory@7\.21\.4 is already on GitHub Packages; publishing 7\.20\.11 as latest would move latest backwards/);
  assert.deepEqual(r.publishes, []);
  // Zahlen, nicht Text: 7.9.0 liegt unter 7.10.0.
  const numeric = runPublish({ version: "7.10.0", versions: { "7.9.0": "sha512-a" } });
  assert.equal(numeric.status, 0, numeric.out);
  assert.equal(numeric.publishes.length, 1);
});

test("publish step: an existing version is skipped only with the same bytes", bashOnly, () => {
  // Ein Re-run einer schon veroeffentlichten Rueckportierung bleibt gruen.
  const same = runPublish({ version: "7.20.11", versions: { "7.21.4": "sha512-b" }, sameBytesAs: "7.20.11" });
  assert.equal(same.status, 0, same.out);
  assert.match(same.out, /already on GitHub Packages with this tarball; nothing to publish/);
  assert.deepEqual(same.publishes, []);

  const other = runPublish({ version: "7.21.4", versions: { "7.21.4": "sha512-different" } });
  assert.equal(other.status, 1, other.out);
  assert.match(other.out, /::error::@cyb3rb1ade\/plur1bus-memory@7\.21\.4 is already on GitHub Packages with another tarball/);
  assert.deepEqual(other.publishes, []);
});

test("publish step: a failed publish is read back three times and names E403", bashOnly, () => {
  const denied = runPublish({ version: "7.21.5", versions: { "7.21.4": "sha512-old" }, publish: "e403" });
  assert.equal(denied.status, 1, denied.out);
  assert.match(denied.out, /::error::publishing @cyb3rb1ade\/plur1bus-memory@7\.21\.5 failed; on E403 give this repository role Write/);
  assert.equal(denied.calls.filter((call) => call[0] === "view" && call[2] === "dist.integrity").length, 3);
  assert.equal(denied.sleeps, 3);

  // npm meldet einen Fehler, der Upload ist aber angekommen.
  const landed = runPublish({ version: "7.21.5", versions: { "7.21.4": "sha512-old" }, publish: "landed-then-error" });
  assert.equal(landed.status, 0, landed.out);
  assert.match(landed.out, /with this tarball although npm reported an error/);
});

test("npm-publish keeps its environment, OIDC and owner gate", () => {
  const job = jobBlock(readRepoFile(WORKFLOW), "npm-publish");

  assert.match(job, /^ {4}environment: npm-publish\s*$/m);
  assert.match(
    job,
    /^ {4}if: needs\.check\.outputs\.dry-run != 'true' && needs\.pack\.outputs\.npm == 'yes'\s*$/m,
  );
  assert.match(job, /^ {6}id-token: write\s*$/m);
  assert.match(job, /npm publish "\.\/\$TGZ" --provenance --access public --tag "\$dist_tag"/);
  assert.match(readRepoFile(WORKFLOW), /NPM_VAR: \$\{\{ vars\.PLUR1BUS_NPM_PUBLISH \}\}/);
});

test("every action is pinned to one commit SHA", () => {
  const workflow = readRepoFile(WORKFLOW);
  const pins = new Map();
  let count = 0;
  for (const line of workflow.split("\n")) {
    const uses = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
    if (!uses) continue;
    count += 1;
    const pinned = line.match(/uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40}) # v\d+(?:\.\d+)*\s*$/);
    assert.ok(pinned, `nicht auf einen Commit gepinnt: ${line.trim()}`);
    const [, action, sha] = pinned;
    if (!pins.has(action)) pins.set(action, new Set());
    pins.get(action).add(sha);
  }
  assert.ok(count > 0, "keine uses-Zeilen gefunden");
  for (const [action, shas] of pins) {
    assert.equal(shas.size, 1, `${action} mit verschiedenen Pins: ${[...shas].join(", ")}`);
  }
});

test("the header documents github-packages", () => {
  const header = headerComment(readRepoFile(WORKFLOW));

  assert.match(header, /^#\s+github-packages\s+npm\.pkg\.github\.com/m);
  assert.match(header, /github-release and github-packages/);
  assert.match(header, /no GitHub Packages/);
  assert.match(header, /Manage Actions access/);
});
