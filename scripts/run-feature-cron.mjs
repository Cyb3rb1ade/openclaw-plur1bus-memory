#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeFeatureCronCli,
  loadOpenClawGatewayRuntime,
  parseFeatureCronRunnerArgs,
} from "../lib/setup/feature-cron-plugin-runtime.js";

/** Run one model-free feature cron through the public OpenClaw Gateway SDK. */
export async function runFeatureCronRunner(
  argv = process.argv.slice(2),
  { loadGatewayRuntime = loadOpenClawGatewayRuntime, write } = {},
) {
  const { agentId, feature } = parseFeatureCronRunnerArgs(argv);
  const gatewayRuntime = await loadGatewayRuntime();
  return executeFeatureCronCli({
    agentId,
    feature,
    callGateway: gatewayRuntime.callGatewayFromCli,
    ...(write ? { write } : {}),
  });
}

function isMain() {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(path.resolve(entry)).href : false;
}

if (isMain()) {
  try {
    await runFeatureCronRunner();
  } catch (error) {
    process.stderr.write(`[plur1bus-feature-cron] ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
