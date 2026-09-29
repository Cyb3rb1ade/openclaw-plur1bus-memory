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

// Split the expression at top-level-or-nested `&&`, `||`, `? :` operators
// (ignoring quotes and optional chaining) and return the trimmed segments.
function valueSegments(expression) {
  const segments = [];
  let current = "";
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      for (; j < expression.length && expression[j] !== ch; j += 1) if (expression[j] === "\\") j += 1;
      current += expression.slice(i, j + 1);
      i = j;
      continue;
    }
    const two = expression.slice(i, i + 2);
    if (two === "&&" || two === "||") { segments.push(current); current = ""; i += 1; continue; }
    if (ch === "?" && expression[i + 1] !== ".") { segments.push(current); current = ""; continue; }
    if (ch === ":") { segments.push(current); current = ""; continue; }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.replace(/^[\s(]+|[\s)]+$/g, ""));
}

// A platform skip carries a reason when one of the expression's value segments
// is, by itself, a non-empty string or template literal (`cond && "why"`,
// `cond ? "why" : false`, or a bare template). A literal that is only the
// operand of a comparison (`=== "win32"`) does not count.
export function skipHasReason(expression) {
  return valueSegments(expression).some((segment) => /^(["'`])(?:\\.|(?!\1)[^\\])+\1$/.test(segment));
}

// Covered forms: `skip:` option values mentioning `platform`, and an argument-less
// `x.skip()` directly under an `if (... process.platform ...)` condition.
export function findReasonlessPlatformSkips(src) {
  const bad = [];
  const re = /\bskip\s*:\s*/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const expr = readSkipExpression(src, m.index + m[0].length);
    if (!/process\.platform|\bplatform\b/.test(expr)) continue;
    if (!skipHasReason(expr)) bad.push({ index: m.index, expr: expr.trim() });
  }
  const bare = /\bif\s*\([^)\n]*process\.platform[^)\n]*\)\s*\{?\s*(?:return\s+)?\w+\.skip\(\s*\)/g;
  for (let m = bare.exec(src); m; m = bare.exec(src)) bad.push({ index: m.index, expr: m[0].trim() });
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
    assert.equal(findReasonlessPlatformSkips('const s = { skip: process.platform === "win32" || "" };').length, 1);
    assert.equal(findReasonlessPlatformSkips('const s = { skip: process.getuid?.() === 0 || (process.platform === "win32" && "why") };').length, 0);
    assert.equal(findReasonlessPlatformSkips('if (process.platform === "win32") return t.skip();').length, 1);
    assert.equal(findReasonlessPlatformSkips('if (process.platform === "win32") return t.skip("why");').length, 0);
  });
});
