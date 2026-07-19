#!/usr/bin/env node
/** Bounded proof that repairFile/copyFileSync follows a deployed symlink. */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [outputDir] = process.argv.slice(2);
const integrityModule = process.env.PLUR1BUS_DEPLOY_INTEGRITY;
if (!outputDir || !integrityModule) throw new Error("usage: PLUR1BUS_DEPLOY_INTEGRITY=/immutable/deploy-integrity.mjs node repro.mjs <output-dir>");

const root = resolve(outputDir);
rmSync(root, { recursive: true, force: true });
const repoDir = join(root, "repo");
const deployDir = join(root, "deploy");
const outsideDir = join(root, "outside");
const file = "lib/target.mjs";
const repoFile = join(repoDir, file);
const deployedFile = join(deployDir, file);
const outsideFile = join(outsideDir, "sentinel.mjs");
mkdirSync(dirname(repoFile), { recursive: true });
mkdirSync(dirname(deployedFile), { recursive: true });
mkdirSync(outsideDir, { recursive: true });
writeFileSync(repoFile, "export const value = 'trusted';\n");
writeFileSync(outsideFile, "outside sentinel before repair\n");
symlinkSync(outsideFile, deployedFile);

const { validateDeployment } = await import(pathToFileURL(integrityModule).href);
const before = readFileSync(outsideFile, "utf8");
const report = validateDeployment({ deployDir, repoDir, files: [file], repair: true, dryRun: false });
const after = readFileSync(outsideFile, "utf8");
const result = {
  report,
  outsideFile,
  outsideExisted: existsSync(outsideFile),
  before,
  after,
  overwriteProven: before !== after && after === readFileSync(repoFile, "utf8"),
};
writeFileSync(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ repaired: report.results[0].repaired, overwriteProven: result.overwriteProven }, null, 2)}\n`);
