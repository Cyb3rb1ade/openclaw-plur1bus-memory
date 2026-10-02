/**
 * scripts/dist/installer/hermes/plur1bus-cli.mjs — the sidecar's own CLI, the only place that builds a `plur1bus` argv.
 *
 * Every call passes the explicit absolute `--home <dir>` the installer recorded (ruling F24) and
 * `--json`; documents carry a top-level `schema` (harness ADR-016 §8) and readers ignore unknown keys
 * (ruling F12). Commands (harness crates/plur1bus/src/cli.rs):
 *   setup --profile host --non-interactive --use-class <c> [--accept-nc-licence] [--no-service]   → setup/1
 *   agent list → agent.list/1 { agents: [{ agentId }] };  agent create <id> → agent.create/1
 *   config get <key> → config.get/1 { key, value };  daemon stop|start;  service uninstall
 *   memory list --agent <id> --since <t> → memory.list/1 (for ruling F4's purge count, Task 9)
 * The host setup may leave no config.json (Task 4 carry): `config get` failing is "unknown", not an error.
 */

import { defaultRun } from "../openclaw-cli.mjs";

export const ALLOWED_PLUR1BUS_CONFIG_KEYS = Object.freeze(["embedding.useClass"]);
export const USE_CLASSES = Object.freeze(["general", "research", "commercial"]);

function parseDoc(text) {
  const whole = String(text ?? "").trim();
  try {
    return JSON.parse(whole);
  } catch {
    const line = whole.split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => l.startsWith("{"));
    if (!line) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
}

const tail = (text, n = 2) => String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(" | ");

function errorOf(r, doc) {
  const e = doc && typeof doc === "object" ? (doc.error ?? (doc.schema === "error/1" ? doc : null)) : null;
  const msg = e && typeof e === "object" ? [e.code, e.message ?? e.reason].filter(Boolean).join(": ") : "";
  return `exit ${r.code}${r.timedOut ? ", deadline exceeded" : ""}${msg ? `: ${msg}` : tail(r.stderr || r.stdout) ? `: ${tail(r.stderr || r.stdout)}` : ""}`;
}

/**
 * @param {{ bin: string, home: string, env: Record<string,string|undefined>, run?: typeof defaultRun, platform?: string }} a
 */
export function createPlur1busCli({ bin, home, env, run = defaultRun, platform = process.platform }) {
  const call = async (args, timeoutMs = 120_000) => {
    const r = await run(bin, ["--home", home, "--json", ...args], { env, timeoutMs, platform });
    const doc = parseDoc(r.stdout);
    return { ...r, doc, ok: r.code === 0, detail: r.code === 0 ? "" : errorOf(r, doc) };
  };
  return {
    bin,
    home,
    /** Setup downloads Node and the core payload: a long deadline. */
    async setup({ useClass, acceptNc = false, noService = false }) {
      if (!USE_CLASSES.includes(useClass)) throw new Error(`unknown use class ${JSON.stringify(useClass)}`);
      const args = ["setup", "--profile", "host", "--non-interactive", "--use-class", useClass];
      if (acceptNc) args.push("--accept-nc-licence");
      if (noService) args.push("--no-service");
      return call(args, 30 * 60_000);
    },
    async agentList() {
      const r = await call(["agent", "list"]);
      const ids = Array.isArray(r.doc?.agents) ? r.doc.agents.map((a) => a?.agentId).filter((x) => typeof x === "string") : [];
      return { ...r, ids };
    },
    async agentCreate(id) {
      return call(["agent", "create", id]);
    },
    /** @returns {Promise<{ ok: boolean, set: boolean, value: unknown, detail: string }>} */
    async configGet(key) {
      if (!ALLOWED_PLUR1BUS_CONFIG_KEYS.includes(key)) throw new Error(`plur1bus config key ${JSON.stringify(key)} is not in the installer's allow-list`);
      const r = await call(["config", "get", key]);
      const has = r.ok && r.doc && typeof r.doc === "object" && "value" in r.doc;
      return { ok: r.ok, set: Boolean(has && r.doc.value !== null && r.doc.value !== undefined && r.doc.value !== ""), value: has ? r.doc.value : null, detail: r.detail };
    },
    async daemonStop() {
      return call(["daemon", "stop"]);
    },
    async daemonStart() {
      return call(["daemon", "start"]);
    },
    async serviceUninstall() {
      return call(["service", "uninstall"]);
    },
    /** Entries of one agent (for Task 9's purge summary); null when unknown. */
    async memoryCount(agentId) {
      const r = await call(["memory", "list", "--agent", agentId, "--since", "1970-01-01T00:00:00Z"]);
      if (!r.ok) return { ...r, count: null };
      const list = Array.isArray(r.doc?.entries) ? r.doc.entries : Array.isArray(r.doc?.items) ? r.doc.items : null;
      return { ...r, count: list ? list.length : typeof r.doc?.count === "number" ? r.doc.count : null };
    },
  };
}
