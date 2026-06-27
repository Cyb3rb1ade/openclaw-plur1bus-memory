import { extname, isAbsolute, relative } from "node:path";

import { normalizeCodePath, sha256Text, stableCodeId } from "./schema.js";

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx"]);
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx"]);

function relativeCodePath(filePath, rootDir) {
  if (rootDir && isAbsolute(filePath)) return normalizeCodePath(relative(rootDir, filePath));
  return normalizeCodePath(filePath);
}

function languageForPath(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "typescript";
  if (ext === ".tsx") return "typescriptreact";
  if (ext === ".jsx") return "javascriptreact";
  return "javascript";
}

function scriptKindForPath(ts, filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return ts.ScriptKind.TS;
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function modifiersOf(ts, node) {
  return typeof ts.getModifiers === "function"
    ? [...(ts.getModifiers(node) || [])]
    : [...(node.modifiers || [])];
}

function hasModifier(ts, node, kind) {
  return modifiersOf(ts, node).some((modifier) => modifier.kind === kind);
}

function isExported(ts, node) {
  return hasModifier(ts, node, ts.SyntaxKind.ExportKeyword);
}

function isAsync(ts, node) {
  return hasModifier(ts, node, ts.SyntaxKind.AsyncKeyword);
}

function rangeOf(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function sourceSlice(sourceFile, node) {
  return sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function functionSignature(sourceFile, node) {
  const start = node.getStart(sourceFile);
  const end = node.body ? node.body.getStart(sourceFile) : node.getEnd();
  return collapseWhitespace(sourceFile.text.slice(start, end).replace(/\{\s*$/, ""));
}

function classSignature(sourceFile, node) {
  const text = sourceSlice(sourceFile, node);
  return collapseWhitespace(text.slice(0, Math.max(0, text.indexOf("{"))));
}

function variableSignature(sourceFile, statement, declaration) {
  const text = sourceSlice(sourceFile, statement);
  const name = declaration.name?.getText(sourceFile) || "";
  const idx = text.indexOf(name);
  const afterName = idx >= 0 ? text.slice(0, idx + name.length) : text;
  return collapseWhitespace(afterName);
}

function addNamedBindingSpecifiers(ts, namedBindings, specifiers) {
  if (!namedBindings) return;
  if (ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements || []) {
      specifiers.push(element.name?.text || element.propertyName?.text || element.getText());
    }
    return;
  }
  if (ts.isNamespaceImport(namedBindings)) {
    specifiers.push(namedBindings.name?.text || namedBindings.getText());
  }
}

function importRecordFromNode(ts, node) {
  const source = node.moduleSpecifier?.text;
  if (!source) return null;
  const specifiers = [];
  const clause = node.importClause;
  if (clause?.name?.text) specifiers.push(clause.name.text);
  addNamedBindingSpecifiers(ts, clause?.namedBindings, specifiers);
  return { source, specifiers, kind: "esm" };
}

function callNameFromExpression(sourceFile, expression) {
  return collapseWhitespace(expression.getText(sourceFile));
}

function commandRegistrationFromCall(ts, sourceFile, node) {
  const expressionText = callNameFromExpression(sourceFile, node.expression);
  if (!expressionText.endsWith(".register") && !expressionText.endsWith(".commands.register")) return null;
  const [commandArg, handlerArg] = [...(node.arguments || [])];
  if (!commandArg || !ts.isStringLiteralLike(commandArg) || !commandArg.text.startsWith("/")) return null;
  return {
    command: commandArg.text,
    handler: handlerArg ? collapseWhitespace(handlerArg.getText(sourceFile)) : "",
  };
}

function symbolIdFor(filePath, kind, name, range) {
  return stableCodeId("code-symbol", [filePath, kind, name, range.startLine, range.startColumn]);
}

function chunkForSymbol(sourceFile, filePath, symbol) {
  const text = sourceSlice(sourceFile, symbol.node).trim();
  return {
    id: stableCodeId("code-chunk", [symbol.id, text]),
    kind: "symbol",
    filePath,
    symbolId: symbol.id,
    text,
    hash: sha256Text(text),
    range: symbol.range,
  };
}

function createSymbol({ ts, sourceFile, filePath, kind, name, node, signature, exported, async }) {
  const range = rangeOf(sourceFile, node);
  return {
    id: symbolIdFor(filePath, kind, name, range),
    kind,
    name,
    filePath,
    range,
    signature,
    exported,
    async,
    node,
    sourceHash: sha256Text(sourceSlice(sourceFile, node)),
  };
}

function symbolFromNode(ts, sourceFile, filePath, node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text) {
    return createSymbol({
      ts,
      sourceFile,
      filePath,
      kind: "function",
      name: node.name.text,
      node,
      signature: functionSignature(sourceFile, node),
      exported: isExported(ts, node),
      async: isAsync(ts, node),
    });
  }
  if (ts.isClassDeclaration(node) && node.name?.text) {
    return createSymbol({
      ts,
      sourceFile,
      filePath,
      kind: "class",
      name: node.name.text,
      node,
      signature: classSignature(sourceFile, node),
      exported: isExported(ts, node),
      async: false,
    });
  }
  return null;
}

function variableSymbolsFromStatement(ts, sourceFile, filePath, statement) {
  if (!ts.isVariableStatement(statement)) return [];
  const exported = isExported(ts, statement);
  const symbols = [];
  for (const declaration of statement.declarationList?.declarations || []) {
    const name = declaration.name?.getText(sourceFile);
    const initializer = declaration.initializer;
    if (!name || !initializer) continue;
    if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer) && !ts.isClassExpression(initializer)) continue;
    symbols.push(createSymbol({
      ts,
      sourceFile,
      filePath,
      kind: ts.isClassExpression(initializer) ? "class" : "function",
      name,
      node: declaration,
      signature: variableSignature(sourceFile, statement, declaration),
      exported,
      async: isAsync(ts, initializer),
    }));
  }
  return symbols;
}

function publicSymbol(symbol) {
  const { node, ...rest } = symbol;
  return rest;
}

function isSupportedSource(filePath) {
  const ext = extname(filePath).toLowerCase();
  return JS_EXTENSIONS.has(ext) || TS_EXTENSIONS.has(ext);
}

/**
 * Index one JS/TS source file with the TypeScript Compiler API.
 * @param {Object} options Source file options.
 * @returns {Object} File, symbol, edge, and chunk fragment.
 */
export function indexSourceFileWithTypescript(options = {}) {
  const { filePath, rootDir = "", sourceText = "", ts } = options;
  if (!ts || typeof ts.createSourceFile !== "function") {
    throw new Error("indexSourceFileWithTypescript requires a TypeScript compiler API object");
  }
  if (!filePath || !isSupportedSource(filePath)) {
    throw new Error(`Unsupported code index source file: ${filePath || "(missing)"}`);
  }

  const relPath = relativeCodePath(filePath, rootDir);
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(ts, filePath),
  );
  const fileId = `file:${relPath}`;
  const imports = [];
  const exports = [];
  const symbols = [];
  const edges = [];
  const chunks = [];
  const nodeToSymbolId = new Map();

  for (const statement of sourceFile.statements || []) {
    if (ts.isImportDeclaration(statement)) {
      const record = importRecordFromNode(ts, statement);
      if (record) {
        imports.push(record);
        edges.push({
          id: stableCodeId("code-edge", [fileId, "imports", record.source, record.specifiers.join(",")]),
          type: "imports",
          from: fileId,
          to: `module:${record.source}`,
          source: record.source,
          specifiers: record.specifiers,
        });
      }
      continue;
    }

    const directSymbol = symbolFromNode(ts, sourceFile, relPath, statement);
    const statementSymbols = directSymbol ? [directSymbol] : variableSymbolsFromStatement(ts, sourceFile, relPath, statement);
    for (const symbol of statementSymbols) {
      symbols.push(symbol);
      nodeToSymbolId.set(symbol.node, symbol.id);
      chunks.push(chunkForSymbol(sourceFile, relPath, symbol));
      if (symbol.exported) exports.push(symbol.name);
    }
  }

  function visit(node, currentSymbolId = fileId) {
    const activeSymbolId = nodeToSymbolId.get(node) || currentSymbolId;

    if (ts.isCallExpression(node)) {
      const callName = callNameFromExpression(sourceFile, node.expression);
      if (callName) {
        edges.push({
          id: stableCodeId("code-edge", [activeSymbolId, "calls", callName, node.getStart(sourceFile)]),
          type: "calls",
          from: activeSymbolId,
          to: `symbol-ref:${callName}`,
          name: callName,
          range: rangeOf(sourceFile, node),
        });
      }
      const registration = commandRegistrationFromCall(ts, sourceFile, node);
      if (registration) {
        edges.push({
          id: stableCodeId("code-edge", [activeSymbolId, "registers", registration.command, registration.handler]),
          type: "registers",
          from: activeSymbolId,
          to: `command:${registration.command}`,
          ...registration,
          range: rangeOf(sourceFile, node),
        });
      }
    }

    ts.forEachChild(node, (child) => visit(child, activeSymbolId));
  }
  ts.forEachChild(sourceFile, (child) => visit(child, fileId));

  return {
    file: {
      id: fileId,
      path: relPath,
      language: languageForPath(filePath),
      hash: sha256Text(sourceText),
      bytes: Buffer.byteLength(sourceText, "utf8"),
      lines: sourceText.split(/\r?\n/).length,
      imports,
      exports,
    },
    symbols: symbols.map(publicSymbol),
    edges,
    chunks,
  };
}
