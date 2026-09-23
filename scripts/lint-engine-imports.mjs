/**
 * scripts/lint-engine-imports.mjs
 *
 * The dependency rule for the extraction (engine-extraction.md §b.1, §c PR-03):
 *
 *   1. `engine/**` never imports the host. Forbidden: the `openclaw` package
 *      and its subpaths, `lib/setup/*-plugin-runtime.js`,
 *      `lib/runtime-shutdown.js`, `lib/host-services.js`,
 *      `lib/providers/openclaw-memory-embedding-adapters.js`.
 *   2. Neither `engine/**` nor `adapter/**` imports `index.js`. Everything they
 *      need arrives through their context object. An import back into the
 *      plugin shell is how an ESM cycle gets in, and a cycle yields an
 *      `undefined` binding at call time rather than a load error.
 *   3. No import cycle inside `engine/** + adapter/**`.
 *   4. `engine/**` never reads `.api` off anything. `HostServices` carries a
 *      transitional `api` escape hatch (lib/host-services.js, Task 9) for the
 *      adapter's benefit; engine code reaching through it (`host.api.on(…)`)
 *      re-couples the engine to OpenClaw through the back door.
 *      `scripts/lint-no-api-outside-adapter.mjs` deliberately does not match a
 *      dotted receiver, so this rule lives here.
 *   5. `engine/**` never names a bare `api` either. Rule 4 only sees a member
 *      read; a range lifted verbatim out of `register()` arrives holding the
 *      parameter itself (`function f(api)`, `const { api } = ctx`), which is
 *      the same coupling one indirection earlier. PR-03 moved seven such
 *      ranges and every one of them had to be checked by hand for this.
 *   6. Transitive: every lib/** module reachable from engine/** through
 *      relative imports obeys rule 1 too. A reached forbidden module is
 *      reported with the chain that reaches it and is not walked further.
 *   7. No `process.env.OPENCLAW_*` read and no literal "openclaw/…" load
 *      specifier (import()/require()/resolve()) on that graph. Host paths come
 *      from HostServices / lib/host-paths.js; host SDK modules from
 *      lib/host-sdk-loader.js.
 *
 * Rules 4 and 5 are text rules over the source lines, not a syntax-aware
 * parser. Line comments, single-line block comments and simple quoted strings
 * are stripped per line; a multi-line block comment's continuation line is
 * only stripped when it starts with `*` (the convention every such comment in
 * this codebase follows) — a continuation line without a leading `*` is
 * scanned as code, so it produces a loud false positive rather than a silent
 * miss. Template literals are left alone too, so `${host.api}` is still
 * caught. Consequence worth knowing: an `engine/**` comment may not spell
 * `api` followed by a dot, and a doc comment describing the adapter has to
 * say "the host's `registerTool`" instead.
 *
 * dependency-cruiser is not installed and cannot be installed offline, so this
 * is a small static walker: it reads `import … from "x"`, `export … from "x"`
 * and `import("x")` with a literal specifier. That covers every form the
 * codebase uses (`"type": "module"`, no `require`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Optional root argument. The repo is the default; the test suite points this
// at a tmpdir so its fixtures never touch the working tree (a crashed test run
// must not be able to leave a probe module behind that then fails `npm run
// lint` for everyone).
const root = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), "..");

const ROOTS = ["engine", "adapter"];

const FORBIDDEN_FOR_ENGINE = [
  { test: (spec) => spec === "openclaw" || spec.startsWith("openclaw/"), why: "the openclaw package" },
  { test: (spec, target) => target === "lib/runtime-shutdown.js", why: "lib/runtime-shutdown.js (adapter lifecycle)" },
  { test: (spec, target) => target === "lib/host-services.js", why: "lib/host-services.js (built from the OpenClaw api)" },
  { test: (spec, target) => target === "lib/providers/openclaw-memory-embedding-adapters.js", why: "the OpenClaw embedding adapter" },
  { test: (spec, target) => /^lib\/setup\/[^/]+-plugin-runtime\.js$/.test(target || ""), why: "a lib/setup plugin runtime" },
];

const IMPORT_PATTERNS = [
  /(?:^|\n)\s*import\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*export\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  // The package is `"type": "module"` and uses no `require`, but a copied
  // snippet or a createRequire escape would otherwise slip the whole rule set.
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** A member read of `api` off any receiver: `host.api`, `services.api.on`, … */
const DOTTED_API_REFERENCE = /\.\s*api\b/;

/**
 * A bare `api` identifier: a parameter, a destructured ctx key, a shorthand
 * property. The lookbehind keeps this disjoint from DOTTED_API_REFERENCE so
 * each violation is reported once, under the rule that explains it.
 */
const BARE_API_IDENTIFIER = /(?<![.\w$])api(?![\w$])/;

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* walk(full);
    } else if (entry.isFile() && /\.m?js$/.test(entry.name)) {
      yield full;
    }
  }
}

function toPosix(value) {
  return value.split(sep).join("/");
}

/**
 * Remove block comments and everything after a `//`. Crude on purpose: it also
 * truncates a line at a URL's `//`, which is exactly what we want, since a
 * hostname is never a reference to the plugin API.
 * @param {string} line Source line.
 * @returns {string} Line with comments removed.
 */
function stripComments(line) {
  return line.replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
}

/**
 * Comments plus simple `'…'` / `"…"` literals, so prose inside a message
 * string is not read as a reference. Template literals are deliberately left
 * alone: `${host.api}` is a real read, not prose.
 * @param {string} line Source line.
 * @returns {string} Line with comments and quoted strings removed.
 */
function stripCommentsAndStrings(line) {
  return stripComments(line)
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/**
 * @param {string} fromFile Absolute path of the importing file.
 * @param {string} spec Import specifier.
 * @returns {string|null} Repo-relative POSIX path, or null for a bare package.
 */
function resolveTarget(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  return toPosix(relative(root, resolve(dirname(fromFile), spec)));
}

function importsOf(source) {
  const specs = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      specs.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return [...specs];
}

const violations = [];
const graph = new Map();

for (const scanRoot of ROOTS) {
  const base = join(root, scanRoot);
  try {
    if (!statSync(base).isDirectory()) continue;
  } catch {
    continue;
  }
  for (const file of walk(base)) {
    const from = toPosix(relative(root, file));
    const source = readFileSync(file, "utf8");
    const edges = [];
    for (const spec of importsOf(source)) {
      const target = resolveTarget(file, spec);
      if (target === "index.js") {
        violations.push(`${from}: imports index.js — pass what you need through the context object instead`);
      }
      if (from.startsWith("engine/")) {
        for (const rule of FORBIDDEN_FOR_ENGINE) {
          if (rule.test(spec, target)) violations.push(`${from}: engine code must not import ${rule.why} (\`${spec}\`)`);
        }
      }
      if (target && (target.startsWith("engine/") || target.startsWith("adapter/"))) edges.push(target);
    }
    if (from.startsWith("engine/")) {
      source.split("\n").forEach((line, index) => {
        const code = stripCommentsAndStrings(line);
        if (DOTTED_API_REFERENCE.test(code)) {
          violations.push(`${from}:${index + 1}: engine code must not read the HostServices \`api\` escape hatch — use the typed HostServices members (${line.trim()})`);
        }
        if (BARE_API_IDENTIFIER.test(code)) {
          violations.push(`${from}:${index + 1}: engine code must not name the OpenClaw \`api\` — it stays in adapter/openclaw/** and reaches the engine only as typed HostServices members (${line.trim()})`);
        }
      });
    }
    graph.set(from, edges);
  }
}

// Rule 6/7: walk engine/** through lib/** relative imports, applying the
// forbidden-import rule transitively and flagging `process.env.OPENCLAW_*`
// reads and literal `openclaw/…` load specifiers on every reached module. A
// forbidden module is reported where it is reached and not descended into
// (spec §6 R-3), so its own imports are never re-reported.
const ENV_READ = /process\.env(?:\.|\[\s*["'`])OPENCLAW_/;
const OPENCLAW_LOAD = /\b(?:import|require|resolve)\s*\(\s*[`"']openclaw(?:[/`"'])/;
const forbiddenWhy = (spec, target) => FORBIDDEN_FOR_ENGINE.find((rule) => rule.test(spec, target))?.why ?? null;

/**
 * Resolve a relative import specifier to an absolute file path, defaulting a
 * missing extension to `.js`. Returns null for a bare package specifier.
 * @param {string} fromFile Absolute path of the importing file.
 * @param {string} spec Import specifier.
 * @returns {string|null} Absolute path, or null for a bare package.
 */
function resolveModule(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  let target = resolve(dirname(fromFile), spec);
  if (!/\.m?js$/.test(target)) target = `${target}.js`;
  return target;
}

const reached = new Map();
const queue = [];
for (const [from] of graph) {
  if (from.startsWith("engine/")) queue.push({ file: join(root, from), chain: [from] });
}
while (queue.length > 0) {
  const { file, chain } = queue.shift();
  const rel = toPosix(relative(root, file));
  if (reached.has(rel)) continue;
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  reached.set(rel, chain);
  source.split("\n").forEach((line, index) => {
    const code = stripComments(line);
    if (ENV_READ.test(code)) violations.push(`env: ${rel}:${index + 1}: process.env.OPENCLAW_* read on the engine graph (via ${chain.join(" -> ")})`);
    if (!rel.startsWith("engine/") && OPENCLAW_LOAD.test(code)) violations.push(`transitive: ${chain.join(" -> ")}: loads the openclaw package (${line.trim()})`);
  });
  for (const spec of importsOf(source)) {
    const targetAbs = resolveModule(file, spec);
    const target = targetAbs ? toPosix(relative(root, targetAbs)) : null;
    const why = forbiddenWhy(spec, target);
    if (why && !rel.startsWith("engine/")) {
      violations.push(`transitive: ${chain.concat(target ?? spec).join(" -> ")}: engine graph must not reach ${why}`);
      continue;
    }
    if (why) continue; // rule 1 already reported this direct import
    if (target && target.startsWith("lib/")) queue.push({ file: targetAbs, chain: chain.concat(target) });
  }
}

// Depth-first cycle detection over the engine+adapter subgraph.
const WHITE = 0;
const GREY = 1;
const BLACK = 2;
const colour = new Map([...graph.keys()].map((key) => [key, WHITE]));
const stack = [];

function visit(node) {
  colour.set(node, GREY);
  stack.push(node);
  for (const next of graph.get(node) || []) {
    if (!graph.has(next)) continue;
    const state = colour.get(next);
    if (state === GREY) {
      const cycle = stack.slice(stack.indexOf(next)).concat(next);
      violations.push(`import cycle: ${cycle.join(" -> ")}`);
    } else if (state === WHITE) {
      visit(next);
    }
  }
  stack.pop();
  colour.set(node, BLACK);
}

for (const node of graph.keys()) if (colour.get(node) === WHITE) visit(node);

if (violations.length > 0) {
  console.error("Engine/adapter dependency rule violated:\n");
  for (const violation of [...new Set(violations)]) console.error(`  ${violation}`);
  console.error(`\n${new Set(violations).size} violation(s)`);
  process.exit(1);
}
console.log(
  `lint-engine-imports: clean (${graph.size} module(s), ${reached.size - [...graph.keys()].filter((k) => k.startsWith("engine/")).length} lib module(s) reached)`,
);
