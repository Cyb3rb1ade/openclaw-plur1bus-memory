import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIZARD_PATH = join(__dirname, "..", "scripts", "provider-wizard.mjs");

function parseWizardResult(stdout) {
  const jsonStart = stdout.indexOf("{");
  return jsonStart === -1 ? null : JSON.parse(stdout.slice(jsonStart));
}

function runWizard(lines) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [WIZARD_PATH], {
      cwd: join(__dirname, ".."),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sentLines = 0;
    let stdinEnding = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`provider wizard timed out; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
    }, 5_000);

    function answerVisiblePrompts() {
      const promptCount = (stdout.match(/\[(?:1\/2|1\/2\/3\/4|a\/b\/c)\]: /g) || []).length;
      while (sentLines < lines.length && sentLines < promptCount) {
        child.stdin.write(`${lines[sentLines]}\n`);
        sentLines += 1;
      }
      if (sentLines === lines.length && !stdinEnding) {
        stdinEnding = true;
        setTimeout(() => {
          if (!child.stdin.destroyed) child.stdin.end();
        }, 20);
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      answerVisiblePrompts();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("provider wizard CLI input validation", () => {
  it("reprompts after an invalid advanced choice and keeps reranking enabled", async () => {
    const result = await runWizard(["2", "4", "x", "b"]);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual((result.stdout.match(/\[a\/b\/c\]:/g) || []).length, 2);
    assert.match(result.stderr, /a, b, or c/);
    assert.deepStrictEqual(parseWizardResult(result.stdout)?.reranker, {
      provider: "local-transformers",
      model: "jinaai/jina-reranker-v2-base-multilingual",
      candidates: 20,
      timeoutMs: 5000,
      fallbackOnError: true,
    });
  });

  it("requires an exact advanced token instead of accepting a valid prefix", async () => {
    const result = await runWizard(["2", "4", "a-extra", "c"]);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual((result.stdout.match(/\[a\/b\/c\]:/g) || []).length, 2);
    assert.strictEqual(
      parseWizardResult(result.stdout)?.reranker?.model,
      "mixedbread-ai/mxbai-rerank-base-v2",
    );
  });

  it("reprompts for multi-letter and whitespace-only advanced tokens", async () => {
    const result = await runWizard(["2", "4", "aa", "   ", "a"]);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual((result.stdout.match(/\[a\/b\/c\]:/g) || []).length, 3);
    assert.strictEqual(
      parseWizardResult(result.stdout)?.reranker?.model,
      "Alibaba-NLP/gte-reranker-modernbert-base",
    );
  });

  it("fails without final JSON when input ends after an invalid advanced choice", async () => {
    const result = await runWizard(["2", "4", "x"]);

    assert.notStrictEqual(result.code, 0);
    assert.strictEqual(parseWizardResult(result.stdout), null);
  });

  it("retains explicit top-level disable as the only disabled path", async () => {
    const result = await runWizard(["2", "3"]);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.deepStrictEqual(parseWizardResult(result.stdout)?.reranker, {
      provider: "disabled",
      enabled: false,
      candidates: 20,
    });
  });

  it("retains the default local BGE reranker choice", async () => {
    const result = await runWizard(["2", "2"]);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.deepStrictEqual(parseWizardResult(result.stdout)?.reranker, {
      provider: "local-transformers",
      model: "BAAI/bge-reranker-v2-m3",
      candidates: 20,
      timeoutMs: 5000,
      fallbackOnError: true,
    });
  });
});
