/**
 * tests/helpers/sandbox-common.js — TEST ONLY machinery shared by installer-sandbox.js (OpenClaw)
 * and hermes-sandbox.js (Hermes), ruling F37: PATH lookup, the "PATH resolves only our shim" guard,
 * the Windows environment the shims need, the shim launchers and an output sink.
 */

import { accessSync, constants, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Find `name` on a PATH string the way the installer does (first executable hit). */
export function resolveOnPath(name, pathValue) {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** Throw unless `name` on env.PATH is the sandbox's own shim in binDir (never a real install). */
export function assertShimOnPath(name, env, binDir, label) {
  const resolved = resolveOnPath(name, env.PATH);
  const expected = join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
  if (!resolved || realpathSync(resolved) !== realpathSync(expected)) {
    throw new Error(`${label}: PATH resolves ${name} to ${resolved}, not the sandbox shim ${expected}`);
  }
}

/**
 * A launcher for a Node shim script: `<binDir>/<name>` (POSIX, `exec "<node>" "<script>"`) or `<name>.cmd` (Windows;
 * `%~dp0` because cmd.exe reads a batch file in the OEM code page, so a literal UTF-8 path came out garbled).
 * @param {{ via?: string }} [o] POSIX only: exec through this launcher instead of the real node (the openclaw shim's
 *   install-cli.sh shape)
 */
export function writeLauncher(binDir, name, scriptFile, o = {}) {
  const real = process.execPath;
  if (process.platform === "win32") {
    writeFileSync(join(binDir, `${name}.cmd`), `@"${real}" "%~dp0${scriptFile}" %*\r\n`);
  } else {
    writeFileSync(join(binDir, name), `#!/bin/sh\nexec "${o.via ?? real}" "${join(binDir, scriptFile)}" "$@"\n`, { mode: 0o755 });
  }
}

/**
 * The Windows variables a .cmd shim run through cmd.exe needs (without SystemRoot/ComSpec and System32 on PATH every
 * shim call exited 127 on the Windows legs). System32 holds no openclaw, hermes or node, so the shim guard still holds.
 */
export function addWindowsEnv(env, binDir) {
  if (process.platform !== "win32") return env;
  env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  const sysRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  env.SystemRoot = sysRoot;
  env.windir = sysRoot;
  env.ComSpec = process.env.ComSpec ?? process.env.COMSPEC ?? join(sysRoot, "System32", "cmd.exe");
  for (const k of ["PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "NUMBER_OF_PROCESSORS", "OS", "SystemDrive"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  env.PATH = [binDir, join(sysRoot, "System32"), join(sysRoot, "System32", "WindowsPowerShell", "v1.0")].join(delimiter);
  return env;
}

/** Collect a writable's output. */
export function sink() {
  let text = "";
  return { write: (c) => { text += String(c); return true; }, get text() { return text; } };
}
