/**
 * tools/free-identifiers.mjs — list the identifiers a line range of a
 * module uses but does not declare, minus module-level imports and globals.
 *
 * Usage: node tools/free-identifiers.mjs <file> <startLine> <endLine>
 *
 * Developer-only: `tools/` is deliberately outside `package.json:files`, so
 * this never ships. It exists so PR-03's moves derive their context-object key
 * set mechanically instead of by reading the closure and hoping.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// typescript is an optionalDependency (also a runtime optional dep of
// lib/code-index/workspace-indexer.js). Resolve it the way scripts/typecheck.mjs
// does — createRequire from this file — rather than a bare `import`, so a
// missing optional install fails with a plain message instead of an
// ERR_MODULE_NOT_FOUND stack.
const require = createRequire(import.meta.url);
let ts;
try {
  ts = require("typescript");
} catch {
  console.error("free-identifiers: typescript is not installed (optionalDependency); run `npm install`.");
  process.exit(2);
}

const [file, startArg, endArg] = process.argv.slice(2);
const startLine = Number(startArg);
const endLine = Number(endArg);
const text = readFileSync(file, "utf8");
const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

// Identifiers declared at module top level (imports, top-level const/function/class).
const moduleScope = new Set();
for (const st of sf.statements) {
  if (ts.isImportDeclaration(st) && st.importClause) {
    const c = st.importClause;
    if (c.name) moduleScope.add(c.name.text);
    if (c.namedBindings) {
      if (ts.isNamespaceImport(c.namedBindings)) moduleScope.add(c.namedBindings.name.text);
      else for (const e of c.namedBindings.elements) moduleScope.add(e.name.text);
    }
  } else if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) collectBindingNames(d.name, moduleScope);
  } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
    moduleScope.add(st.name.text);
  }
}

function collectBindingNames(node, out) {
  if (ts.isIdentifier(node)) { out.add(node.text); return; }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const el of node.elements) {
      if (ts.isOmittedExpression(el)) continue;
      collectBindingNames(el.name, out);
    }
  }
}

// Walk the whole file with a scope stack; when inside the range, record
// identifier references that resolve outside the range.
const declaredInRange = new Set();
const free = new Map();
// The line `register(api, registrationDependencies = {})` begins on. It only
// separates "declared at module top level, so import it" from "declared inside
// `register`, so pass it in"; if index.js shifts, update the constant and
// re-run. Re-derived at fd5bac5b: `grep -n 'register(api' index.js`.
const registerStart = 4395;
const scopes = [new Map()];

function isScopeNode(n) {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n)
    || ts.isSetAccessor(n) || ts.isBlock(n) || ts.isForStatement(n) || ts.isForOfStatement(n)
    || ts.isForInStatement(n) || ts.isCatchClause(n) || ts.isCaseBlock(n)
    || ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isSourceFile(n);
}

function declareInCurrent(name, node) {
  const line = lineOf(node.getStart(sf));
  scopes[scopes.length - 1].set(name, line);
  if (line >= startLine && line <= endLine) declaredInRange.add(name);
}

function hoistDeclarations(node) {
  // Declare names introduced directly by this node into the current scope.
  if (ts.isImportDeclaration(node) && node.importClause) {
    const names = new Set();
    const clause = node.importClause;
    if (clause.name) names.add(clause.name.text);
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
      else for (const element of clause.namedBindings.elements) names.add(element.name.text);
    }
    for (const n of names) declareInCurrent(n, node);
  } else if (ts.isVariableDeclaration(node)) {
    const names = new Set();
    collectBindingNames(node.name, names);
    for (const n of names) declareInCurrent(n, node);
  } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    declareInCurrent(node.name.text, node);
  } else if (ts.isParameter(node)) {
    const names = new Set();
    collectBindingNames(node.name, names);
    for (const n of names) declareInCurrent(n, node);
  } else if (ts.isBindingElement(node)) {
    const names = new Set();
    collectBindingNames(node.name, names);
    for (const n of names) declareInCurrent(n, node);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    const names = new Set();
    collectBindingNames(node.variableDeclaration.name, names);
    for (const n of names) declareInCurrent(n, node);
  }
}

function isReference(node) {
  if (!ts.isIdentifier(node)) return false;
  const p = node.parent;
  if (!p) return false;
  // property access `x.foo` — only `x` counts
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if (ts.isPropertyAssignment(p) && p.name === node) return false;
  if (ts.isShorthandPropertyAssignment(p) && p.name === node) return true; // { x } uses x
  if (ts.isBindingElement(p) && p.propertyName === node) return false;
  if (ts.isBindingElement(p) && p.name === node) return false;
  if (ts.isParameter(p) && p.name === node) return false;
  if (ts.isVariableDeclaration(p) && p.name === node) return false;
  if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isFunctionExpression(p)) && p.name === node) return false;
  if (ts.isMethodDeclaration(p) && p.name === node) return false;
  if (ts.isPropertyDeclaration(p) && p.name === node) return false;
  if (ts.isMetaProperty(p)) return false;
  if (ts.isLabeledStatement(p) && p.label === node) return false;
  if (ts.isBreakOrContinueStatement(p) && p.label === node) return false;
  return true;
}

function declarationLine(name) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].has(name)) return scopes[i].get(name);
  }
  return null;
}

function visit(node) {
  const opened = isScopeNode(node);
  if (opened) scopes.push(new Map());
  // Hoist sibling declarations of this scope's immediate children first.
  if (opened) {
    node.forEachChild(function pre(child) {
      hoistDeclarations(child);
      if (ts.isVariableStatement(child)) for (const d of child.declarationList.declarations) hoistDeclarations(d);
      if (ts.isBlock(child) || isScopeNode(child)) return; // do not descend into nested scopes
      child.forEachChild(pre);
    });
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
      for (const p of node.parameters) hoistDeclarations(p);
    }
    if (ts.isCatchClause(node)) hoistDeclarations(node);
  }
  if (ts.isIdentifier(node) && isReference(node)) {
    const line = lineOf(node.getStart(sf));
    if (line >= startLine && line <= endLine) {
      const name = node.text;
      const declLine = declarationLine(name);
      if (declLine !== null && (declLine < startLine || declLine > endLine)) {
        free.set(name, moduleScope.has(name) && declLine < registerStart ? "module" : "register");
      }
    }
  }
  node.forEachChild(visit);
  if (opened) scopes.pop();
}

visit(sf);
const mod = [...free].filter(([, k]) => k === "module").map(([n]) => n).sort();
const reg = [...free].filter(([, k]) => k === "register").map(([n]) => n).sort();
console.log(`${file}:${startLine}-${endLine}`);
console.log(`MODULE-SCOPE (import these): ${mod.length}`);
console.log(mod.join(" "));
console.log(`REGISTER-SCOPE (pass via context object): ${reg.length}`);
console.log(reg.join(" "));
