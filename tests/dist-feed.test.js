import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFeed } from "../scripts/dist/build-plugin-feed.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const builder = join(root, "scripts", "dist", "build-plugin-feed.mjs");
const schema = JSON.parse(readFileSync(join(root, "scripts", "dist", "plugin-feed.schema.json"), "utf8"));
const fixtureFeed = JSON.parse(readFileSync(join(root, "tests", "fixtures", "minisign", "feed.json"), "utf8"));

const COMPAT = { pluginApi: ">=2026.8.1", minGatewayVersion: "2026.8.1" };
const NODE_RANGE = ">=24.16.0 <25 || >=26.1.0";
const CLAWPACK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Run npm with this Node: its CLI entry point sits next to the node binary. */
function npm(args, cwd) {
  const bin = dirname(process.execPath);
  const candidates = [
    join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find((p) => existsSync(p));
  const r = cli
    ? spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
    : spawnSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** Pack a minimal package that carries the fields the builder reads. */
function packFixture(dir, version) {
  const pkgDir = join(dir, `pkg-${version}`);
  const pkg = {
    name: "@cyb3rb1ade/plur1bus-memory",
    version,
    type: "module",
    main: "./index.js",
    license: "MIT",
    openclaw: { extensions: ["./index.js"], compat: COMPAT },
    engines: { node: NODE_RANGE },
  };
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(pkgDir, "index.js"), `// TEST ONLY ${version}\nexport default {};\n`);
  const [info] = JSON.parse(npm(["pack", "--json", "--ignore-scripts"], pkgDir));
  return { tgz: join(pkgDir, info.filename), integrity: info.integrity, shasum: info.shasum };
}

function artefacts(dir) {
  const files = {
    installer: join(dir, "plur1bus-plugin-installer.mjs"),
    sh: join(dir, "install-plugin.sh"),
    ps1: join(dir, "install-plugin.ps1"),
    de: join(dir, "notes.de.md"),
    en: join(dir, "notes.en.md"),
  };
  writeFileSync(files.installer, "// TEST ONLY installer\n");
  writeFileSync(files.sh, "#!/bin/sh\n# TEST ONLY\n");
  writeFileSync(files.ps1, "# TEST ONLY\n");
  writeFileSync(files.de, "Neu: Installer (TEST ONLY).\n");
  writeFileSync(files.en, "New: installer (TEST ONLY).\n");
  return files;
}

function build(dir, { version, tgz, out, extra = [] }) {
  const a = artefacts(dir);
  const base = "https://example.invalid/TEST-ONLY";
  const args = [
    builder,
    "--channel", "stable",
    "--version", version,
    "--tgz", tgz,
    "--tarball-url", `${base}/cyb3rb1ade-plur1bus-memory-${version}.tgz`,
    "--installer", a.installer,
    "--installer-url", `${base}/plur1bus-plugin-installer.mjs`,
    "--bootstrap-sh", a.sh,
    "--bootstrap-sh-url", `${base}/install-plugin.sh`,
    "--bootstrap-ps1", a.ps1,
    "--bootstrap-ps1-url", `${base}/install-plugin.ps1`,
    "--notes-de", a.de,
    "--notes-en", a.en,
    "--out", out,
    ...extra,
  ];
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const clone = (v) => JSON.parse(JSON.stringify(v));

describe("scripts/dist/build-plugin-feed.mjs", () => {
  it("builds a valid feed from a packed tarball with sha256 and sha512 integrity", () => {
    const dir = makeTempDir("dist-feed-");
    const { tgz } = packFixture(dir, "7.17.0");
    const out = join(dir, "out", "plugin-stable.json");
    const r = build(dir, { version: "7.17.0", tgz, out, extra: ["--clawpack-digest", CLAWPACK] });
    assert.equal(r.status, 0, r.stderr);
    const feed = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(validateFeed(feed), { ok: true, errors: [] });
    assert.equal(feed.schema, "plur1bus.plugin-feed/1");
    assert.equal(feed.channel, "stable");
    assert.match(feed.generatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    assert.equal(feed.installer.version, "7.17.0");
    assert.equal(feed.installer.sha256, sha256(join(dir, "plur1bus-plugin-installer.mjs")));
    assert.equal(feed.bootstrap.sh.sha256, sha256(join(dir, "install-plugin.sh")));
    assert.equal(feed.bootstrap.ps1.sha256, sha256(join(dir, "install-plugin.ps1")));
    assert.equal(feed.hosts.openclaw.windowsNativeBeta, true);
    assert.equal(feed.hosts.openclaw.latest, "7.17.0");
    assert.equal(feed.hosts.hermes, undefined);
    const [rel] = feed.hosts.openclaw.releases;
    assert.equal(feed.hosts.openclaw.releases.length, 1);
    assert.equal(rel.version, "7.17.0");
    assert.equal(rel.pluginId, "memory-lancedb-namespaced");
    assert.equal(rel.clawhub, "clawhub:@cyb3rb1ade/plur1bus-memory@7.17.0");
    assert.equal(rel.npm, "npm:@cyb3rb1ade/plur1bus-memory@7.17.0");
    assert.equal(rel.tarball.sha256, sha256(tgz));
    assert.equal(rel.tarball.integrity, `sha512-${createHash("sha512").update(readFileSync(tgz)).digest("base64")}`);
    assert.equal(rel.clawpackDigest, CLAWPACK);
    assert.deepEqual(rel.compat, COMPAT);
    assert.equal(rel.node, NODE_RANGE);
    assert.equal(rel.security, false);
    assert.deepEqual(rel.notes, { de: "Neu: Installer (TEST ONLY).\n", en: "New: installer (TEST ONLY).\n" });
    assert.deepEqual(readdirSync(dirname(out)), ["plugin-stable.json"], "no temp file left behind");

    // --no-npm drops the npm locator; --version must match the tarball.
    const noNpm = join(dir, "no-npm.json");
    assert.equal(build(dir, { version: "7.17.0", tgz, out: noNpm, extra: ["--no-npm"] }).status, 0);
    assert.equal("npm" in JSON.parse(readFileSync(noNpm, "utf8")).hosts.openclaw.releases[0], false);
    const mismatch = build(dir, { version: "7.17.9", tgz, out: join(dir, "mismatch.json") });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /7\.17\.9.*7\.17\.0|7\.17\.0.*7\.17\.9/);
    assert.equal(existsSync(join(dir, "mismatch.json")), false);
  });

  it("appends to a previous feed newest first and refuses a duplicate version", () => {
    const dir = makeTempDir("dist-feed-prev-");
    const v0 = packFixture(dir, "7.17.0");
    const v1 = packFixture(dir, "7.17.1");
    const first = join(dir, "first.json");
    assert.equal(build(dir, { version: "7.17.0", tgz: v0.tgz, out: first }).status, 0);
    // The owner flipped windowsNativeBeta in the previous feed; the builder keeps it.
    const prev = JSON.parse(readFileSync(first, "utf8"));
    prev.hosts.openclaw.windowsNativeBeta = false;
    writeFileSync(first, JSON.stringify(prev));

    const second = join(dir, "second.json");
    const r = build(dir, { version: "7.17.1", tgz: v1.tgz, out: second, extra: ["--previous", first] });
    assert.equal(r.status, 0, r.stderr);
    const feed = JSON.parse(readFileSync(second, "utf8"));
    assert.deepEqual(validateFeed(feed).errors, []);
    assert.deepEqual(feed.hosts.openclaw.releases.map((x) => x.version), ["7.17.1", "7.17.0"]);
    assert.equal(feed.hosts.openclaw.latest, "7.17.1");
    assert.equal(feed.hosts.openclaw.windowsNativeBeta, false);
    assert.deepEqual(feed.hosts.openclaw.releases[1], prev.hosts.openclaw.releases[0]);
    assert.equal(feed.installer.version, "7.17.1");

    // A version below the previous latest is refused without --allow-older ...
    const v2 = packFixture(dir, "7.16.12");
    const third = join(dir, "third.json");
    const older = build(dir, { version: "7.16.12", tgz: v2.tgz, out: third, extra: ["--previous", second] });
    assert.equal(older.status, 1);
    assert.match(older.stderr, /7\.16\.12.*7\.17\.1.*--allow-older/);
    assert.equal(existsSync(third), false);
    // ... and with it lands in semver order while the newest installer and bootstraps stay.
    writeFileSync(join(dir, "plur1bus-plugin-installer.mjs"), "// TEST ONLY other installer\n");
    const allowed = build(dir, { version: "7.16.12", tgz: v2.tgz, out: third, extra: ["--previous", second, "--allow-older"] });
    assert.equal(allowed.status, 0, allowed.stderr);
    const f3 = JSON.parse(readFileSync(third, "utf8"));
    assert.deepEqual(validateFeed(f3).errors, []);
    assert.deepEqual(f3.hosts.openclaw.releases.map((x) => x.version), ["7.17.1", "7.17.0", "7.16.12"]);
    assert.equal(f3.hosts.openclaw.latest, "7.17.1");
    assert.deepEqual(f3.installer, feed.installer);
    assert.deepEqual(f3.bootstrap, feed.bootstrap);

    const dup = join(dir, "dup.json");
    writeFileSync(dup, "untouched");
    const d = build(dir, { version: "7.17.1", tgz: v1.tgz, out: dup, extra: ["--previous", second] });
    assert.equal(d.status, 1);
    assert.match(d.stderr, /7\.17\.1.*already/);
    assert.equal(readFileSync(dup, "utf8"), "untouched");

    // A previous feed of another channel is refused.
    const beta = clone(feed);
    beta.channel = "beta";
    const betaPath = join(dir, "beta.json");
    writeFileSync(betaPath, JSON.stringify(beta));
    const c = build(dir, { version: "7.17.2", tgz: packFixture(dir, "7.17.2").tgz, out: join(dir, "c.json"), extra: ["--previous", betaPath] });
    assert.equal(c.status, 1);
    assert.match(c.stderr, /channel/);
  });

  it("rejects a malformed hosts.hermes", () => {
    assert.deepEqual(validateFeed(fixtureFeed), { ok: true, errors: [] });
    const withHermes = clone(fixtureFeed);
    withHermes.hosts.hermes = { latest: "0.1.0", releases: [] };
    const res = validateFeed(withHermes);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("hosts.hermes")), res.errors.join("\n"));

    const dir = makeTempDir("dist-feed-hermes-");
    const { tgz } = packFixture(dir, "7.17.1");
    const prev = join(dir, "prev.json");
    const stable = clone(withHermes);
    stable.channel = "stable";
    writeFileSync(prev, JSON.stringify(stable));
    const r = build(dir, { version: "7.17.1", tgz, out: join(dir, "out.json"), extra: ["--previous", prev] });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hosts\.hermes/);
    assert.equal(existsSync(join(dir, "out.json")), false);
  });

  it("integrity equals npm pack --json's integrity for the same tarball", () => {
    const dir = makeTempDir("dist-feed-npm-");
    const packed = packFixture(dir, "7.17.0");
    const out = join(dir, "feed.json");
    assert.equal(build(dir, { version: "7.17.0", tgz: packed.tgz, out }).status, 0);
    const [rel] = JSON.parse(readFileSync(out, "utf8")).hosts.openclaw.releases;
    assert.equal(rel.tarball.integrity, packed.integrity);
    assert.equal(createHash("sha1").update(readFileSync(packed.tgz)).digest("hex"), packed.shasum);
  });

  it("enforces every required key of the schema and keeps objects closed except notes", () => {
    const valid = clone(fixtureFeed);
    valid.hosts.openclaw.releases[0].npm = "npm:@cyb3rb1ade/plur1bus-memory@7.17.0";
    valid.hosts.openclaw.releases[0].clawpackDigest = CLAWPACK;
    assert.deepEqual(validateFeed(valid).errors, []);

    const resolve = (node) => (node && node.$ref ? schema.$defs[node.$ref.replace("#/$defs/", "")] : node);
    const checked = [];
    const walk = (node, path) => {
      node = resolve(node);
      if (!node || typeof node !== "object") return;
      if (node.type === "object") {
        for (const key of node.required ?? []) {
          const broken = clone(valid);
          const parent = path.reduce((o, k) => o[k], broken);
          delete parent[key];
          const res = validateFeed(broken);
          const where = [...path, key].join(".");
          assert.equal(res.ok, false, `missing ${where} must fail`);
          checked.push(where);
        }
        const extra = clone(valid);
        path.reduce((o, k) => o[k], extra).unexpectedKey = "x";
        const closed = path[path.length - 1] !== "notes";
        assert.equal(validateFeed(extra).ok, !closed, `${path.join(".") || "(root)"} closed=${closed}`);
        for (const [key, sub] of Object.entries(node.properties ?? {})) {
          if (sub === false) continue;
          const value = path.reduce((o, k) => o?.[k], valid)?.[key];
          if (value !== undefined) walk(sub, [...path, key]);
        }
      } else if (node.type === "array") {
        walk(node.items, [...path, 0]);
      }
    };
    walk(schema, []);
    for (const must of ["schema", "hosts.openclaw.releases.0.tarball.integrity", "hosts.openclaw.releases.0.notes.de", "bootstrap.ps1.sha256"]) {
      assert.ok(checked.includes(must), `walked ${must}`);
    }

    const semantic = [
      (f) => { f.hosts.openclaw.latest = "7.16.0"; },
      (f) => { f.hosts.openclaw.releases[0].clawhub = "clawhub:@cyb3rb1ade/plur1bus-memory@7.16.0"; },
      (f) => { f.hosts.openclaw.releases.push(clone(f.hosts.openclaw.releases[0])); },
      (f) => { f.hosts.openclaw.releases[0].tarball.sha256 = "ABC"; },
      (f) => { f.hosts.openclaw.releases[0].tarball.url = "http://example.invalid/x.tgz"; },
      (f) => { f.channel = "nightly"; },
      (f) => { f.hosts.openclaw.windowsNativeBeta = "yes"; },
      (f) => { f.hosts.openclaw.releases[0].clawpackDigest = "sha256:TEST-ONLY"; },
      (f) => { f.hosts.openclaw.releases[0].clawpackDigest = CLAWPACK.toUpperCase(); },
    ];
    for (const mutate of semantic) {
      const f = clone(valid);
      mutate(f);
      assert.equal(validateFeed(f).ok, false, mutate.toString());
    }
  });

  it("refuses non-https URLs unless allowFile is set (tests only)", () => {
    const paths = [
      (f) => f.installer,
      (f) => f.bootstrap.sh,
      (f) => f.bootstrap.ps1,
      (f) => f.hosts.openclaw.releases[0].tarball,
    ];
    for (const at of paths) {
      const f = clone(fixtureFeed);
      at(f).url = "file:///tmp/TEST-ONLY/artefact";
      const res = validateFeed(f);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /https/.test(e)), res.errors.join("\n"));
      assert.deepEqual(validateFeed(f, { allowFile: true }).errors, []);
      at(f).url = "http://example.invalid/x";
      assert.equal(validateFeed(f, { allowFile: true }).ok, false);
    }

    // The builder uses the default: a file:// URL never reaches a feed.
    const dir = makeTempDir("dist-feed-file-");
    const { tgz } = packFixture(dir, "7.17.0");
    const out = join(dir, "out.json");
    const r = build(dir, { version: "7.17.0", tgz, out, extra: ["--tarball-url", "file:///tmp/TEST-ONLY/x.tgz"] });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /https/);
    assert.equal(existsSync(out), false);
  });
});
