#!/usr/bin/env node
/**
 * Throwaway Windows ACL-read probe (Phase 1). Times built-in tools, cold then
 * warm, and prints a markdown table. No new dependencies. Run on windows-2025
 * and windows-11-arm only.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNS = 5;
const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sidType = [System.Security.Principal.SecurityIdentifier]",
  "$acl = [System.IO.Directory]::GetAccessControl($env:PLUR1BUS_ACL_PATH)",
  "$aces = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType } })",
  "[pscustomobject]@{ ownerSid = $acl.GetOwner($sidType).Value; userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; aces = $aces } | ConvertTo-Json -Compress -Depth 4",
].join("\n");
const PS_ENCODED = Buffer.from(PS_SCRIPT, "utf16le").toString("base64");

const root = mkdtempSync(join(tmpdir(), "acl-probe-"));
const target = join(root, "dir");
mkdirSync(target);
const sample = join(root, "sample");
mkdirSync(sample);

function ms(ns) {
  return Number(ns) / 1e6;
}

function timeCall(fn) {
  const t0 = process.hrtime.bigint();
  let error = null;
  let output = "";
  try {
    output = fn() ?? "";
  } catch (err) {
    error = `${err.code || ""} ${err.message}`.trim();
  }
  return { ms: ms(process.hrtime.bigint() - t0), error, output: String(output) };
}

function runSeries(name, fn) {
  const cold = [];
  for (let i = 0; i < RUNS; i += 1) cold.push(timeCall(fn));
  const warm = [];
  for (let i = 0; i < RUNS; i += 1) warm.push(timeCall(fn));
  return { name, cold, warm };
}

function preview(text, limit = 400) {
  const one = String(text).replace(/\r\n/g, "\n").replace(/\0/g, "");
  return one.length <= limit ? one : `${one.slice(0, limit)}…`;
}

function aclChildEnv() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === "psmodulepath") continue;
    out[key] = value;
  }
  out.PLUR1BUS_ACL_PATH = target;
  return out;
}

function exec(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 60_000,
    ...opts,
  });
}

const wmiVbs = join(root, "wmi.vbs");
writeFileSync(wmiVbs, [
  "Option Explicit",
  "Dim path, wmi, file, out, sd, owner, dacl, i, ace, line",
  "path = WScript.Arguments.Item(0)",
  "Set wmi = GetObject(\"winmgmts:root\\cimv2\")",
  "Set file = wmi.Get(\"Win32_LogicalFileSecuritySetting.Path=\"\"\" & Replace(path, \"\\\", \"\\\\\") & \"\"\"\")",
  "Set out = file.ExecMethod_(\"GetSecurityDescriptor\")",
  "If out.ReturnValue <> 0 Then",
  "  WScript.Echo \"ERR return=\" & out.ReturnValue",
  "  WScript.Quit 1",
  "End If",
  "Set sd = out.Descriptor",
  "Set owner = sd.Owner",
  "WScript.Echo \"OWNER=\" & owner.SIDString",
  "Set dacl = sd.DACL",
  "If IsNull(dacl) Then",
  "  WScript.Echo \"DACL=NULL\"",
  "Else",
  "  For i = 0 To UBound(dacl)",
  "    Set ace = dacl(i)",
  "    WScript.Echo \"ACE type=\" & ace.AceType & \" sid=\" & ace.Trustee.SIDString",
  "  Next",
  "End If",
].join("\r\n"), "utf8");

const adsVbs = join(root, "ads.vbs");
writeFileSync(adsVbs, [
  "Option Explicit",
  "Dim path, util, sd",
  "path = WScript.Arguments.Item(0)",
  "On Error Resume Next",
  "Set util = CreateObject(\"ADsSecurityUtility\")",
  "If Err.Number <> 0 Then",
  "  WScript.Echo \"ERR create=\" & Err.Number & \" \" & Err.Description",
  "  WScript.Quit 1",
  "End If",
  "Set sd = util.GetSecurityDescriptor(path, 1, 1)",
  "If Err.Number <> 0 Then",
  "  WScript.Echo \"ERR get=\" & Err.Number & \" \" & Err.Description",
  "  WScript.Quit 1",
  "End If",
  "WScript.Echo \"OWNER=\" & sd.Owner",
  "WScript.Echo \"GROUP=\" & sd.Group",
  "WScript.Echo \"Revision=\" & sd.Revision",
].join("\r\n"), "utf8");

const icaclsSave = join(root, "acl.txt");

const tools = [
  {
    name: "powershell-5.1-current",
    fn: () => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", PS_ENCODED], { env: aclChildEnv(), stdio: ["ignore", "pipe", "ignore"] }),
  },
  {
    name: "pwsh-7-same-script",
    fn: () => exec("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", PS_ENCODED], { env: aclChildEnv(), stdio: ["ignore", "pipe", "ignore"] }),
  },
  {
    name: "whoami-user-csv",
    fn: () => exec("whoami.exe", ["/user", "/fo", "csv", "/nh"]),
  },
  {
    name: "icacls-save",
    fn: () => {
      try { rmSync(icaclsSave); } catch { /* first run */ }
      exec("icacls.exe", [target, "/save", icaclsSave, "/Q"], { stdio: ["ignore", "pipe", "ignore"] });
      const buf = readFileSync(icaclsSave);
      const text = buf[0] === 0xFF && buf[1] === 0xFE
        ? buf.subarray(2).toString("utf16le")
        : buf.toString("utf8");
      return text;
    },
  },
  {
    name: "cscript-wmi-sd",
    fn: () => exec("cscript.exe", ["//Nologo", wmiVbs, target]),
  },
  {
    name: "cscript-adssecurity",
    fn: () => exec("cscript.exe", ["//Nologo", adsVbs, target]),
  },
  {
    name: "cmd-spawn-baseline",
    fn: () => exec("cmd.exe", ["/c", "echo", "ok"]),
  },
];

const rows = [];
for (const tool of tools) {
  rows.push(runSeries(tool.name, tool.fn));
}

function stats(runs) {
  const ok = runs.filter((r) => !r.error);
  const times = (ok.length ? ok : runs).map((r) => r.ms);
  const sorted = [...times].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return {
    nOk: ok.length,
    n: runs.length,
    first: times[0],
    min: sorted[0],
    median: mid,
    max: sorted[sorted.length - 1],
    error: runs.find((r) => r.error)?.error || "",
    sample: preview((ok[0] || runs[0]).output),
  };
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(1) : "n/a";
}

const lines = [];
lines.push(`# ACL probe ${process.arch} ${process.platform}`);
lines.push(`target=${target}`);
lines.push("");
lines.push("| tool | cold first ms | cold min/med/max | warm min/med/max | ok cold/warm | sample / error |");
lines.push("|---|---:|---|---|---|---|");
for (const row of rows) {
  const c = stats(row.cold);
  const w = stats(row.warm);
  lines.push(
    `| ${row.name} | ${fmt(c.first)} | ${fmt(c.min)}/${fmt(c.median)}/${fmt(c.max)} | ${fmt(w.min)}/${fmt(w.median)}/${fmt(w.max)} | ${c.nOk}/${c.n} · ${w.nOk}/${w.n} | \`${(c.sample || c.error || w.error).replace(/\|/g, "\\|").replace(/\n/g, " ")}\` |`,
  );
}

const icaclsHasOwner = /O:/.test(rows.find((r) => r.name === "icacls-save")?.cold[0]?.output || "");
lines.push("");
lines.push(`icacls /save contains O: ${icaclsHasOwner}`);
lines.push("");
lines.push("## raw first-run output");
for (const row of rows) {
  const first = row.cold[0];
  lines.push(`### ${row.name}`);
  lines.push("```");
  lines.push(first.error ? `ERROR ${first.error}` : preview(first.output, 1200));
  lines.push("```");
}

const report = lines.join("\n");
process.stdout.write(`${report}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, report, { flag: "a" });
}
rmSync(root, { recursive: true, force: true });
