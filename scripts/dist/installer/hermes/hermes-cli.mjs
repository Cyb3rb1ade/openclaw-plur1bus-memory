/**
 * scripts/dist/installer/hermes/hermes-cli.mjs — the only place that builds a `hermes` argv.
 *
 * Every call has a deadline and runs without a shell (openclaw-cli.mjs `defaultRun`; a Windows
 * `hermes.cmd` goes through `cmd.exe /d /s /c` with every argument quoted, fact sheet §j). Config
 * access is limited to ALLOWED_HERMES_CONFIG_KEYS; nothing else of config.yaml is ever read or
 * printed. Output formats are the ones the HM2 Task 1 fact sheet observed on 0.21.4 and 0.21.5:
 *   `hermes --version`                          §a (parsed by ./detect.mjs)
 *   `hermes config get <key> --json`            §b: a JSON string; "" = unset; exit 1 = unknown key
 *   `hermes config set|unset <key> [value]`     §c: exit 0 = done (0.21.4 strips config.yaml, HM2-R24:
 *                                               ./config-edit.mjs is used there instead)
 *   `hermes memory status`                      §d: exit code carries nothing; parse Provider/Status
 *   `hermes plur1bus selftest --json`           §e + HM2 Task 5: exists only while plur1bus is the
 *                                               active provider; `plur1bus.hermes-selftest/1` (ruling F12)
 * There is deliberately no `bind()` (ruling F11): `hermes plur1bus bind` works only after activation.
 */

import { defaultRun } from "../openclaw-cli.mjs";

export const ALLOWED_HERMES_CONFIG_KEYS = Object.freeze(["memory.provider"]);

/** Values Hermes reads as "built-in store, no external provider" (agent/memory_provider.py CORE_MEMORY_PROVIDER_SENTINELS). */
export const BUILTIN_PROVIDER_VALUES = Object.freeze(["", "default", "builtin", "built-in", "none"]);

export const SELFTEST_SCHEMA = "plur1bus.hermes-selftest/1";

function refuse(key) {
  const err = new Error(`hermes config key ${JSON.stringify(key)} is not in the installer's allow-list (${ALLOWED_HERMES_CONFIG_KEYS.join(", ")})`);
  err.code = "CONFIG_KEY_NOT_ALLOWED";
  return err;
}

function lastJsonDoc(text) {
  const whole = String(text ?? "").trim();
  try {
    return JSON.parse(whole);
  } catch {
    // fall through: a JSON line among other output
  }
  const line = whole.split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => l.startsWith("{") || l.startsWith('"'));
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const tail = (text, n = 2) => String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(" | ");

/**
 * The shape of a selftest document (ruling F12): { schema, ok, checks: [{ id, ok, detail? }] }; unknown keys ignored.
 * @returns {{ ok: boolean, checks: Array<{ id: string, ok: boolean, detail: string|null }> } | null}
 */
export function readSelftestDoc(doc) {
  if (!doc || typeof doc !== "object" || doc.schema !== SELFTEST_SCHEMA || typeof doc.ok !== "boolean" || !Array.isArray(doc.checks)) return null;
  const checks = doc.checks
    .filter((c) => c && typeof c === "object" && typeof c.id === "string" && typeof c.ok === "boolean")
    .map((c) => ({ id: c.id, ok: c.ok, detail: typeof c.detail === "string" ? c.detail : null }));
  return { ok: doc.ok && checks.every((c) => c.ok), checks };
}

/** `hermes memory status` (fact sheet §d): the active provider (null = built-in only) and its availability. */
export function parseMemoryStatus(stdout) {
  const text = String(stdout ?? "");
  const p = /^ {2}Provider: {2}(\S+)/m.exec(text);
  const s = /^ {2}Status: {4}(available|not available)/m.exec(text);
  const provider = p && !p[1].startsWith("(") ? p[1] : null;
  return { provider, available: s ? s[1] === "available" : null };
}

/**
 * @param {{ bin: string, env: Record<string,string|undefined>, run?: typeof defaultRun, timeoutMs?: number, platform?: string }} a
 */
export function createHermesCli({ bin, env, run = defaultRun, timeoutMs = 120_000, platform = process.platform }) {
  const call = (args, t = timeoutMs) => run(bin, args, { env, timeoutMs: t, platform });
  return {
    bin,
    /** @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
    async version() {
      return call(["--version"], 60_000);
    },

    /**
     * @returns {Promise<{ ok: boolean, set: boolean, value: string, code: number, detail?: string }>}
     *   `set` is false for "" (Hermes shows unset and empty alike, §b).
     */
    async configGet(key) {
      if (!ALLOWED_HERMES_CONFIG_KEYS.includes(key)) throw refuse(key);
      const r = await call(["config", "get", key, "--json"], 60_000);
      if (r.code !== 0) return { ok: false, set: false, value: "", code: r.code, detail: tail(r.stderr || r.stdout) };
      const v = lastJsonDoc(r.stdout);
      if (typeof v !== "string") return { ok: false, set: false, value: "", code: r.code, detail: "hermes config get printed no JSON string" };
      return { ok: true, set: v !== "", value: v, code: 0 };
    },

    /** Throws with the exit code on failure. */
    async configSet(key, value) {
      if (!ALLOWED_HERMES_CONFIG_KEYS.includes(key)) throw refuse(key);
      const r = await call(["config", "set", key, String(value)], 60_000);
      if (r.code !== 0) throw Object.assign(new Error(`hermes config set ${key} failed (exit ${r.code}${r.timedOut ? ", deadline exceeded" : ""}): ${tail(r.stderr || r.stdout)}`), { exitCode: r.code });
      return r;
    },

    async configUnset(key) {
      if (!ALLOWED_HERMES_CONFIG_KEYS.includes(key)) throw refuse(key);
      const r = await call(["config", "unset", key], 60_000);
      if (r.code !== 0) throw Object.assign(new Error(`hermes config unset ${key} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`), { exitCode: r.code });
      return r;
    },

    /** @returns {Promise<{ code: number, provider: string|null, available: boolean|null, detail: string }>} */
    async memoryStatus() {
      const r = await call(["memory", "status"]);
      const s = parseMemoryStatus(r.stdout);
      return { code: r.code, ...s, detail: s.provider ? `provider ${s.provider}${s.available === null ? "" : s.available ? ", available" : ", not available"}` : tail(r.stderr || r.stdout) || "no provider line" };
    },

    /**
     * @returns {Promise<{ code: number, active: boolean, ok: boolean, checks: Array<{id: string, ok: boolean, detail: string|null}>, detail: string }>}
     */
    async selftest() {
      const r = await call(["plur1bus", "selftest", "--json"]);
      if (r.code === 2 && /is not a `?hermes`? command/.test(`${r.stderr}\n${r.stdout}`)) {
        return { code: r.code, active: false, ok: false, checks: [], detail: "hermes plur1bus is not a command: the provider is not active" };
      }
      const doc = readSelftestDoc(lastJsonDoc(r.stdout));
      if (!doc) return { code: r.code, active: true, ok: false, checks: [], detail: `no ${SELFTEST_SCHEMA} document (exit ${r.code}${r.timedOut ? ", deadline exceeded" : ""}): ${tail(r.stderr || r.stdout)}` };
      const failed = doc.checks.filter((c) => !c.ok);
      return {
        code: r.code,
        active: true,
        ok: doc.ok && r.code === 0,
        checks: doc.checks,
        detail: failed.length ? failed.map((c) => `${c.id}: ${c.detail ?? "failed"}`).join("; ") : `${doc.checks.length} check(s) ok`,
      };
    },
  };
}
