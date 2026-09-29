// Every platform-conditional test skip must carry a human-readable reason
// (HM1-R22): `skip: process.platform === "win32"` alone hides why a test does
// not run on an OS. The scan is static and covers tests/ and test/.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function listTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...listTests(full)); continue; }
    if (/\.test\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Return the source text of the expression that follows `skip:` (up to the next
// top-level `,`, `}` or `)`), honouring quotes, template literals and brackets.
export function readSkipExpression(src, start) {
  let depth = 0;
  let i = start;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i += 1; i < src.length && src[i] !== ch; i += 1) if (src[i] === "\\") i += 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) break; depth -= 1; }
    else if (ch === "," && depth === 0) break;
  }
  return src.slice(start, i);
}

// A platform skip carries a reason when, after removing the bare comparisons
// against `process.platform`, a string or template literal remains.
export function skipHasReason(expression) {
  const stripped = expression.replace(/process\.platform\s*[!=]==?\s*(["'])[^"']*\1/g, "");
  return /(["'`])(?:\\.|(?!\1)[^\\])+\1/.test(stripped);
}

export function findReasonlessPlatformSkips(src) {
  const bad = [];
  const re = /\bskip\s*:\s*/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const expr = readSkipExpression(src, m.index + m[0].length);
    if (!/process\.platform|\bplatform\b/.test(expr)) continue;
    if (!skipHasReason(expr)) bad.push({ index: m.index, expr: expr.trim() });
  }
  return bad;
}

describe("platform skips", () => {
  it("every platform skip carries a reason string", () => {
    const files = [...listTests(join(ROOT, "tests")), ...listTests(join(ROOT, "test"))];
    const offenders = [];
    for (const file of files) {
      if (file === fileURLToPath(import.meta.url)) continue; // its own fixtures
      const src = readFileSync(file, "utf8");
      for (const hit of findReasonlessPlatformSkips(src)) {
        const line = src.slice(0, hit.index).split("\n").length;
        offenders.push(`${relative(ROOT, file)}:${line}: skip: ${hit.expr}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("the scanner flags a reasonless skip and accepts a reasoned one", () => {
    assert.equal(findReasonlessPlatformSkips('it("x", { skip: process.platform === "win32" }, f)').length, 1);
    assert.equal(findReasonlessPlatformSkips('it("x", { skip: process.platform === "win32" && "no chmod" }, f)').length, 0);
    assert.equal(findReasonlessPlatformSkips('const s = { skip: process.platform === "win32" ? "why" : false };').length, 0);
    assert.equal(findReasonlessPlatformSkips("const s = { skip: `unavailable on ${process.platform}` };").length, 0);
    assert.equal(findReasonlessPlatformSkips('it("x", { skip: typeof y !== "function" }, f)').length, 0);
  });
});
