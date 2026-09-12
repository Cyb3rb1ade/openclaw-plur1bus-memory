import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { forgetTempDir, makeTempDir, trackedTempDirs } from "./helpers/temp-dir.js";

const HELPER = new URL("./helpers/temp-dir.js", import.meta.url).pathname;

function runChild(body) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { makeTempDir, forgetTempDir } from ${JSON.stringify(HELPER)};
    ${body}
  `], { encoding: "utf8" }).trim();
}

describe("Aufräumender Test-Temp-Helfer", () => {
  it("legt das Verzeichnis unter dem gewünschten Präfix an und merkt es vor", () => {
    const dir = makeTempDir("temp-helper-probe-");
    assert.equal(existsSync(dir), true);
    assert.ok(dir.startsWith(join(tmpdir(), "temp-helper-probe-")));
    assert.ok(trackedTempDirs().includes(dir));
    forgetTempDir(dir);
    assert.ok(!trackedTempDirs().includes(dir));
    // Abgemeldet heißt: der Test räumt selbst auf.
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  });

  it("löscht beim Prozessende auch nach einer Ausnahme und mit Inhalt", () => {
    const printed = runChild(`
      const dir = makeTempDir("temp-helper-exit-");
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(dir + "/nested");
      writeFileSync(dir + "/nested/file.txt", "inhalt");
      console.log(dir);
      process.on("uncaughtException", () => { process.exitCode = 0; });
      setTimeout(() => { throw new Error("Testfehler"); }, 0);
    `);
    const dir = printed.split("\n").pop();
    assert.ok(dir.includes("temp-helper-exit-"), printed);
    assert.equal(existsSync(dir), false, "das Verzeichnis überlebt den Prozess nicht");
  });

  it("respektiert ein abgemeldetes Verzeichnis und ein fremdes Wurzelverzeichnis", () => {
    const kept = runChild(`
      const dir = makeTempDir("temp-helper-kept-");
      forgetTempDir(dir);
      console.log(dir);
    `).split("\n").pop();
    assert.equal(existsSync(kept), true);
    const custom = makeTempDir("temp-helper-root-", tmpdir());
    assert.ok(custom.startsWith(tmpdir()));
    // Aufräumen, was der Kindprozess bewusst stehen ließ.
    execFileSync("rm", ["-rf", kept]);
  });

  // Wächter: neue Tests sollen nicht wieder selbst mkdtemp aufrufen, sonst
  // sammeln sich die Verzeichnisse erneut an (33 000 Reste im September 2026).
  it("kein Test legt noch selbst ein temporäres Verzeichnis an", () => {
    const testsDir = new URL("./", import.meta.url).pathname;
    const self = "temp-dir-helper.test.js";
    const direct = ["mkdtemp", "Sync("].join("");
    const offenders = readdirSync(testsDir)
      .filter((name) => (name.endsWith(".test.js") || name.endsWith(".mjs")) && name !== self)
      .filter((name) => readFileSync(join(testsDir, name), "utf8").includes(direct));
    assert.deepEqual(offenders, [], "diese Dateien umgehen den aufräumenden Helfer");
  });
});
