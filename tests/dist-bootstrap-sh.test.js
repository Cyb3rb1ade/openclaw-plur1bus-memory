// tests/dist-bootstrap-sh.test.js — install-plugin.sh (HM1 Task 7) against shims only.
//
// Every run renders the bootstrap with --test-key, signs a file:// feed with an
// ephemeral TEST ONLY key (tests/helpers/minisign-sign.js) and uses the
// installer sandbox's temp home/state dir. `openclaw` is an install-cli.sh-shaped
// wrapper around the sandbox's openclaw shim, `node` is either a wrapper around
// this process's Node or a TEST ONLY "too old" stub, `curl` logs every URL, and
// the "installer" is a fake .mjs that records its argv. Never a real OpenClaw.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createInstallerSandbox, makeTestFeed } from "./helpers/installer-sandbox.js";
import { generateTestKeyPair } from "./helpers/minisign-sign.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = join(ROOT, "scripts", "dist", "render-bootstraps.mjs");
const SKIP = process.platform === "win32" && "install-plugin.sh is the POSIX bootstrap; the .ps1 has its own suite";

const FAKE_INSTALLER = `// TEST ONLY fake plugin installer: records its argv and the handed-over feed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const i = argv.indexOf("--feed-file");
const feedFile = i >= 0 ? argv[i + 1] : null;
const rec = { argv, umask: process.umask(), feed: feedFile && existsSync(feedFile) ? readFileSync(feedFile, "utf8") : null };
writeFileSync(process.env.FAKE_INSTALLER_MARK, JSON.stringify(rec));
if (process.env.FAKE_INSTALLER_WAIT) {
  // TEST ONLY: stay "busy" (a rollback in progress) until the test says go.
  while (!existsSync(process.env.FAKE_INSTALLER_WAIT)) await new Promise((r) => setTimeout(r, 20));
}
process.stdout.write(JSON.stringify(rec) + "\\n");
process.exit(Number(process.env.FAKE_INSTALLER_EXIT || 0));
`;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const which = (name) => {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

let script;

/**
 * @param {{ pathNode?: "good"|"old"|"none", privateNode?: "good"|"old"|"none", openclaw?: boolean,
 *   feedPatch?: (feed: object) => void, badSignature?: boolean, channel?: string, feedUrl?: string,
 *   testFlag?: boolean, installerExit?: number }} [o]
 */
function makeBootstrapCase(o = {}) {
  const { pathNode = "good", privateNode = "good", openclaw = true, testFlag = true } = o;
  const sb = createInstallerSandbox();
  const root = sb.root;
  const bin = join(root, "bs-bin");
  const ocBin = join(root, "oc", "bin");
  const privDir = join(root, "oc", "tools", "node", "bin");
  const feedDir = join(root, "feed");
  for (const d of [bin, ocBin, privDir, feedDir]) mkdirSync(d, { recursive: true });

  const nodeLog = join(root, "node-calls.log");
  const curlLog = join(root, "curl.log");
  writeFileSync(nodeLog, "");
  writeFileSync(curlLog, "");
  const goodNode = (label) => `#!/bin/sh\nprintf '%s\\n' "${label}" >>"${nodeLog}"\nexec "${process.execPath}" "$@"\n`;
  const oldNode = (label) => `#!/bin/sh\nif [ "$1" = --version ]; then echo v22.1.0; exit 0; fi\nprintf '%s\\n' "${label}-old-used" >>"${nodeLog}"\nexit 97\n`;
  if (pathNode !== "none") writeFileSync(join(bin, "node"), pathNode === "good" ? goodNode("path") : oldNode("path"), { mode: 0o755 });
  if (privateNode !== "none") writeFileSync(join(privDir, "node"), privateNode === "good" ? goodNode("private") : oldNode("private"), { mode: 0o755 });
  // install-cli.sh's wrapper shape (fact sheet step 1).
  writeFileSync(join(ocBin, "openclaw"), `#!/bin/sh\nexec "${join(privDir, "node")}" "${join(sb.binDir, "openclaw-shim.mjs")}" "$@"\n`, { mode: 0o755 });
  const realCurl = which("curl");
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nfor a in "$@"; do case "$a" in *://*) printf '%s\\n' "$a" >>"${curlLog}" ;; esac; done\nif [ -n "\${CURL_BLOCK:-}" ]; then : >"\$CURL_BLOCK.started"; while [ ! -e "\$CURL_BLOCK" ]; do sleep 0.05; done; fi\nexec "${realCurl}" "$@"\n`, { mode: 0o755 });

  const installerPath = join(root, "fake-installer.mjs");
  writeFileSync(installerPath, FAKE_INSTALLER);
  const channel = o.channel ?? "stable";
  const feed = makeTestFeed();
  feed.installer.url = `file://${installerPath}`;
  feed.installer.sha256 = sha256(readFileSync(installerPath));
  if (o.feedPatch) o.feedPatch(feed);
  const feedBytes = Buffer.from(JSON.stringify(feed, null, 2) + "\n");
  const keys = generateTestKeyPair();
  const signed = o.badSignature ? Buffer.concat([feedBytes, Buffer.from(" ")]) : feedBytes;
  writeFileSync(join(feedDir, `${feed.channel}.json`), feedBytes);
  writeFileSync(join(feedDir, `${feed.channel}.json.minisig`), keys.sign(signed));

  const PATH = [bin, ...(openclaw ? [ocBin] : []), "/usr/bin", "/bin"].join(":");
  const mark = join(root, "installer-ran.json");
  const env = {
    ...sb.env,
    PATH,
    PLUR1BUS_PLUGIN_FEED: o.feedUrl ?? `file://${feedDir}/{channel}.json`,
    PLUR1BUS_PLUGIN_PUBKEY: keys.publicKeyLine,
    PLUR1BUS_PLUGIN_CHANNEL: channel,
    FAKE_INSTALLER_MARK: mark,
    TMPDIR: makeTempDir("plur1bus-bs-tmp-"),
    ...(o.installerExit !== undefined ? { FAKE_INSTALLER_EXIT: String(o.installerExit) } : {}),
  };
  if (!testFlag) delete env.PLUR1BUS_PLUGIN_INSTALLER_TEST;

  const resolved = spawnSync("sh", ["-c", "command -v openclaw || true"], { env, encoding: "utf8" }).stdout.trim();
  if (resolved && !resolved.startsWith(root)) throw new Error(`bootstrap test: openclaw resolves to ${resolved}, outside the sandbox`);

  return {
    root,
    env,
    feedBytes,
    tmpDir: env.TMPDIR,
    run(args = []) {
      // umask 022 first: the bootstrap's private 077 must not leak into the installer.
      const r = spawnSync("sh", ["-c", 'umask 022 && exec sh "$0" "$@"', script, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
    },
    /** Start the bootstrap, SIGTERM it (only it) once `startedFile` exists, then create `goFile`; resolves {code, signal}. */
    signalled(startedFile, goFile, args = []) {
      return new Promise((resolveP, reject) => {
        const child = spawn("sh", ["-c", 'umask 022 && exec sh "$0" "$@"', script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
        let err = "";
        child.stderr.on("data", (d) => { err += d; });
        const t0 = Date.now();
        const poll = setInterval(() => {
          if (existsSync(startedFile)) {
            clearInterval(poll);
            child.kill("SIGTERM");
            setTimeout(() => writeFileSync(goFile, ""), 200);
          } else if (Date.now() - t0 > 30_000) {
            clearInterval(poll);
            child.kill("SIGKILL");
            reject(new Error(`never started: ${err}`));
          }
        }, 20);
        child.on("exit", (code, signal) => resolveP({ code, signal, stderr: err }));
      });
    },
    installer() {
      return existsSync(mark) ? JSON.parse(readFileSync(mark, "utf8")) : null;
    },
    nodeCalls() {
      return readFileSync(nodeLog, "utf8").split("\n").filter(Boolean);
    },
    curlUrls() {
      return readFileSync(curlLog, "utf8").split("\n").filter(Boolean);
    },
  };
}

describe("install-plugin.sh", { skip: SKIP }, () => {
  before(() => {
    const out = makeTempDir("plur1bus-bootstraps-");
    const r = spawnSync(process.execPath, [RENDER, "--test-key", "--out-dir", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    script = join(out, "install-plugin.sh");
  });

  it("a verified feed runs the installer with the given flags", () => {
    const c = makeBootstrapCase();
    const r = c.run(["--json", "--non-interactive", "--state-dir", "/tmp/p b/Jürgen/.openclaw-work"]);
    assert.equal(r.code, 0, r.out);
    const rec = c.installer();
    assert.ok(rec, `installer did not run: ${r.out}`);
    assert.equal(rec.argv[0], "--feed-file");
    assert.deepEqual(rec.argv.slice(2), ["--json", "--non-interactive", "--state-dir", "/tmp/p b/Jürgen/.openclaw-work"]);
    assert.equal(rec.feed, c.feedBytes.toString("utf8"), "the installer gets the verified feed bytes");
    assert.ok(!existsSync(rec.argv[1]), "the private temp dir is removed afterwards");
    assert.deepEqual(spawnSync("ls", ["-A", c.tmpDir], { encoding: "utf8" }).stdout, "");
    assert.ok(c.nodeCalls().every((l) => l === "path"), "node on PATH is new enough and used");
    assert.equal(rec.umask, 0o022, "the installer runs with the caller's umask, not the temp dir's 077");
  });

  it("passes the installer's exit code through", () => {
    const c = makeBootstrapCase({ installerExit: 2 });
    const r = c.run(["--update"]);
    assert.equal(r.code, 2, r.out);
    assert.deepEqual(c.installer().argv.slice(2), ["--update"]);
  });

  it("a signal during the installer keeps the installer's exit code; before it, exits 130", async () => {
    const c = makeBootstrapCase({ installerExit: 4 });
    const go = join(c.root, "go");
    c.env.FAKE_INSTALLER_WAIT = go;
    const r = await c.signalled(join(c.root, "installer-ran.json"), go, ["--update"]);
    assert.equal(r.code, 4, r.stderr);
    assert.deepEqual(spawnSync("ls", ["-A", c.tmpDir], { encoding: "utf8" }).stdout, "", "temp dir removed");

    const early = makeBootstrapCase();
    const block = join(early.root, "curl-go");
    early.env.CURL_BLOCK = block;
    const r2 = await early.signalled(`${block}.started`, block);
    assert.equal(r2.code, 130, r2.stderr);
    assert.equal(early.installer(), null);
    assert.deepEqual(spawnSync("ls", ["-A", early.tmpDir], { encoding: "utf8" }).stdout, "", "temp dir removed");
  });

  it("a bad signature exits 1 and downloads nothing else", () => {
    const c = makeBootstrapCase({ badSignature: true });
    const r = c.run(["--json"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /signature/);
    assert.equal(c.installer(), null);
    const urls = c.curlUrls();
    assert.equal(urls.length, 2, urls.join("\n"));
    assert.match(urls[0], /\/stable\.json$/);
    assert.match(urls[1], /\/stable\.json\.minisig$/);
  });

  it("an installer hash mismatch exits 1 and runs nothing", () => {
    const c = makeBootstrapCase({ feedPatch: (f) => { f.installer.sha256 = "0".repeat(64); } });
    const r = c.run([]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /checksum mismatch/);
    assert.equal(c.installer(), null);
  });

  it("no openclaw exits 3", () => {
    const c = makeBootstrapCase({ openclaw: false });
    const r = c.run([]);
    assert.equal(r.code, 3, r.out);
    assert.match(r.stderr, /openclaw-not-found/);
    assert.deepEqual(c.curlUrls(), []);
    assert.equal(c.installer(), null);
  });

  it("a too-old node on PATH falls back to OpenClaw's private node, else exits 3", () => {
    const c = makeBootstrapCase({ pathNode: "old", privateNode: "good" });
    const r = c.run(["--json"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(c.installer());
    assert.ok(c.nodeCalls().length > 0 && c.nodeCalls().every((l) => l === "private"), c.nodeCalls().join(","));

    const none = makeBootstrapCase({ pathNode: "none", privateNode: "good" });
    assert.equal(none.run([]).code, 0);
    assert.ok(none.installer());

    const old = makeBootstrapCase({ pathNode: "old", privateNode: "old" });
    const r2 = old.run([]);
    assert.equal(r2.code, 3, r2.out);
    assert.match(r2.stderr, /node-not-found/);
    assert.deepEqual(old.curlUrls(), []);
    assert.ok(!old.nodeCalls().some((l) => l.endsWith("-old-used")), "a too-old node never runs anything");
  });

  it("an https-only feed refuses file:// without the test flag", () => {
    const c = makeBootstrapCase({ testFlag: false });
    const r = c.run([]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /https/);
    assert.deepEqual(c.curlUrls(), []);
    assert.equal(c.installer(), null);

    const http = makeBootstrapCase({ feedUrl: "http://example.invalid/TEST-ONLY/{channel}.json" });
    const r2 = http.run([]);
    assert.equal(r2.code, 1, r2.out);
    assert.match(r2.stderr, /https/);
    assert.deepEqual(http.curlUrls(), []);
  });

  it("refuses a feed whose channel is not the requested one, and an invalid channel", () => {
    // The beta URL serves a feed that says "stable" (signed, but for the wrong channel).
    const c = makeBootstrapCase({ channel: "beta" });
    const dir = join(c.root, "feed");
    writeFileSync(join(dir, "beta.json"), readFileSync(join(dir, "stable.json")));
    writeFileSync(join(dir, "beta.json.minisig"), readFileSync(join(dir, "stable.json.minisig")));
    const r = c.run([]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /channel/);
    assert.equal(c.installer(), null);

    const bad = makeBootstrapCase({ channel: "Beta;rm" });
    const r2 = bad.run([]);
    assert.equal(r2.code, 1, r2.out);
    assert.match(r2.stderr, /invalid channel/);
  });

  it("ignores PLUR1BUS_PLUGIN_PUBKEY without the test flag", () => {
    // https feed without the flag: the rendered TEST ONLY build has no channel key, so it refuses before downloading.
    const c = makeBootstrapCase({ testFlag: false, feedUrl: "https://example.invalid/TEST-ONLY/{channel}.json" });
    const r = c.run([]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /public key/);
    assert.deepEqual(c.curlUrls(), []);
  });

  it("the rendered script contains no bashisms", () => {
    const dash = which("dash");
    if (dash) {
      const r = spawnSync(dash, ["-n", script], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    const r = spawnSync("sh", ["-n", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const sc = which("shellcheck");
    if (sc) {
      const s = spawnSync(sc, ["-s", "sh", script], { encoding: "utf8" });
      assert.equal(s.status, 0, s.stdout + s.stderr);
    }
    const text = readFileSync(script, "utf8");
    assert.match(text.split("\n")[0], /^#!\/bin\/sh$/);
    // The shell part only: the inlined verifier (JavaScript) sits in a quoted here-document.
    const shell = text
      .replace(/<<'PLUR1BUS_MINISIGN_JS'\n[\s\S]*?\nPLUR1BUS_MINISIGN_JS\n/, "<<'PLUR1BUS_MINISIGN_JS'\n")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.ok(shell.length < text.length, "the verifier is inlined as a here-document");
    assert.doesNotMatch(shell, /(^|\s)\[\[\s|\bfunction\s+\w+|\blocal\s|\$\{[A-Za-z_]+\/\/|<<<|\bsudo\b|\bsource\s/m);
  });
});
