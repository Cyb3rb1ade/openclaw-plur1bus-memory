#!/usr/bin/env node

import { resolve } from "node:path";

import {
  buildCodeIndexForWorkspace,
  saveCodeIndex,
} from "../lib/code-index/workspace-indexer.js";

function usage() {
  return [
    "Usage: node scripts/build-code-index.mjs [workspaceDir] [--include-tests]",
    "",
    "Builds .plur1bus/code-index.json from JS/TS source files.",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const rootDir = resolve(positional[0] || process.cwd());
  const index = await buildCodeIndexForWorkspace(rootDir, {
    includeTests: argv.includes("--include-tests"),
  });
  saveCodeIndex(rootDir, index);
  console.log(`code-index files=${index.files.length} symbols=${index.symbols.length} edges=${index.edges.length} chunks=${index.chunks.length}`);
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(`[plur1bus-code-index] ${err.message}`);
  process.exitCode = 1;
});
