import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

// Regression 02.10.2026: the bootstrap reads `setup-feature-crons.mjs --json`
// through a pipe; process.exit() right after writing ~170 KB truncated the
// JSON at 64 KiB and every gateway start logged planCreateCount=1.
test("die Einrichtung beendet sich über exitCode, nicht über process.exit", () => {
  const source = readFileSync(new URL("../scripts/setup-feature-crons.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("if (IS_MAIN)"));
  assert.match(main, /process\.exitCode = code/);
  assert.doesNotMatch(main, /process\.exit\(/);
});

test("exitCode lässt große Ausgaben vollständig durch die Pipe", async () => {
  const size = 200_000;
  const child = spawn(process.execPath, ["-e", `process.stdout.write("x".repeat(${size})); process.exitCode = 0;`], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let received = 0;
  child.stdout.on("data", (chunk) => { received += chunk.length; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(received, size);
});
