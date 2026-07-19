#!/usr/bin/env node
/**
 * Bounded integration reproduction for installer-generated command and path
 * handling. It copies only the installer to a disposable source tree and uses
 * an isolated target directory plus a stubbed `openclaw` executable.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [kind, outputDir] = process.argv.slice(2);
const sourceSnapshot = process.env.PLUR1BUS_SNAPSHOT;
if (!sourceSnapshot || !outputDir || !["agent-shell", "workspace-shell", "agent-path", "generated-gc"].includes(kind)) {
  throw new Error("usage: PLUR1BUS_SNAPSHOT=/immutable node installer-repro.mjs <agent-shell|workspace-shell|agent-path|generated-gc> <output-dir>");
}

const root = resolve(outputDir);
const source = join(root, "source");
const target = join(root, "target");
const bin = join(root, "bin");
const marker = join(root, "proof-marker");
rmSync(root, { recursive: true, force: true });
mkdirSync(source, { recursive: true });
mkdirSync(target, { recursive: true });
mkdirSync(bin, { recursive: true });

for (const rel of [
  "scripts/install-memory-system.sh",
  "scripts/lib/installer-config.mjs",
  "lib/setup/feature-profiles.js",
]) {
  const from = join(sourceSnapshot, rel);
  const to = join(source, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}
// The installer treats its parent as an OpenClaw home. Empty extension source
// directories are enough for the bounded run: no plugin code is invoked.
mkdirSync(join(source, "extensions", "memory-lancedb-namespaced"), { recursive: true });
mkdirSync(join(source, "extensions", "memory-lancedb-stock"), { recursive: true });

let agentId = "main";
let workspace = join(target, "workspace");
if (kind === "agent-shell") {
  // Complete the surrounding jq invocation, run a benign marker command, and
  // comment out the remainder of the developer-supplied command string.
  agentId = `main' 'empty' '${join(target, "openclaw.json")}'; printf agent-shell > "${marker}"; #`;
}
if (kind === "workspace-shell") {
  workspace = `${join(target, "workspace")}'; printf workspace-shell > "${marker}"; #`;
}
if (kind === "agent-path") {
  agentId = "../escaped-agent";
}
if (kind === "generated-gc") {
  agentId = `"]; (await import("node:fs")).writeFileSync("${marker}", "gc"); //`;
}

const config = {
  agents: { list: [{ id: agentId, workspace }] },
  plugins: {
    allow: ["memory-lancedb-namespaced"],
    slots: { memory: "memory-lancedb-namespaced" },
    // Avoid the installer constructing an unrelated JSON list for the active
    // memory migration; the candidate must flow to its generated GC file.
    entries: {
      "memory-lancedb-namespaced": {
        enabled: true,
        config: {
          embedding: { provider: "openai", apiKey: "${OPENAI_API_KEY}", model: "text-embedding-3-large", dimensions: 3072 },
          reranker: { provider: "disabled" },
          baseDbPath: join(target, "memory", "lancedb-namespaced"),
        },
      },
      "active-memory": { enabled: false, config: {} },
    },
  },
};
writeFileSync(join(target, "openclaw.json"), `${JSON.stringify(config, null, 2)}\n`);
writeFileSync(join(bin, "openclaw"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 2026.7.0; fi\nexit 0\n");
chmodSync(join(bin, "openclaw"), 0o755);

const installerArgs = [join(source, "scripts", "install-memory-system.sh"), "--non-interactive"];
if (kind === "agent-shell" || kind === "workspace-shell") installerArgs.push("--dry-run");
installerArgs.push(target);
const run = spawnSync("bash", installerArgs, {
  cwd: source,
  encoding: "utf8",
  timeout: 20_000,
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
});

const result = {
  kind,
  installer: {
    status: run.status,
    signal: run.signal,
    timedOut: Boolean(run.error && run.error.code === "ETIMEDOUT"),
    stdout: run.stdout,
    stderr: run.stderr,
  },
  markerAfterInstaller: existsSync(marker) ? readFileSync(marker, "utf8") : null,
};

if (kind === "agent-path") {
  const escaped = join(target, "memory", "escaped-agent");
  const intendedRoot = join(target, "memory", "lancedb-namespaced");
  result.pathCheck = {
    intendedRoot,
    escaped,
    escapedExists: existsSync(escaped),
    escapedOutsideIntendedRoot: !resolve(escaped).startsWith(`${resolve(intendedRoot)}/`),
  };
}

if (kind === "generated-gc") {
  const moduleRoot = join(target, "extensions", "memory-lancedb-stock", "node_modules", "@lancedb", "lancedb");
  mkdirSync(join(moduleRoot, "dist"), { recursive: true });
  writeFileSync(join(moduleRoot, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(moduleRoot, "dist", "index.js"), "export async function connect() { return { tableNames: async () => [] }; }\n");
  const gc = spawnSync("node", [join(target, "scripts", "memory-gc.mjs")], {
    cwd: target,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env },
  });
  result.generatedGc = {
    status: gc.status,
    signal: gc.signal,
    stdout: gc.stdout,
    stderr: gc.stderr,
    markerAfterGc: existsSync(marker) ? readFileSync(marker, "utf8") : null,
  };
  result.generatedGcSource = readFileSync(join(target, "scripts", "memory-gc.mjs"), "utf8");
}

writeFileSync(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  kind,
  installerStatus: run.status,
  marker: existsSync(marker) ? readFileSync(marker, "utf8") : null,
  pathCheck: result.pathCheck ?? null,
  gcStatus: result.generatedGc?.status ?? null,
}, null, 2)}\n`);
