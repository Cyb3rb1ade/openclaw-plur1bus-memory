#!/usr/bin/env node

import { patchAgentsContent, patchAgentsMd } from "../../lib/install/agents-patcher.js";

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--stdin") {
    const input = await readStdin();
    process.stdout.write(patchAgentsContent(input).content);
    return;
  }
  if (!arg) {
    console.error("Usage: patch-agents-memory-instructions.mjs <AGENTS.md|--stdin>");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(patchAgentsMd(arg), null, 2)}\n`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
