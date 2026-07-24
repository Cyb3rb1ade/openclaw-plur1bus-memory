#!/usr/bin/env node
/**
 * Bounded proof for the verifier's execution sink. A deployed module differs
 * from its trusted repo copy, validation marks it invalid, and the actual
 * smoke helper still imports it and runs its benign top-level marker write.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [outputDir] = process.argv.slice(2);
const integrityModule = process.env.PLUR1BUS_DEPLOY_INTEGRITY;
if (!outputDir || !integrityModule) throw new Error("usage: PLUR1BUS_DEPLOY_INTEGRITY=/immutable/deploy-integrity.mjs node repro.mjs <output-dir>");

const root = resolve(outputDir);
rmSync(root, { recursive: true, force: true });
const repoDir = join(root, "repo");
const deployDir = join(root, "deploy");
const file = "lib/benign-untrusted.mjs";
const marker = join(root, "executed-marker");
const repoFile = join(repoDir, file);
const deployedFile = join(deployDir, file);
mkdirSync(dirname(repoFile), { recursive: true });
mkdirSync(dirname(deployedFile), { recursive: true });
writeFileSync(repoFile, "export const expected = 'trusted';\n");
writeFileSync(deployedFile, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "top-level-ran");\nexport const expected = "untrusted";\n`);

const { validateDeployment, smokeTestExports } = await import(pathToFileURL(integrityModule).href);
const validation = validateDeployment({ deployDir, repoDir, files: [file], repair: false, dryRun: false });
const smoke = await smokeTestExports([{ filePath: deployedFile, exports: ["expected"] }]);
const result = {
  validation,
  smoke,
  marker,
  markerContent: readFileSync(marker, "utf8"),
  knownChecksumFailure: validation.ok === false && validation.results[0].reasons.includes("checksum-mismatch"),
  topLevelExecuted: readFileSync(marker, "utf8") === "top-level-ran",
};
writeFileSync(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ knownChecksumFailure: result.knownChecksumFailure, topLevelExecuted: result.topLevelExecuted, smokeOk: smoke.ok }, null, 2)}\n`);
