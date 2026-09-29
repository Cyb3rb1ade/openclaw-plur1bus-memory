// tests/dist-bootstrap-ps1.test.js — render-bootstraps.mjs (every OS) and install-plugin.ps1
// (win32 only, under powershell.exe 5.1 and pwsh 7 when present) against shims only.
//
// The .ps1 runs with a temp USERPROFILE/LOCALAPPDATA from the installer sandbox, a
// file:// feed signed per run with an ephemeral TEST ONLY key, an `openclaw.cmd`
// shim, a TEST ONLY "too old" `node.cmd` or a link to this process's node.exe, and a
// `wsl.exe` shim (PLUR1BUS_PLUGIN_WSL_EXE, test flag only) that answers `-l -q` and
// `-l -v` in UTF-16LE with NULs like the real wsl.exe, logs every call and records
// what is piped into `sh -s`. The real wsl.exe and a real OpenClaw are never run.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePublicKey } from "../scripts/dist/minisign.mjs";
import { createInstallerSandbox, makeTestFeed } from "./helpers/installer-sandbox.js";
import { generateTestKeyPair } from "./helpers/minisign-sign.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = join(ROOT, "scripts", "dist", "render-bootstraps.mjs");
const MINISIGN = join(ROOT, "scripts", "dist", "minisign.mjs");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function render(args) {
  const out = makeTempDir("plur1bus-render-");
  const r = spawnSync(process.execPath, [RENDER, "--out-dir", out, ...args], { encoding: "utf8" });
  return { ...r, out, files: existsSync(out) ? readdirSync(out).sort() : [] };
}

describe("render-bootstraps.mjs", () => {
  const stable = generateTestKeyPair().publicKeyLine;
  const beta = generateTestKeyPair().publicKeyLine;

  it("refuses to render without both keys", () => {
    for (const args of [[], ["--pubkey-stable", stable], ["--pubkey-beta", beta]]) {
      const r = render(args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /--pubkey-stable and --pubkey-beta/);
      assert.deepEqual(r.files, []);
    }
    const bad = render(["--pubkey-stable", stable, "--pubkey-beta", "not-a-key"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /pubkey-beta/);
    assert.deepEqual(bad.files, []);
  });

  it("renders both keys and the verifier into both bootstraps", () => {
    const r = render(["--pubkey-stable", stable, "--pubkey-beta", beta]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.files, ["install-plugin.ps1", "install-plugin.sh"]);
    const src = readFileSync(MINISIGN, "utf8");
    const sh = readFileSync(join(r.out, "install-plugin.sh"), "utf8");
    const ps1 = readFileSync(join(r.out, "install-plugin.ps1"), "utf8");
    for (const text of [sh, ps1]) {
      assert.doesNotMatch(text, /@@(PUBKEY_STABLE|PUBKEY_BETA|MINISIGN_JS|RENDER_NOTE)@@/);
      assert.ok(text.includes(`'${stable}'`) && text.includes(`'${beta}'`));
      assert.doesNotMatch(text.split("\n").slice(0, 6).join("\n"), /TEST ONLY/);
    }
    assert.ok(sh.includes(`\n${src.replace(/\n$/, "")}\nPLUR1BUS_MINISIGN_JS\n`), "sh inlines minisign.mjs verbatim");
    const b64 = /\$MinisignJsBase64 = '([A-Za-z0-9+/=]+)'/.exec(ps1);
    assert.ok(b64, "ps1 carries the verifier as base64");
    assert.equal(Buffer.from(b64[1], "base64").toString("utf8"), src, "ps1 inlines minisign.mjs verbatim (base64, ASCII-only)");
    assert.match(r.stdout, /install-plugin\.sh[\s\S]*sha256 [0-9a-f]{64}/);
    // the keys the renderer accepted parse as minisign keys
    parsePublicKey(stable);
  });

  it("--test-key renders a TEST ONLY build without keys", () => {
    const r = render(["--test-key"]);
    assert.equal(r.status, 0, r.stderr);
    for (const f of ["install-plugin.sh", "install-plugin.ps1"]) {
      const head = readFileSync(join(r.out, f), "utf8").split("\n").slice(0, 6).join("\n");
      assert.match(head, /TEST ONLY/, f);
    }
  });

  it("the rendered ps1 is ASCII-only", () => {
    for (const args of [["--test-key"], ["--pubkey-stable", stable, "--pubkey-beta", beta]]) {
      const r = render(args);
      assert.equal(r.status, 0, r.stderr);
      const bytes = readFileSync(join(r.out, "install-plugin.ps1"));
      const bad = bytes.findIndex((b) => b >= 0x80);
      assert.equal(bad, -1, `non-ASCII byte at offset ${bad}`);
    }
    const tpl = readFileSync(join(ROOT, "scripts", "dist", "install-plugin.ps1.in"));
    assert.equal(tpl.findIndex((b) => b >= 0x80), -1, "the template is ASCII-only too");
  });
});

// ---------------------------------------------------------------------------------------------
// install-plugin.ps1 behaviour (Windows only; Task 8/9 CI legs run it on windows-2025 and windows-11-arm)
// ---------------------------------------------------------------------------------------------

const FAKE_INSTALLER = `// TEST ONLY fake plugin installer: records its argv and the handed-over feed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const i = argv.indexOf("--feed-file");
const feedFile = i >= 0 ? argv[i + 1] : null;
const rec = { argv, execPath: process.execPath, feed: feedFile && existsSync(feedFile) ? readFileSync(feedFile, "utf8") : null };
writeFileSync(process.env.FAKE_INSTALLER_MARK, JSON.stringify(rec));
process.stdout.write(JSON.stringify(rec) + "\\n");
process.exit(Number(process.env.FAKE_INSTALLER_EXIT || 0));
`;

// TEST ONLY wsl.exe: answers from WSL_SHIM_SCENARIO, logs argv, records stdin of `sh -s`.
const WSL_SHIM = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const sc = JSON.parse(readFileSync(process.env.WSL_SHIM_SCENARIO, "utf8"));
const args = process.argv.slice(2);
appendFileSync(sc.log, JSON.stringify({ argv: args, WSL_UTF8: process.env.WSL_UTF8 ?? null, WSLENV: process.env.WSLENV ?? null }) + "\\n");
const utf16 = (s) => process.stdout.write(Buffer.from(s, "utf16le"));
if (args[0] === "-l" && args.includes("-q")) { utf16(sc.distros.map((d) => d.name + "\\r\\n").join("")); process.exit(0); }
if (args[0] === "-l" && args.includes("-v")) {
  utf16("  NAME            STATE           VERSION\\r\\n" + sc.distros.map((d, i) => (i === 0 ? "* " : "  ") + d.name.padEnd(16) + (d.running ? "Running" : "Stopped").padEnd(16) + "2\\r\\n").join(""));
  process.exit(0);
}
if (args[0] === "-d") {
  const d = sc.distros.find((x) => x.name === args[1]);
  const rest = args.slice(2);
  if (!d) { process.stderr.write("There is no distribution with the supplied name.\\n"); process.exit(1); }
  if (rest[0] === "-e" && rest[1] === "sh" && rest[2] === "-lc") { if (d.openclaw) { process.stdout.write("/home/u/.local/bin/openclaw\\n"); process.exit(0); } process.exit(1); }
  if (rest[0] === "-e" && rest[1] === "wslpath") { process.stdout.write("/mnt/" + rest[3][0].toLowerCase() + rest[3].slice(2).replaceAll("\\\\", "/") + "\\n"); process.exit(0); }
  if (rest[0] === "-e" && rest[1] === "sh" && rest[2] === "-s") {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    writeFileSync(sc.stdinFile, Buffer.concat(chunks));
    process.exit(sc.shExit ?? 0);
  }
}
process.stderr.write("wsl shim: unexpected " + JSON.stringify(args) + "\\n");
process.exit(2);
`;

function findShells() {
  if (process.platform !== "win32") return [];
  const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
  const shells = [];
  const ps51 = join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (existsSync(ps51)) shells.push({ name: "powershell.exe", exe: ps51 });
  const r = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8" });
  if (r.status === 0) shells.push({ name: "pwsh", exe: r.stdout.split(/\r?\n/)[0].trim() });
  return shells;
}

let ps1Script;

function linkOrCopy(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

/**
 * @param {{ shell: {exe: string}, native?: boolean, pathNode?: "good"|"old"|"none", privateNode?: "good"|"none",
 *   distros?: Array<{name: string, running: boolean, openclaw: boolean}>, badSignature?: boolean,
 *   feedPatch?: (f: object) => void, testFlag?: boolean, installerExit?: number }} o
 */
function makePsCase(o) {
  const { native = true, pathNode = "good", privateNode = "none", testFlag = true } = o;
  const sb = createInstallerSandbox();
  const root = sb.root;
  const bin = join(root, "ps-bin");
  const goodNodeDir = join(root, "node-good");
  const feedDir = join(root, "feed");
  for (const d of [bin, feedDir]) mkdirSync(d, { recursive: true });
  const sysRoot = process.env.SystemRoot ?? "C:\\Windows";

  if (pathNode === "good") linkOrCopy(process.execPath, join(goodNodeDir, "node.exe"));
  if (pathNode === "old") writeFileSync(join(bin, "node.cmd"), "@echo off\r\nif \"%~1\"==\"--version\" (echo v22.1.0& exit /b 0)\r\nexit /b 97\r\n");
  const privateNodePath = join(sb.env.LOCALAPPDATA, "OpenClaw", "deps", "portable-node", "node.exe");
  if (privateNode === "good") linkOrCopy(process.execPath, privateNodePath);
  if (native) writeFileSync(join(bin, "openclaw.cmd"), `@"${process.execPath}" "${join(sb.binDir, "openclaw-shim.mjs")}" %*\r\n`);

  const wslLog = join(root, "wsl.log");
  const stdinFile = join(root, "wsl-stdin.bin");
  writeFileSync(wslLog, "");
  writeFileSync(join(root, "wsl-shim.mjs"), WSL_SHIM);
  const wslScenario = join(root, "wsl-scenario.json");
  writeFileSync(wslScenario, JSON.stringify({ log: wslLog, stdinFile, distros: o.distros ?? [] }));
  const wslExe = join(root, "wsl.cmd");
  writeFileSync(wslExe, `@"${process.execPath}" "${join(root, "wsl-shim.mjs")}" %*\r\n`);

  const installerPath = join(root, "fake-installer.mjs");
  writeFileSync(installerPath, FAKE_INSTALLER);
  const shPath = join(root, "bootstrap-TEST-ONLY.sh");
  writeFileSync(shPath, "#!/bin/sh\n# TEST ONLY stand-in for install-plugin.sh\nprintf 'distro side\\n'\n");
  const feed = makeTestFeed();
  feed.installer.url = pathToFileURL(installerPath).href;
  feed.installer.sha256 = sha256(readFileSync(installerPath));
  feed.bootstrap.sh.url = pathToFileURL(shPath).href;
  feed.bootstrap.sh.sha256 = sha256(readFileSync(shPath));
  if (o.feedPatch) o.feedPatch(feed);
  const feedBytes = Buffer.from(JSON.stringify(feed, null, 2) + "\n");
  const keys = generateTestKeyPair();
  writeFileSync(join(feedDir, "stable.json"), feedBytes);
  writeFileSync(join(feedDir, "stable.json.minisig"), keys.sign(o.badSignature ? Buffer.concat([feedBytes, Buffer.from(" ")]) : feedBytes));

  const pathDirs = [bin, ...(pathNode === "good" ? [goodNodeDir] : []), join(sysRoot, "System32"), join(sysRoot, "System32", "WindowsPowerShell", "v1.0"), dirname(o.shell.exe)];
  const mark = join(root, "installer-ran.json");
  const tmp = makeTempDir("plur1bus-ps-tmp-");
  const env = {
    ...sb.env,
    PATH: pathDirs.join(";"),
    SystemRoot: sysRoot,
    windir: sysRoot,
    ComSpec: process.env.ComSpec ?? join(sysRoot, "System32", "cmd.exe"),
    TEMP: tmp,
    TMP: tmp,
    PLUR1BUS_PLUGIN_FEED: pathToFileURL(join(feedDir, "stable.json")).href,
    PLUR1BUS_PLUGIN_PUBKEY: keys.publicKeyLine,
    PLUR1BUS_PLUGIN_WSL_EXE: wslExe,
    WSL_SHIM_SCENARIO: wslScenario,
    FAKE_INSTALLER_MARK: mark,
    ...(o.installerExit !== undefined ? { FAKE_INSTALLER_EXIT: String(o.installerExit) } : {}),
  };
  if (!testFlag) delete env.PLUR1BUS_PLUGIN_INSTALLER_TEST;

  return {
    root,
    tmp,
    feedBytes,
    shBytes: readFileSync(shPath),
    goodNode: join(goodNodeDir, "node.exe"),
    privateNodePath,
    run(args = []) {
      const r = spawnSync(o.shell.exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1Script, ...args], {
        env,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        input: "",
        timeout: 120_000,
      });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
    },
    installer() {
      return existsSync(mark) ? JSON.parse(readFileSync(mark, "utf8")) : null;
    },
    wslCalls() {
      return readFileSync(wslLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    wslStdin() {
      return existsSync(stdinFile) ? readFileSync(stdinFile) : null;
    },
  };
}

const SHELLS = findShells();
const PS_SKIP = process.platform !== "win32" ? "install-plugin.ps1 runs on Windows only (Task 8/9 Windows CI legs)" : SHELLS.length === 0 && "no PowerShell found";
const UBUNTU = "Ubuntu-24.04";

describe("install-plugin.ps1", { skip: PS_SKIP }, () => {
  before(() => {
    const r = render(["--test-key"]);
    assert.equal(r.status, 0, r.stderr);
    ps1Script = join(r.out, "install-plugin.ps1");
  });

  for (const shell of SHELLS) {
    describe(shell.name, () => {
      it("a verified feed runs the installer with the given flags", () => {
        const c = makePsCase({ shell });
        const r = c.run(["--json", "--non-interactive"]);
        assert.equal(r.code, 0, r.out);
        const rec = c.installer();
        assert.ok(rec, r.out);
        assert.equal(rec.argv[0], "--feed-file");
        assert.deepEqual(rec.argv.slice(2), ["--json", "--non-interactive"]);
        assert.equal(rec.feed, c.feedBytes.toString("utf8"));
        assert.ok(!existsSync(rec.argv[1]), "the temp dir is removed afterwards");
        assert.deepEqual(readdirSync(c.tmp), []);
        assert.equal(rec.execPath.toLowerCase(), c.goodNode.toLowerCase());
      });

      it("passes the installer's exit code through", () => {
        const c = makePsCase({ shell, installerExit: 2 });
        const r = c.run(["--update"]);
        assert.equal(r.code, 2, r.out);
      });

      it("a bad signature exits 1 and downloads nothing else", () => {
        const c = makePsCase({ shell, badSignature: true, feedPatch: (f) => { f.installer.url = "file:///C:/TEST-ONLY/does-not-exist.mjs"; } });
        const r = c.run([]);
        assert.equal(r.code, 1, r.out);
        assert.match(r.stderr, /signature/);
        assert.doesNotMatch(r.stderr, /download/i);
        assert.equal(c.installer(), null);
      });

      it("an installer hash mismatch exits 1 and runs nothing", () => {
        const c = makePsCase({ shell, feedPatch: (f) => { f.installer.sha256 = "0".repeat(64); } });
        const r = c.run([]);
        assert.equal(r.code, 1, r.out);
        assert.match(r.stderr, /checksum mismatch/);
        assert.equal(c.installer(), null);
      });

      it("no openclaw exits 3", () => {
        const c = makePsCase({ shell, native: false });
        const r = c.run([]);
        assert.equal(r.code, 3, r.out);
        assert.match(r.stderr, /openclaw-not-found/);
        assert.equal(c.installer(), null);
      });

      it("a too-old node on PATH falls back to OpenClaw's private node, else exits 3", () => {
        const c = makePsCase({ shell, pathNode: "old", privateNode: "good" });
        const r = c.run([]);
        assert.equal(r.code, 0, r.out);
        assert.equal(c.installer().execPath.toLowerCase(), c.privateNodePath.toLowerCase());
        const none = makePsCase({ shell, pathNode: "old", privateNode: "none" });
        const r2 = none.run([]);
        assert.equal(r2.code, 3, r2.out);
        assert.match(r2.stderr, /node-not-found/);
      });

      it("an https-only feed refuses file:// without the test flag", () => {
        const c = makePsCase({ shell, testFlag: false });
        const r = c.run([]);
        assert.equal(r.code, 1, r.out);
        assert.match(r.stderr, /https/);
        assert.equal(c.installer(), null);
      });

      it("several candidates without -Target exit 2 and list native and wsl:Ubuntu-24.04", () => {
        const c = makePsCase({ shell, distros: [{ name: UBUNTU, running: true, openclaw: true }, { name: "docker-desktop", running: true, openclaw: false }] });
        const r = c.run(["--json"]);
        assert.equal(r.code, 2, r.out);
        assert.match(r.stderr, /native/);
        assert.match(r.stderr, /wsl:Ubuntu-24\.04/);
        assert.doesNotMatch(r.stderr, /wsl:docker-desktop/);
        assert.equal(c.installer(), null);
        assert.ok(c.wslCalls().every((e) => e.WSL_UTF8 === "1"), "WSL_UTF8=1 is set for every wsl.exe call");
      });

      it("a stopped distro is not probed without -ProbeWsl", () => {
        const c = makePsCase({ shell, distros: [{ name: UBUNTU, running: false, openclaw: true }] });
        const r = c.run([]);
        assert.equal(r.code, 0, r.out);
        assert.ok(c.installer(), "the only probed candidate (native) is used");
        assert.ok(!c.wslCalls().some((e) => e.argv[0] === "-d"), JSON.stringify(c.wslCalls()));

        const p = makePsCase({ shell, distros: [{ name: UBUNTU, running: false, openclaw: true }] });
        const r2 = p.run(["-ProbeWsl"]);
        assert.equal(r2.code, 2, r2.out);
        assert.ok(p.wslCalls().some((e) => e.argv[0] === "-d" && e.argv[1] === UBUNTU));
        assert.match(r2.stderr, /wsl:Ubuntu-24\.04/);
      });

      it("wsl:<d> pipes the verified sh with the resolved version and a translated --offline path", () => {
        const c = makePsCase({ shell, native: false, distros: [{ name: UBUNTU, running: true, openclaw: true }] });
        const r = c.run(["-Target", `wsl:${UBUNTU}`, "--offline", "C:\\TEST ONLY\\p.tgz", "--json"]);
        assert.equal(r.code, 0, r.out);
        const sh = c.wslCalls().find((e) => e.argv.includes("-s"));
        assert.ok(sh, JSON.stringify(c.wslCalls()));
        assert.deepEqual(sh.argv, ["-d", UBUNTU, "-e", "sh", "-s", "--", "--version", "7.16.11", "--offline", "/mnt/c/TEST ONLY/p.tgz", "--json"]);
        assert.deepEqual(c.wslStdin(), c.shBytes, "stdin is the feed's bootstrap.sh, byte for byte");
        assert.equal(c.installer(), null, "nothing runs natively");

        assert.match(sh.WSLENV ?? "", /PLUR1BUS_PLUGIN_CHANNEL\/u/);

        // `-Target:<v>`, `--version=<v>`, and `--offline=C:\...` (which `-File` splits at the colon).
        const forms = makePsCase({ shell, native: false, distros: [{ name: UBUNTU, running: true, openclaw: true }] });
        const rf = forms.run([`-Target:wsl:${UBUNTU}`, "--version=7.1.0", "--offline=C:\\a b\\x.tgz"]);
        assert.equal(rf.code, 0, rf.out);
        assert.deepEqual(forms.wslCalls().find((e) => e.argv.includes("-s")).argv, ["-d", UBUNTU, "-e", "sh", "-s", "--", "--version", "7.1.0", "--offline", "/mnt/c/a b/x.tgz"]);

        const bad = makePsCase({ shell, native: false, distros: [{ name: UBUNTU, running: true, openclaw: true }], feedPatch: (f) => { f.bootstrap.sh.sha256 = "0".repeat(64); } });
        const r2 = bad.run(["-Target", `wsl:${UBUNTU}`]);
        assert.equal(r2.code, 1, r2.out);
        assert.match(r2.stderr, /checksum mismatch/);
        assert.equal(bad.wslStdin(), null);
      });

      it("ps1 passes a non-ASCII state dir through unchanged", () => {
        const c = makePsCase({ shell });
        const dir = "C:\\Users\\J\u00fcrgen A\\.openclaw";
        const r = c.run(["--state-dir", dir, "--json"]);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(c.installer().argv.slice(2), ["--state-dir", dir, "--json"]);
      });
    });
  }
});
