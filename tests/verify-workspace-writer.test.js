import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { run as runWorkspaceWriter } from "../scripts/verify-workspace-writer.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL("../scripts/verify-workspace-writer.mjs", import.meta.url),
);

/**
 * Runs the script as a child process with the given environment.
 * Non-zero exits are returned without throwing.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
async function runScript(env) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(" ")); };
  try {
    const result = await runWorkspaceWriter({ env });
    return { stdout: lines.join("\n"), stderr: "", code: result.exitCode };
  } finally {
    console.log = originalLog;
  }
}

/**
 * Recursively collects .md file names inside a directory.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function findMdFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".md"));
}

describe("verify-workspace-writer.mjs", () => {
  let tempHome;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "verify-writer-test-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("exists and is syntactically valid", async () => {
    await execFileAsync("node", ["--check", scriptPath]);
  });

  it("returns exit 0 when workspace memory paths are writable", async () => {
    mkdirSync(join(tempHome, "workspace", "memory"), { recursive: true });

    const result = await runScript({
      ...process.env,
      OPENCLAW_HOME: tempHome,
    });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes("all 1 workspace memory path(s)"));
    assert.ok(existsSync(join(tempHome, "workspace", "memory", ".healthcheck")));
    assert.strictEqual(findMdFiles(join(tempHome, "workspace", "memory")).length, 0);
  });

  it("returns exit 1 with a clear warning when no workspaces are found", async () => {
    const result = await runScript({
      ...process.env,
      OPENCLAW_HOME: tempHome,
    });

    assert.strictEqual(result.code, 1);
    assert.ok(result.stdout.includes("warning"));
    assert.ok(result.stdout.includes("no workspace memory paths found"));
  });

  it("returns exit 1 when the target path is not writable", async () => {
    mkdirSync(join(tempHome, "workspace", "memory"), { recursive: true });
    writeFileSync(join(tempHome, "workspace", "memory", ".healthcheck"), "block");

    const result = await runScript({
      ...process.env,
      OPENCLAW_HOME: tempHome,
    });

    assert.strictEqual(result.code, 1);
    assert.ok(result.stdout.includes("warning"));
    assert.strictEqual(findMdFiles(join(tempHome, "workspace", "memory")).length, 0);
  });

  it("discovers multiple workspace directories including agent-specific ones", async () => {
    mkdirSync(join(tempHome, "workspace", "memory"), { recursive: true });
    mkdirSync(join(tempHome, "workspace-agent-a", "memory"), { recursive: true });

    const result = await runScript({
      ...process.env,
      OPENCLAW_HOME: tempHome,
    });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes("all 2 workspace memory path(s)"));
  });

  it("honors a configured openclaw.json path", async () => {
    mkdirSync(join(tempHome, "custom-home", "workspace", "memory"), { recursive: true });
    mkdirSync(join(tempHome, ".openclaw"), { recursive: true });
    writeFileSync(
      join(tempHome, ".openclaw", "openclaw.json"),
      JSON.stringify({ openclawHome: "../custom-home" }),
    );

    const result = await runScript({
      ...process.env,
      HOME: tempHome,
      OPENCLAW_HOME: "",
    });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes("all 1 workspace memory path(s)"));
  });
});
