/**
 * scripts/dist/installer/hermes/config-edit.mjs — the `memory.provider` line edit for Hermes 0.21.4 (ruling HM2-R24).
 *
 * `hermes config set` on 0.21.4 rewrites config.yaml without a single comment or default-valued key
 * (fact sheet §c: 2267 lines → 148). There the installer changes the one `provider:` line of the
 * top-level `memory:` block itself, after a backup (`config.yaml.plur1bus-bak-<ts>`, 0600), atomically
 * and with the file's mode kept. Every other byte stays as it was (line endings included). From 0.21.5
 * `hermes config set` keeps comments and is used instead (./install.mjs).
 *
 * This is the only module that opens config.yaml, and it reads nothing from it except the
 * `memory:` block's `provider:` line; nothing it reads is printed, logged or put in a report.
 * Anything it cannot edit with certainty (flow style, anchors, tabs, several documents, a duplicate
 * key, a quoted or multi-line value it does not recognise) is refused: compat reports it and nothing
 * is changed (the user edits the line, or updates Hermes to ≥ 0.21.5).
 */

import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../fsutil.mjs";

export const CONFIG_FILE = "config.yaml";
const MAX_BYTES = 4 * 1024 * 1024;
const PLAIN = /^[A-Za-z0-9_.-]*$/;
const PROVIDER_LINE = /^( +)provider[ ]*:(?:[ ]+(.*?))?[ ]*$/;
const BOM = "\uFEFF";

/**
 * The text as lines with each line's own terminator (a mixed LF/CRLF file stays mixed) and a leading BOM kept apart.
 * @returns {{ bom: string, lines: string[], eols: string[], eol: string }} `eol` is the terminator for a new line
 */
function splitLines(text) {
  const bom = text.startsWith(BOM) ? BOM : "";
  const parts = text.slice(bom.length).split(/(\r\n|\n)/);
  const lines = [];
  const eols = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i]);
    eols.push(parts[i + 1] ?? "");
  }
  const eol = eols.find((e) => e !== "") ?? "\n";
  return { bom, lines, eols, eol };
}

const joinLines = ({ bom, lines, eols }) => bom + lines.map((l, i) => l + eols[i]).join("");

/** The value part of a `provider:` line: a plain, '…' or "…" scalar with an optional trailing comment. */
function parseValue(rest) {
  if (rest === undefined || rest === "") return { value: "", comment: "" };
  if (rest.startsWith("#")) return { value: "", comment: rest };
  const m = /^(?:'([A-Za-z0-9_.-]*)'|"([A-Za-z0-9_.-]*)"|([A-Za-z0-9_.-]+))(?:[ ]+(#.*))?$/.exec(rest);
  if (!m) return null;
  return { value: m[1] ?? m[2] ?? m[3] ?? "", comment: m[4] ?? "" };
}

/**
 * Locate the top-level `memory:` block and its `provider:` line.
 * @returns {{ ok: true, memoryIndex: number|null, providerIndex: number|null, childIndent: string } | { ok: false, reason: string }}
 */
export function locateProvider(text) {
  const { lines } = splitLines(text);
  if (lines.some((l) => l.includes(BOM))) return { ok: false, reason: "config.yaml has a byte-order mark inside the file" };
  if (lines.some((l) => l.includes("\t"))) return { ok: false, reason: "config.yaml contains tab characters" };
  if (lines.some((l, i) => (i > 0 && /^---(\s|$)/.test(l)) || /^\.\.\.(\s|$)/.test(l))) return { ok: false, reason: "config.yaml holds more than one YAML document" };
  const memoryLines = lines.map((l, i) => (/^memory[ ]*:/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (memoryLines.length > 1) return { ok: false, reason: "config.yaml has more than one top-level memory: key" };
  if (lines.some((l) => /^["']?memory["']?[ ]*:/.test(l) && !/^memory[ ]*:/.test(l))) return { ok: false, reason: "config.yaml quotes the memory: key" };
  if (memoryLines.length === 0) return { ok: true, memoryIndex: null, providerIndex: null, childIndent: "  " };
  const mi = memoryLines[0];
  const rest = lines[mi].replace(/^memory[ ]*:/, "").trim();
  if (rest && !rest.startsWith("#")) return { ok: false, reason: "the memory: key is not a block mapping (flow style, anchor or scalar)" };
  let childIndent = null;
  const providers = [];
  for (let i = mi + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || /^ *#/.test(l)) continue;
    // a sequence as the memory: value (`- x` at any indent, also column 0) is not a mapping the edit can extend
    if (childIndent === null && /^ *-( |$)/.test(l)) return { ok: false, reason: "the memory: key holds a sequence, not a mapping" };
    if (!l.startsWith(" ")) break; // the next top-level key ends the block
    const indent = /^( +)/.exec(l)[1];
    if (childIndent === null) childIndent = indent;
    if (indent.length < childIndent.length) return { ok: false, reason: "the memory: block has inconsistent indentation" };
    if (indent === childIndent && /^ +["']?provider["']?[ ]*:/.test(l)) providers.push(i);
  }
  if (providers.length > 1) return { ok: false, reason: "the memory: block has more than one provider: key" };
  if (providers.length === 1) {
    const m = PROVIDER_LINE.exec(lines[providers[0]]);
    const v = m ? parseValue(m[2]) : null;
    if (!m || v === null) return { ok: false, reason: "memory.provider has a value form the installer does not edit (quoted, anchored or multi-line)" };
    if (v.value === "") {
      // `provider:` with nothing after it: a nested mapping or sequence below would be orphaned by a scalar
      const next = lines.slice(providers[0] + 1).find((l) => l.trim() !== "" && !/^ *#/.test(l));
      if (next !== undefined && (/^ *-( |$)/.test(next) && /^( *)/.exec(next)[1].length >= m[1].length) || (next !== undefined && /^( *)/.exec(next)[1].length > m[1].length)) {
        return { ok: false, reason: "memory.provider holds a nested value, not a scalar" };
      }
    }
  }
  return { ok: true, memoryIndex: mi, providerIndex: providers[0] ?? null, childIndent: childIndent ?? "  " };
}

/**
 * The text with memory.provider set to `value` (pure).
 * @returns {{ ok: true, text: string, undo: { kind: "replaced", originalLine: string } | { kind: "inserted" } | { kind: "appended" } } | { ok: false, reason: string }}
 */
export function planProviderEdit(text, value) {
  if (!PLAIN.test(value)) return { ok: false, reason: `refusing to write provider value ${JSON.stringify(value)}` };
  const written = value === "" ? '""' : value; // "" = Hermes' built-in store (uninstall back to no provider)
  const loc = locateProvider(text);
  if (!loc.ok) return loc;
  const sp = splitLines(text);
  const { lines, eols } = sp;
  if (loc.providerIndex !== null) {
    const originalLine = lines[loc.providerIndex];
    const m = PROVIDER_LINE.exec(originalLine);
    const { comment } = parseValue(m[2]);
    lines[loc.providerIndex] = `${m[1]}provider: ${written}${comment ? ` ${comment}` : ""}`;
    return { ok: true, text: joinLines(sp), undo: { kind: "replaced", originalLine } };
  }
  if (loc.memoryIndex !== null) {
    // the new line takes the memory: line's own terminator
    const mi = loc.memoryIndex;
    const wasLast = eols[mi] === ""; // `memory:` ends a file without a final newline
    const newEol = wasLast ? "" : eols[mi];
    if (wasLast) eols[mi] = sp.eol;
    lines.splice(mi + 1, 0, `${loc.childIndent}provider: ${written}`);
    eols.splice(mi + 1, 0, newEol);
    return { ok: true, text: joinLines(sp), undo: { kind: "inserted" } };
  }
  const { eol } = sp;
  const body = text === "" || text === sp.bom || text.endsWith("\n") ? text : `${text}${eol}`;
  return { ok: true, text: `${body}memory:${eol}  provider: ${written}${eol}`, undo: { kind: "appended" } };
}

/** Undo planProviderEdit on the current text (pure); the provider line must still be the one we wrote. */
export function planProviderUndo(text, undo, value) {
  const loc = locateProvider(text);
  if (!loc.ok) return loc;
  const sp = splitLines(text);
  const { lines, eols } = sp;
  if (loc.providerIndex === null) return { ok: true, text }; // nothing of ours left
  const m = PROVIDER_LINE.exec(lines[loc.providerIndex]);
  const current = parseValue(m[2])?.value;
  if (current !== value) return { ok: false, reason: `memory.provider is ${JSON.stringify(current)} now, not ${JSON.stringify(value)}; left as it is` };
  if (undo.kind === "replaced") {
    lines[loc.providerIndex] = undo.originalLine;
    return { ok: true, text: joinLines(sp) };
  }
  const removedEol = eols[loc.providerIndex];
  lines.splice(loc.providerIndex, 1);
  eols.splice(loc.providerIndex, 1);
  if (removedEol === "" && loc.providerIndex > 0) eols[loc.providerIndex - 1] = ""; // the file ended without a newline
  if (undo.kind === "appended" && loc.memoryIndex !== null) {
    if (lines.slice(loc.memoryIndex + 1).every((l) => l.trim() === "")) {
      lines.splice(loc.memoryIndex, 1);
      eols.splice(loc.memoryIndex, 1);
    }
  }
  return { ok: true, text: joinLines(sp) };
}

/**
 * config.yaml, read through a symlink: `file` is the link's target (written in place, so the link and its target
 * stay as they are, dotfile managers included), `link` the path in the Hermes home (the backup goes beside it).
 */
function readConfig(hermesHome) {
  const link = join(hermesHome, CONFIG_FILE);
  let file = link;
  try {
    if (lstatSync(link).isSymbolicLink()) file = realpathSync(link);
  } catch {
    // missing (or a dangling link: existsSync below says no file)
  }
  if (!existsSync(file)) return { file, link, text: null, mode: null };
  const st = statSync(file);
  if (st.size > MAX_BYTES) return { file, link, text: undefined, mode: st.mode & 0o777 };
  return { file, link, text: readFileSync(file, "utf8"), mode: st.mode & 0o777 };
}

/**
 * Can the line edit run here? (compat, before any change).
 * @returns {{ ok: boolean, exists: boolean, reason?: string }}
 */
export function checkConfigEditable(hermesHome) {
  const { text } = readConfig(hermesHome);
  if (text === null) return { ok: true, exists: false };
  if (text === undefined) return { ok: false, exists: true, reason: "config.yaml is larger than 4 MiB" };
  const plan = planProviderEdit(text, "plur1bus");
  return plan.ok ? { ok: true, exists: true } : { ok: false, exists: true, reason: plan.reason };
}

function writeKeepingMode(file, text, mode) {
  writeFileAtomic(file, text);
  if (mode !== null && process.platform !== "win32") chmodSync(file, mode);
}

/**
 * Set memory.provider by a line edit. The first edit of a run keeps a backup.
 * @returns {{ backup: string|null, undo: object }}
 */
export function setProviderLine({ hermesHome, value, now = Date.now, backup = true, onPlan = null }) {
  const { file, link, text, mode } = readConfig(hermesHome);
  if (text === undefined) throw new Error("config.yaml is larger than 4 MiB");
  if (text === null && file !== link) throw new Error("config.yaml is a symlink to a missing file");
  const plan = planProviderEdit(text ?? "", value);
  if (!plan.ok) throw new Error(`cannot edit memory.provider in config.yaml: ${plan.reason}`);
  if (text === null) plan.undo = { ...plan.undo, created: true }; // no config.yaml before: the undo removes ours
  let bak = null;
  if (text !== null && backup) {
    bak = `${link}.plur1bus-bak-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, bak);
    if (process.platform !== "win32") chmodSync(bak, 0o600);
  }
  // the caller records the undo before the file changes, so a killed run can still be rolled back
  if (onPlan) onPlan({ backup: bak, undo: plan.undo });
  writeKeepingMode(file, plan.text, mode);
  return { backup: bak, undo: plan.undo };
}

/** Undo setProviderLine. Throws when the line is no longer ours. */
export function undoProviderLine({ hermesHome, undo, value }) {
  const { file, text, mode } = readConfig(hermesHome);
  if (text === null || text === undefined) throw new Error("config.yaml is missing or too large; restore it from the backup");
  const plan = planProviderUndo(text, undo, value);
  if (!plan.ok) throw new Error(plan.reason);
  if (undo.created && plan.text.replace(BOM, "").trim() === "") rmSync(file, { force: true });
  else if (plan.text !== text) writeKeepingMode(file, plan.text, mode);
}

/**
 * memory.provider as the line in config.yaml reads it (rollback when `hermes config get` fails, HM2-R17a):
 * the value ("" for unset), or null when the file cannot be read with certainty.
 */
export function readProviderLine(hermesHome) {
  let cfg;
  try {
    cfg = readConfig(hermesHome);
  } catch {
    return null;
  }
  if (cfg.text === null) return "";
  if (cfg.text === undefined) return null;
  const loc = locateProvider(cfg.text);
  if (!loc.ok) return null;
  if (loc.providerIndex === null) return "";
  const m = PROVIDER_LINE.exec(splitLines(cfg.text).lines[loc.providerIndex]);
  return parseValue(m[2])?.value ?? null;
}
