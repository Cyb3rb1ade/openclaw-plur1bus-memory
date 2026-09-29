/**
 * scripts/dist/installer/openclaw-cli.mjs — the ONLY place that builds `openclaw` argv.
 *
 * Every call goes through `run(file, args, { env, timeoutMs })`, which never
 * uses a shell and always has a deadline. Config access is closed: configGet
 * reads only the paths of the Global Constraints list, configSet writes only
 * the HM1-R10 keys plus `hooks.allowConversationAccess` (ruling R-S1). Nothing
 * here prints command output; callers decide what a human sees, and config
 * values other than the allow-listed ones never reach this process.
 *
 * Facts used (docs/distribution/openclaw-cli-facts.md): (a) version line,
 * (b) inspect JSON pointers and "Plugin not found", (c) `config get` exit 1 +
 * "valid but unset" means unset — and so does "Unknown config path" for the plugin's own config keys
 * before it is installed (2026.8.1, 2026.9.6) —, (h) Gateway running ⇔ exit 0 and /rpc/ok,
 * (j) the readonly / Nix refusal texts, and `config validate --json`'s "file not found" answer
 * on a fresh state dir (plugin-dist run 36514170524, 2026.8.1 and 2026.9.6).
 */

import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

export const PLUGIN_ID = "memory-lancedb-namespaced";
const C = `plugins.entries.${PLUGIN_ID}.config`;

/** Closed config allow-list (Global Constraints "Credentials", HM1-R10, R-S1). */
export const ALLOWED_CONFIG_PATHS = Object.freeze({
  get: Object.freeze([
    "plugins.slots.memory",
    `${C}.baseDbPath`,
    `${C}.embedding.provider`,
    `${C}.embedding.model`,
    `${C}.modelPreparation.profile`,
    `${C}.reranker.enabled`,
    `${C}.reranker.provider`,
    // non-secret booleans, read only to restore them on rollback (ruling T5-e)
    `${C}.modelPreparation.acceptNonCommercialLicense`,
    `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`,
  ]),
  set: Object.freeze([
    "plugins.slots.memory",
    `${C}.modelPreparation.profile`,
    `${C}.modelPreparation.acceptNonCommercialLicense`,
    `${C}.embedding.provider`,
    `${C}.embedding.model`,
    `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`,
  ]),
});

export const VERSION_RE = /^OpenClaw (\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.]+)?) \(([0-9a-f]+)\)$/;
const READONLY_RE = /Config is externally managed|Config is managed by Nix/;

/** True when OpenClaw refused a write because its config is immutable (fact j). */
export function isReadonlyRefusal(text) {
  return READONLY_RE.test(String(text ?? ""));
}

/**
 * Existence probe only (never reads the file): true when anything — a file, a directory, a dangling
 * symlink — is at `path`, or when that cannot be ruled out (any lstat error but ENOENT/ENOTDIR).
 * @param {string} path
 * @returns {boolean}
 */
export function pathPresent(path) {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    return !(err && (err.code === "ENOENT" || err.code === "ENOTDIR"));
  }
}

/** Quote one argument for `cmd.exe /d /s /c "…"`; refuses characters cmd would reinterpret. */
function cmdQuote(arg) {
  const s = String(arg);
  if (/["%\r\n\0]/.test(s)) throw new Error(`argument not passable through cmd.exe: ${JSON.stringify(s.slice(0, 40))}`);
  return `"${s.replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Run a program without a shell, with a deadline. Never rejects.
 * On win32 a `.cmd`/`.bat` shim (OpenClaw's `openclaw.cmd`) is run through
 * `cmd.exe /d /s /c` with every argument quoted; nothing is ever a user shell string.
 * @param {string} file
 * @param {string[]} args
 * @param {{ env?: Record<string,string|undefined>, timeoutMs?: number, cwd?: string, platform?: string }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function defaultRun(file, args, { env = process.env, timeoutMs = 300_000, cwd, platform = process.platform } = {}) {
  let cmd = file;
  let argv = args;
  let verbatim = false;
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    try {
      argv = ["/d", "/v:off", "/s", "/c", `"${[cmdQuote(file), ...args.map(cmdQuote)].join(" ")}"`];
    } catch (err) {
      return Promise.resolve({ code: 126, stdout: "", stderr: String(err.message), timedOut: false });
    }
    cmd = env.ComSpec || env.COMSPEC || "cmd.exe";
    verbatim = true;
  }
  return new Promise((resolve) => {
    execFile(
      cmd,
      argv,
      { env, cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: verbatim, shell: false },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, timedOut: false });
        const timedOut = Boolean(err.killed && err.signal === "SIGKILL");
        let code = typeof err.code === "number" ? err.code : 1;
        if (err.code === "ENOENT") code = 127;
        if (timedOut) code = 124;
        resolve({ code, stdout: stdout ?? "", stderr: `${stderr ?? ""}${timedOut ? `\n(deadline of ${timeoutMs} ms exceeded)` : ""}`, timedOut });
      },
    );
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The JSON document on stdout, or the last line that is one; null otherwise. */
function parseJsonDoc(text) {
  const whole = parseJson(String(text ?? "").trim());
  if (whole !== null) return whole;
  const line = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).reverse().find((l) => l.startsWith("{"));
  return line ? parseJson(line) : null;
}

function refuse(kind, path) {
  const err = new Error(`config path ${JSON.stringify(path)} is not in the installer's config allow-list (${kind})`);
  err.code = "CONFIG_PATH_NOT_ALLOWED";
  return err;
}

/** Last few non-empty lines of an OpenClaw message, for a human report line. */
export function tail(text, n = 3) {
  return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(" | ");
}

// OpenClaw's generic failure block (src/cli/failure-output.ts, 2026.8.1 and 2026.9.6) ends with these hints; they
// carry no error text. Node's own warnings are noise too.
const HINT_LINE_RE = /^\[openclaw\] (?:Debug|Try|Help): /;
const NODE_NOISE_RE = /^\(node:\d+\) \w*Warning: |^\(Use `node --trace-warnings/;
const isErrorLine = (l) => /\bE[A-Z]{3,}\b/.test(l) || /\b(?:error|failed|refused|denied)\b/i.test(l);

function meaningfulLines(text) {
  return String(text ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !HINT_LINE_RE.test(l) && !NODE_NOISE_RE.test(l));
}

/**
 * The error text of a failed `openclaw` call, for a human report line: OpenClaw's Debug/Try/Help hints and Node
 * warnings dropped, the first `n` meaningful stderr lines (the "[openclaw] <title>" / "Reason: …" pair), then up to
 * two stdout lines that read as errors (e.g. `plugins uninstall`'s "Failed to remove plugin directory …: EPERM …");
 * stdout's first lines when stderr has nothing.
 * @param {string | { stderr?: string, stdout?: string }} out
 * @param {number} [n]
 * @returns {string}
 */
export function failureSummary(out, n = 3) {
  const { stderr = "", stdout = "" } = typeof out === "string" ? { stderr: out } : (out ?? {});
  const err = meaningfulLines(stderr);
  const std = meaningfulLines(stdout);
  const lines = err.length ? [...err.slice(0, n), ...std.filter((l) => isErrorLine(l) && !err.includes(l)).slice(0, 2)] : std.slice(0, n);
  return lines.length ? lines.join(" | ") : "(no error text from openclaw)";
}

/**
 * @param {{ bin: string, env: Record<string,string|undefined>, run?: typeof defaultRun, timeoutMs?: number, pathPresent?: (p: string) => boolean, sleep?: (ms: number) => Promise<unknown> }} opts
 */
export function createOpenclawCli({ bin, env, run = defaultRun, timeoutMs = 300_000, pathPresent: present = pathPresent, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const call = (args, ms = timeoutMs) => run(bin, args, { env, timeoutMs: ms });

  return {
    bin,
    async version() {
      const r = await call(["--version"], 60_000);
      const first = r.stdout.split(/\r?\n/)[0]?.trim() ?? "";
      const m = VERSION_RE.exec(first);
      if (r.code !== 0 || !m) return { ok: false, version: null, commit: null, detail: failureSummary(r) };
      return { ok: true, version: m[1], commit: m[2] };
    },
    /** @returns {Promise<{ code: number, json: any, installed: boolean, present: boolean, notFound: boolean, detail: string }>} */
    async inspect(id, { runtime = false } = {}) {
      const r = await call(["plugins", "inspect", id, ...(runtime ? ["--runtime"] : []), "--json"], runtime ? 600_000 : timeoutMs);
      const json = parseJson(r.stdout);
      const present = r.code === 0 && json !== null && typeof json === "object" && json.ok !== false;
      const notFound = r.code !== 0 && json?.ok === false && /^Plugin not found:/.test(String(json?.error?.message ?? ""));
      return { code: r.code, json, present, installed: present && json.install != null && typeof json.install === "object", notFound, detail: notFound ? "not installed" : typeof json?.error?.message === "string" ? tail(json.error.message) : failureSummary(r) };
    },
    install(spec, { force = false, pin = false, acceptCapabilities = false } = {}) {
      return call(["plugins", "install", spec, ...(pin ? ["--pin"] : []), ...(force ? ["--force"] : []), ...(acceptCapabilities ? ["--accept-capabilities"] : [])], 1_800_000);
    },
    update(spec) {
      return call(["plugins", "update", spec], 1_800_000);
    },
    /**
     * `plugins uninstall <id> --force`. OpenClaw removes the plugin dir with a single fs.rm (no retries); when that
     * fails (Windows: EPERM/EBUSY on a file still in use, Defender) it leaves the plugin disabled and tracked "so
     * uninstall can be retried" — so that answer is retried twice, after 2 s and 4 s (spec B.5's 10 s budget).
     * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean, summary: string, attempts: number }>}
     */
    async uninstall(id, { keepFiles = false } = {}) {
      const argv = ["plugins", "uninstall", id, ...(keepFiles ? ["--keep-files"] : []), "--force"];
      let r;
      let attempts = 0;
      for (const wait of [2000, 4000, null]) {
        r = await call(argv);
        attempts++;
        if (r.code === 0 || r.timedOut || wait === null || !/Failed to remove plugin directory/.test(`${r.stderr}\n${r.stdout}`)) break;
        await sleep(wait);
      }
      return { ...r, summary: r.code === 0 ? "" : failureSummary(r), attempts };
    },
    enable(id) {
      return call(["plugins", "enable", id]);
    },
    /** @returns {Promise<{ set: boolean, value: string|null }>} */
    async configGet(path) {
      if (!ALLOWED_CONFIG_PATHS.get.includes(path)) throw refuse("get", path);
      const r = await call(["config", "get", path], 60_000);
      if (r.code === 0) return { set: true, value: r.stdout.replace(/\r?\n$/, "").trim() };
      const text = `${r.stderr}\n${r.stdout}`;
      if (/valid but unset/i.test(text)) return { set: false, value: null };
      // Until the plugin is discoverable (a fresh install), OpenClaw has no schema for its config and answers
      // "Unknown config path" for plugins.entries.<id>.config.<key> (2026.8.1, 2026.9.6): nothing is set there.
      // Only for the plugin's own config keys; anywhere else an unknown path stays an error.
      if (!r.timedOut && path.startsWith(`${C}.`) && /^Unknown config path: /m.test(text)) return { set: false, value: null };
      const err = new Error(`openclaw config get ${path} failed (exit ${r.code})`);
      err.result = { code: r.code };
      throw err;
    },
    async configSet(path, value) {
      if (!ALLOWED_CONFIG_PATHS.set.includes(path)) throw refuse("set", path);
      const r = await call(["config", "set", path, String(value)], 120_000);
      if (r.code !== 0) {
        const err = new Error(`openclaw config set ${path} failed (exit ${r.code}): ${failureSummary(r)}`);
        err.readonly = isReadonlyRefusal(`${r.stderr}\n${r.stdout}`);
        throw err;
      }
      return r;
    },
    /**
     * Review Focus 3 / R-S2. OpenClaw exits 1 with `{"valid":false,"error":{"message":"file not found"},
     * "path":…}` when its config file does not exist yet (a fresh state dir; install and `config set`
     * create it): nothing to validate, so `ok` with `missing`. Fails closed: that answer counts as
     * missing only with an absolute path at which nothing exists; every other non-zero exit, a deadline
     * or unreadable output is invalid. Only `valid`, `error.message` and `path` are read.
     * @returns {Promise<{ ok: boolean, missing: boolean, code: number }>}
     */
    async configValidate() {
      const r = await call(["config", "validate", "--json"], 120_000);
      if (r.code === 0 && !r.timedOut) return { ok: true, missing: false, code: 0 };
      const json = r.timedOut ? null : parseJsonDoc(r.stdout);
      const missing =
        json !== null && typeof json === "object" && json.valid === false && json.error?.message === "file not found" &&
        typeof json.path === "string" && isAbsolute(json.path) && !present(json.path);
      return { ok: missing, missing, code: r.code };
    },
    /**
     * Fails closed (T6-e): `running` is false only for a definite "nothing listens" answer —
     * exit 0, JSON, /rpc/ok false with /rpc/connectFailure/kind "unreachable" (or, for a version
     * without that field, /port/status "free" or an ECONNREFUSED /rpc/error), and /port/status not
     * "busy" (fact h). A deadline, a non-zero exit,
     * unparseable output or any other RPC failure counts as running, so the store is never
     * restored under a Gateway that merely failed to answer. `confirmed` (exit 0 and /rpc/ok
     * true) is what HM1-R7's feature-cron step needs.
     * @returns {Promise<{ running: boolean, confirmed: boolean, detail: string }>}
     */
    async gatewayStatus() {
      const r = await call(["gateway", "status", "--json"], 60_000);
      const json = parseJson(r.stdout);
      if (r.code !== 0 || r.timedOut) return { running: true, confirmed: false, detail: `gateway status failed (exit ${r.code}${r.timedOut ? ", deadline exceeded" : ""}); assuming it runs` };
      const rpc = json !== null && typeof json === "object" ? json.rpc : null;
      if (!rpc || typeof rpc !== "object") return { running: true, confirmed: false, detail: "gateway status gave no rpc result; assuming it runs" };
      if (rpc.ok === true) return { running: true, confirmed: true, detail: "rpc ok" };
      const kind = rpc.connectFailure?.kind;
      const port = json.port?.status;
      const refused = kind === undefined && /\bECONNREFUSED\b/.test(String(rpc.error ?? ""));
      const stopped = rpc.ok === false && port !== "busy" && (kind === "unreachable" || (kind === undefined && (port === "free" || refused)));
      return stopped
        ? { running: false, confirmed: false, detail: `rpc ${kind ?? "failed"}, port ${port ?? "unknown"}` }
        : { running: true, confirmed: false, detail: `rpc not ok (${kind ?? "no failure kind"}), port ${port ?? "unknown"}; assuming it runs` };
    },
    async selftest({ downloadModels = false, stateDir } = {}) {
      const r = await call(["plur1bus", "selftest", "--json", ...(stateDir ? ["--state-dir", stateDir] : []), ...(downloadModels ? ["--download-models"] : [])], downloadModels ? 3_600_000 : 900_000);
      const line = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse().find((l) => l.startsWith("{"));
      return { code: r.code, report: line ? parseJson(line) : null, detail: String(r.stderr ?? "").trim() ? failureSummary({ stderr: r.stderr }) : "" };
    },
  };
}
