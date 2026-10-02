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
import { makeHermesFeed } from "./helpers/hermes-sandbox.js";
import { generateTestKeyPair } from "./helpers/minisign-sign.js";
import { makeZip } from "./helpers/zip.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = join(ROOT, "scripts", "dist", "render-bootstraps.mjs");
const NODE_PINS = join(ROOT, "scripts", "dist", "node-pins.json");
const MINISIGN = join(ROOT, "scripts", "dist", "minisign.mjs");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function render(args, { pins = true } = {}) {
  const out = makeTempDir("plur1bus-render-");
  const r = spawnSync(process.execPath, [RENDER, "--out-dir", out, ...(pins ? ["--node-pins", NODE_PINS] : []), ...args], { encoding: "utf8" });
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

  it("the Windows one-liner is the text-safe form everywhere, and a download refuses a non-https redirect", () => {
    const safe = "$s = (Invoke-WebRequest -UseBasicParsing https://plur1bus.app/install-plugin.ps1).Content; if ($s -is [byte[]]) { $s = [Text.Encoding]::UTF8.GetString($s) }; & ([scriptblock]::Create($s.TrimStart([char]0xFEFF)))";
    for (const f of ["README.md", join("docs", "distribution.md"), join("scripts", "dist", "install-plugin.ps1.in")]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      assert.ok(text.includes(safe), `${f} shows the text-safe one-liner`);
      assert.doesNotMatch(text, /\[scriptblock\]::Create\(\(irm /, `${f} no longer shows the bare irm form`);
    }
    const ps1 = readFileSync(join(ROOT, "scripts", "dist", "install-plugin.ps1.in"), "utf8");
    const get = ps1.slice(ps1.indexOf("function Get-Resource"), ps1.indexOf("function Invoke-Capture"));
    assert.match(get, /Invoke-WebRequest -Uri \$u -OutFile \$file -UseBasicParsing -MaximumRedirection 5 -PassThru/);
    assert.match(get, /\$final = Get-FinalUri \$resp/);
    assert.match(get, /elseif \(\$final\.Scheme -ne 'https'\) \{\s+Remove-Item -LiteralPath \$file[^\n]*\n\s+Fail 1 "refusing a redirect to a non-https URL/);
    assert.match(ps1, /ResponseUri/);
    assert.match(ps1, /RequestMessage\.RequestUri/);
  });

  it("refuses to render without node pins, and with pins that are not nodejs.org's (HM2-R16)", () => {
    const r = render(["--test-key"], { pins: false });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--node-pins <json> is required/);
    assert.deepEqual(r.files, []);
    const pins = JSON.parse(readFileSync(NODE_PINS, "utf8"));
    pins.targets["win-x64"].url = "https://example.invalid/node.zip";
    const dir = makeTempDir("plur1bus-render-pins-");
    writeFileSync(join(dir, "pins.json"), JSON.stringify(pins));
    const bad = render(["--test-key", "--node-pins", join(dir, "pins.json")], { pins: false });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /win-x64 url/);
    // the pins are rendered into both bootstraps
    const ok = render(["--test-key"]);
    assert.equal(ok.status, 0, ok.stderr);
    const real = JSON.parse(readFileSync(NODE_PINS, "utf8"));
    const sh = readFileSync(join(ok.out, "install-plugin.sh"), "utf8");
    const ps1 = readFileSync(join(ok.out, "install-plugin.ps1"), "utf8");
    assert.match(sh, /^NODE_PIN_VERSION='24\.21\.0'$/m);
    for (const t of ["linux-x64", "linux-arm64", "darwin-arm64"]) assert.ok(sh.includes(`${t}) echo '${real.targets[t].url} ${real.targets[t].sha256} tar.gz' ;;`), t);
    assert.match(ps1, /^\$NodePinVersion = '24\.21\.0'$/m);
    for (const t of ["win-x64", "win-arm64"]) assert.ok(ps1.includes(`'${t}' = @{ Url = '${real.targets[t].url}'; Sha256 = '${real.targets[t].sha256}'; Archive = 'zip' }`), t);
    assert.doesNotMatch(sh + ps1, /@@NODE_PINS@@/);
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
// \`-l -q --running\` lists running distros only (none: a message and a non-zero exit, like some WSL builds);
// \`-l -q\` lists all. \`-l -v\` (locale-dependent state column) is deliberately unsupported (T7-b).
if (args[0] === "-l" && args.includes("-q") && args.includes("--running")) {
  const running = sc.distros.filter((d) => d.running);
  if (running.length === 0) { utf16("There are no running distributions.\\r\\n"); process.exit(1); }
  utf16(running.map((d) => d.name + "\\r\\n").join(""));
  process.exit(0);
}
if (args[0] === "-l" && args.includes("-q") && args.length === 2) { utf16(sc.distros.map((d) => d.name + "\\r\\n").join("")); process.exit(0); }
if (args[0] === "-d") {
  const d = sc.distros.find((x) => x.name === args[1]);
  const rest = args.slice(2);
  if (!d) { process.stderr.write("There is no distribution with the supplied name.\\n"); process.exit(1); }
  if (rest[0] === "-e" && rest[1] === "sh" && rest[2] === "-lc") {
    const want = String(rest[3]).trim().split(/\\s+/).pop();
    if (d[want]) { process.stdout.write("/home/u/.local/bin/" + want + "\\n"); process.exit(0); }
    process.exit(1);
  }
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

// Per-run limit. Windows PowerShell 5.1 needs 12-25 s per run of the .ps1 on the hosted runners even when warm (pwsh:
// about 1 s), and its first run in a job has taken 28-70 s inside test-cross. In the standalone bootstrap-stdin-bytes
// job (a fresh VM right after npm ci) the first run passed the old 120 s limit and was killed with no output (tc4,
// run 109525089835), although the same byte check passed under powershell.exe in test-cross at the same commit.
function psRunTimeoutMs(shell) {
  return shell.name === "powershell.exe" ? 360_000 : 120_000;
}

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
  // --host hermes (Task 10): a hermes.cmd launcher, Hermes' own Node, a file:// "nodejs.org/dist" for the pinned Node
  if (o.hermes) writeFileSync(join(bin, "hermes.cmd"), "@echo Hermes Agent v0.21.5 (2026.9.24) TEST ONLY\r\n");
  const hermesNodePath = join(sb.env.LOCALAPPDATA, "hermes", "node", "node.exe");
  if (o.hermesNode === "good") linkOrCopy(process.execPath, hermesNodePath);

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
    // the .ps1 maps PROCESSOR_ARCHITEW6432 / PROCESSOR_ARCHITECTURE to win-x64 | win-arm64 ("unsupported-target:
    // windows/" on every Windows test-cross leg without them)
    ...(process.env.PROCESSOR_ARCHITECTURE ? { PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE } : {}),
    ...(process.env.PROCESSOR_ARCHITEW6432 ? { PROCESSOR_ARCHITEW6432: process.env.PROCESSOR_ARCHITEW6432 } : {}),
    TEMP: tmp,
    TMP: tmp,
    PLUR1BUS_PLUGIN_FEED: pathToFileURL(join(feedDir, "stable.json")).href,
    PLUR1BUS_PLUGIN_PUBKEY: keys.publicKeyLine,
    PLUR1BUS_PLUGIN_WSL_EXE: wslExe,
    WSL_SHIM_SCENARIO: wslScenario,
    FAKE_INSTALLER_MARK: mark,
    ...(o.nodeBase ? { PLUR1BUS_PLUGIN_TEST_NODE_BASE: pathToFileURL(o.nodeBase).href } : {}),
    ...(o.extraEnv ?? {}),
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
    hermesNodePath,
    localAppData: sb.env.LOCALAPPDATA,
    run(args = [], { raw = false, script = ps1Script } = {}) {
      const started = Date.now();
      const r = spawnSync(o.shell.exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
        env,
        encoding: raw ? "buffer" : "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        input: "",
        timeout: psRunTimeoutMs(o.shell),
      });
      // A killed run has status null and often no output at all: say so, with how far the wsl.exe shim got.
      const spawnNote = r.error
        ? `\n[spawn ${r.error.code ?? r.error.message} after ${Date.now() - started} ms (limit ${psRunTimeoutMs(o.shell)} ms); wsl.exe calls so far: ${readFileSync(wslLog, "utf8").split("\n").filter(Boolean).length}]`
        : "";
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}${spawnNote}` };
    },
    markText() {
      return existsSync(mark) ? readFileSync(mark, "utf8") : null;
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
// ci.yml's bootstrap-stdin-bytes job sets PLUR1BUS_REQUIRE_PS51=1: there the Windows PowerShell 5.1 byte check
// must run, so a missing powershell.exe fails instead of skipping.
if (process.env.PLUR1BUS_REQUIRE_PS51 === "1" && !SHELLS.some((s) => s.name === "powershell.exe")) {
  throw new Error("PLUR1BUS_REQUIRE_PS51=1 but Windows PowerShell 5.1 (powershell.exe) was not found");
}
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
        assert.ok(c.wslCalls().some((e) => e.argv.join(" ") === "-l -q --running"), "running state comes from -l -q --running");
        assert.ok(!c.wslCalls().some((e) => e.argv.includes("-v")), "no locale-dependent -l -v parse");
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
        // Windows PowerShell 5.1 used to prepend the console encoding's UTF-8 preamble (CI byte check, ci.yml).
        assert.notDeepEqual([...c.wslStdin().subarray(0, 3)], [0xef, 0xbb, 0xbf], "no BOM reaches sh");
        assert.deepEqual(c.wslStdin(), c.shBytes, "stdin is the feed's bootstrap.sh, byte for byte");
        assert.doesNotMatch(r.stderr, /could not restore the console input encoding/);
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

      it("the installer's --json stdout comes through byte-identical, non-ASCII included", () => {
        const c = makePsCase({ shell });
        const dir = "C:\\Users\\J\u00fcrgen A\\.openclaw \u00e9\u4e2d";
        const r = c.run(["--json", "--state-dir", dir], { raw: true });
        assert.equal(r.code, 0, r.stderr.toString("utf8"));
        // The fake installer writes JSON.stringify(record) + "\n" to stdout and the same JSON to its mark file.
        assert.deepEqual(r.stdout, Buffer.from(c.markText() + "\n", "utf8"));
        assert.deepEqual(c.installer().argv.slice(2), ["--json", "--state-dir", dir]);
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

// ── --host hermes (HM2 Task 10, HM2-R16; Windows only) ───────────────────────
const WIN_TARGET = (process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE) === "ARM64" ? "win-arm64" : "win-x64";
let pinnedZip = null;
/** The pinned Node "archive": node-v24.21.0-<target>/node.exe = this Node, store-only zip under <dir>/v24.21.0/. */
function pinnedNodeBase() {
  if (!pinnedZip) {
    const base = makeTempDir("plur1bus-nodejs-dist-");
    mkdirSync(join(base, "v24.21.0"), { recursive: true });
    const name = `node-v24.21.0-${WIN_TARGET}`;
    const file = join(base, "v24.21.0", `${name}.zip`);
    writeFileSync(file, makeZip([{ name: `${name}/` }, { name: `${name}/node.exe`, data: readFileSync(process.execPath) }]));
    pinnedZip = { base, file, sha: sha256(readFileSync(file)) };
  }
  return pinnedZip;
}
function renderPs1WithPins(sha) {
  const pins = JSON.parse(readFileSync(NODE_PINS, "utf8"));
  pins.targets[WIN_TARGET].sha256 = sha;
  const dir = makeTempDir("plur1bus-render-pins-");
  writeFileSync(join(dir, "pins.json"), JSON.stringify(pins));
  const r = spawnSync(process.execPath, [RENDER, "--test-key", "--node-pins", join(dir, "pins.json"), "--out-dir", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return join(dir, "install-plugin.ps1");
}
const withHermes = (f) => {
  const h = makeHermesFeed({ provider: { url: "https://example.invalid/TEST-ONLY/p.tgz", sha256: "a".repeat(64) }, binary: { url: "https://example.invalid/TEST-ONLY/b", sha256: "b".repeat(64) }, version: "0.3.0" });
  f.hosts.hermes = h.hosts.hermes;
};

describe("install-plugin.ps1 -Host hermes", { skip: PS_SKIP }, () => {
  before(() => {
    if (!ps1Script) {
      const r = render(["--test-key"]);
      assert.equal(r.status, 0, r.stderr);
      ps1Script = join(r.out, "install-plugin.ps1");
    }
  });
  for (const shell of SHELLS) {
    describe(shell.name, () => {
      it("--host hermes without hermes exits 3 hermes-not-found", () => {
        const c = makePsCase({ shell, native: false, pathNode: "old" });
        for (const args of [["-Host", "hermes"], ["--host", "hermes"]]) {
          const r = c.run(args);
          assert.equal(r.code, 3, r.out);
          assert.match(r.stderr, /hermes-not-found/);
        }
        assert.equal(c.installer(), null);
      });

      it("uses Hermes' own Node when in range; -Host is passed on as --host", () => {
        const c = makePsCase({ shell, native: false, hermes: true, pathNode: "old", hermesNode: "good", feedPatch: withHermes });
        const r = c.run(["-Host", "hermes", "--json"]);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(c.installer().argv.slice(2), ["--host", "hermes", "--json"]);
        assert.equal(c.installer().execPath.toLowerCase(), c.hermesNodePath.toLowerCase());
      });

      it("falls back to the pinned Node download and verifies its sha256; the archive is re-hashed before reuse", () => {
        const z = pinnedNodeBase();
        const script = renderPs1WithPins(z.sha);
        const c = makePsCase({ shell, native: false, hermes: true, pathNode: "old", nodeBase: z.base, feedPatch: withHermes });
        const r = c.run(["--host", "hermes"], { script });
        assert.equal(r.code, 0, r.out);
        assert.ok(c.installer(), r.out);
        assert.match(c.installer().execPath, /node-v24\.21\.0-win-(x64|arm64)[\\/]node\.exe$/i);
        const cached = join(c.localAppData, "plur1bus", "cache", "bootstrap-node-24.21.0", `node-v24.21.0-${WIN_TARGET}.zip`);
        assert.equal(sha256(readFileSync(cached)), z.sha);
        assert.deepEqual(readdirSync(c.tmp), [], "the extracted Node lived in the private temp dir");
        // tampered cache → fetched again
        writeFileSync(cached, Buffer.concat([readFileSync(cached), Buffer.from("x")]));
        const r2 = c.run(["--host", "hermes"], { script });
        assert.equal(r2.code, 0, r2.out);
        assert.match(r2.stderr, /does not match its pinned SHA-256; downloading it again/);
        assert.equal(sha256(readFileSync(cached)), z.sha);
      });

      it("a Node archive hash mismatch exits 1 and runs nothing", () => {
        const z = pinnedNodeBase();
        const c = makePsCase({ shell, native: false, hermes: true, pathNode: "old", nodeBase: z.base, feedPatch: withHermes });
        const r = c.run(["--host", "hermes"], { script: renderPs1WithPins("f".repeat(64)) });
        assert.equal(r.code, 1, r.out);
        assert.match(r.stderr, /checksum mismatch .*node-v24\.21\.0/);
        assert.equal(c.installer(), null);
      });

      it("HERMES_HOME is expanded as Hermes does (%VAR%, $VAR, ~) before Hermes' own Node is looked up (T10 review 3)", () => {
        for (const [hh, dir] of [["%LOCALAPPDATA%\\hh1", "hh1"], ["${LOCALAPPDATA}\\hh2", "hh2"]]) {
          const c = makePsCase({ shell, native: false, hermes: true, pathNode: "old", feedPatch: withHermes, extraEnv: { HERMES_HOME: hh } });
          const node = join(c.localAppData, dir, "node", "node.exe");
          linkOrCopy(process.execPath, node);
          const r = c.run(["-Host", "hermes"]);
          assert.equal(r.code, 0, `${hh}: ${r.out}`);
          assert.equal(c.installer().execPath.toLowerCase(), node.toLowerCase(), hh);
        }
      });

      it("the WSL probe looks for hermes with --host hermes and hands over hosts.hermes.latest", () => {
        const c = makePsCase({ shell, native: false, hermesNode: "good", pathNode: "old", feedPatch: withHermes, distros: [{ name: UBUNTU, running: true, openclaw: true, hermes: true }] });
        const r = c.run(["-Host", "hermes"]);
        assert.equal(r.code, 0, r.out);
        const probes = c.wslCalls().filter((e) => e.argv.includes("-lc"));
        assert.ok(probes.length && probes.every((e) => e.argv[e.argv.length - 1] === "command -v hermes"), JSON.stringify(probes));
        const sh = c.wslCalls().find((e) => e.argv.includes("-s"));
        assert.deepEqual(sh.argv, ["-d", UBUNTU, "-e", "sh", "-s", "--", "--version", "0.3.0", "--host", "hermes"]);
        // a distro with OpenClaw only is no Hermes candidate
        const none = makePsCase({ shell, native: false, hermesNode: "good", pathNode: "old", feedPatch: withHermes, distros: [{ name: UBUNTU, running: true, openclaw: true }] });
        assert.equal(none.run(["-Host", "hermes"]).code, 3);
      });
    });
  }
});
