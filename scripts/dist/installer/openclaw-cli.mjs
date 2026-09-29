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
 * "valid but unset" means unset, (h) Gateway running ⇔ exit 0 and /rpc/ok,
 * (j) the readonly / Nix refusal texts.
 */

import { execFile } from "node:child_process";

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

function refuse(kind, path) {
  const err = new Error(`config path ${JSON.stringify(path)} is not in the installer's config allow-list (${kind})`);
  err.code = "CONFIG_PATH_NOT_ALLOWED";
  return err;
}

/** Last few non-empty lines of an OpenClaw message, for a human report line. */
export function tail(text, n = 3) {
  return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(" | ");
}

/**
 * @param {{ bin: string, env: Record<string,string|undefined>, run?: typeof defaultRun, timeoutMs?: number }} opts
 */
export function createOpenclawCli({ bin, env, run = defaultRun, timeoutMs = 300_000 }) {
  const call = (args, ms = timeoutMs) => run(bin, args, { env, timeoutMs: ms });

  return {
    bin,
    async version() {
      const r = await call(["--version"], 60_000);
      const first = r.stdout.split(/\r?\n/)[0]?.trim() ?? "";
      const m = VERSION_RE.exec(first);
      if (r.code !== 0 || !m) return { ok: false, version: null, commit: null, detail: tail(r.stderr || r.stdout) };
      return { ok: true, version: m[1], commit: m[2] };
    },
    /** @returns {Promise<{ code: number, json: any, installed: boolean, present: boolean, notFound: boolean, detail: string }>} */
    async inspect(id, { runtime = false } = {}) {
      const r = await call(["plugins", "inspect", id, ...(runtime ? ["--runtime"] : []), "--json"], runtime ? 600_000 : timeoutMs);
      const json = parseJson(r.stdout);
      const present = r.code === 0 && json !== null && typeof json === "object" && json.ok !== false;
      const notFound = r.code !== 0 && json?.ok === false && /^Plugin not found:/.test(String(json?.error?.message ?? ""));
      return { code: r.code, json, present, installed: present && json.install != null && typeof json.install === "object", notFound, detail: notFound ? "not installed" : tail(json?.error?.message ?? r.stderr) };
    },
    install(spec, { force = false, pin = false, acceptCapabilities = false } = {}) {
      return call(["plugins", "install", spec, ...(pin ? ["--pin"] : []), ...(force ? ["--force"] : []), ...(acceptCapabilities ? ["--accept-capabilities"] : [])], 1_800_000);
    },
    update(spec) {
      return call(["plugins", "update", spec], 1_800_000);
    },
    uninstall(id, { keepFiles = false } = {}) {
      return call(["plugins", "uninstall", id, ...(keepFiles ? ["--keep-files"] : []), "--force"]);
    },
    enable(id) {
      return call(["plugins", "enable", id]);
    },
    /** @returns {Promise<{ set: boolean, value: string|null }>} */
    async configGet(path) {
      if (!ALLOWED_CONFIG_PATHS.get.includes(path)) throw refuse("get", path);
      const r = await call(["config", "get", path], 60_000);
      if (r.code === 0) return { set: true, value: r.stdout.replace(/\r?\n$/, "").trim() };
      if (/valid but unset/i.test(`${r.stderr}\n${r.stdout}`)) return { set: false, value: null };
      const err = new Error(`openclaw config get ${path} failed (exit ${r.code})`);
      err.result = { code: r.code };
      throw err;
    },
    async configSet(path, value) {
      if (!ALLOWED_CONFIG_PATHS.set.includes(path)) throw refuse("set", path);
      const r = await call(["config", "set", path, String(value)], 120_000);
      if (r.code !== 0) {
        const err = new Error(`openclaw config set ${path} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`);
        err.readonly = isReadonlyRefusal(`${r.stderr}\n${r.stdout}`);
        throw err;
      }
      return r;
    },
    async configValidate() {
      const r = await call(["config", "validate"], 120_000);
      return { ok: r.code === 0, code: r.code };
    },
    async gatewayStatus() {
      const r = await call(["gateway", "status", "--json"], 60_000);
      const json = parseJson(r.stdout);
      return { running: r.code === 0 && json?.rpc?.ok === true };
    },
    async selftest({ downloadModels = false, stateDir } = {}) {
      const r = await call(["plur1bus", "selftest", "--json", ...(stateDir ? ["--state-dir", stateDir] : []), ...(downloadModels ? ["--download-models"] : [])], downloadModels ? 3_600_000 : 900_000);
      const line = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse().find((l) => l.startsWith("{"));
      return { code: r.code, report: line ? parseJson(line) : null, detail: tail(r.stderr) };
    },
  };
}
