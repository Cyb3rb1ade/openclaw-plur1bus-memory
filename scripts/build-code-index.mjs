#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCodeIndexForWorkspace,
  saveCodeIndex,
} from "../lib/code-index/workspace-indexer.js";
import { formatCodeContextBlock, searchCodeIndex } from "../lib/code-index/query.js";

function usage() {
  return [
    "Usage: node scripts/build-code-index.mjs [workspaceDir] [--include-tests] [--query <text>]",
    "",
    "Builds .plur1bus/code-index.json from JS/TS source files.",
  ].join("\n");
}

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return "";
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const query = optionValue(argv, "--query");
  const positional = argv.filter((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--query");
  const rootDir = resolve(positional[0] || process.cwd());
  const index = await buildCodeIndexForWorkspace(rootDir, {
    includeTests: argv.includes("--include-tests"),
  });
  saveCodeIndex(rootDir, index);
  console.log(`code-index files=${index.files.length} symbols=${index.symbols.length} edges=${index.edges.length} chunks=${index.chunks.length}`);
  if (query) {
    const results = searchCodeIndex(index, query, { limit: Number(optionValue(argv, "--query-limit")) || 1 });
    console.log(`code-index query="${query.replace(/"/g, '\\"')}" results=${results.length}`);
    console.log(formatCodeContextBlock(results, { query }));
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(`[plur1bus-code-index] ${err.message}`);
    process.exitCode = 1;
  });
}
