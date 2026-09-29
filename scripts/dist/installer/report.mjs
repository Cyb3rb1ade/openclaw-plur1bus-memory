/**
 * scripts/dist/installer/report.mjs — step report and exit codes of the plugin installer.
 *
 * Human lines always go to stderr. With `--json`, `finish()` prints exactly one
 * `plur1bus.plugin-installer/1` document on stdout and nothing else is written
 * there (global constraint "--json").
 */

export const REPORT_SCHEMA = "plur1bus.plugin-installer/1";

/** Exit codes, spec A.3 step 8. */
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, NEEDS_CHOICE: 2, INCOMPATIBLE: 3, ROLLBACK_FAILED: 4 });

const MARK = { ok: "ok", failed: "FAILED", skipped: "skip", warn: "warn", planned: "plan", info: "info", handover: "next" };

/**
 * @param {{ json?: boolean, stderr?: { write(s: string): unknown }, stdout?: { write(s: string): unknown } }} opts
 */
export function createReport({ json = false, stderr = process.stderr, stdout = process.stdout } = {}) {
  /** @type {Array<{id: string, status: string, detail: string}>} */
  const steps = [];
  /** @type {Record<string, unknown>} */
  const fields = {};
  let finished = false;

  const line = (text) => stderr.write(`${text}\n`);

  return {
    /** Record a step and print its human line. */
    step(id, status, detail = "") {
      steps.push({ id, status, detail: String(detail) });
      line(`[${MARK[status] ?? status}] ${id}${detail ? `: ${detail}` : ""}`);
    },
    /** A free human line (notice, summary, manual step). */
    note(text) {
      line(text);
    },
    /** Set a top-level field of the JSON document. */
    set(key, value) {
      fields[key] = value;
    },
    get(key) {
      return fields[key];
    },
    steps,
    /** Print the final document (with --json) and return the exit code. */
    finish(exitCode) {
      if (finished) return exitCode;
      finished = true;
      if (json) {
        const doc = { schema: REPORT_SCHEMA, ok: exitCode === EXIT.OK, exitCode, ...fields, steps };
        stdout.write(`${JSON.stringify(doc)}\n`);
      }
      return exitCode;
    },
  };
}
