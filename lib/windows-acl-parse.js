/**
 * Strict, locale-independent parsers for the Windows ACL fast path.
 * Unknown ACE kinds and junk fail closed. A NULL DACL is a distinct error
 * (`ACL_NULL_DACL`) so the reader can refuse it without falling back.
 */

/** Untranslated SID, e.g. `S-1-5-18`. */
export const SID_PATTERN = /^S-1-\d+(-\d+)*$/;

/**
 * @param {string} [message] Error text.
 * @returns {Error & {code: "ACL_PARSE"}} Parse failure.
 */
export function aclParseError(message = "directory ACL read returned malformed output") {
  const error = new Error(message);
  error.code = "ACL_PARSE";
  return error;
}

/**
 * @returns {Error & {code: "ACL_NULL_DACL"}} Observed NULL DACL (everyone full access).
 */
export function aclNullDaclError() {
  const error = aclParseError("directory ACL has a null DACL");
  error.code = "ACL_NULL_DACL";
  return error;
}

/**
 * @param {unknown} value Candidate.
 * @returns {value is string} True when `value` is an untranslated SID.
 */
export function isSid(value) {
  return typeof value === "string" && SID_PATTERN.test(value);
}

/**
 * Parse `cscript` output from lib/read-directory-acl.vbs.
 * A `DACL=NULL` line is reported even if other lines are junk, so a banner
 * cannot turn a NULL DACL into a PowerShell fallback.
 * @param {string} text WMI dump.
 * @returns {{ownerSid: string, aces: Array<{sid: string, type: "Allow"|"Deny"}>}} Owner and access ACEs.
 */
export function parseWmiAcl(text) {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const trimmed = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line) trimmed.push(line);
  }
  if (trimmed.some((line) => line === "DACL=NULL")) throw aclNullDaclError();
  let ownerSid = null;
  const aces = [];
  if (trimmed.length === 0) throw aclParseError();
  for (const line of trimmed) {
    if (line.startsWith("OWNER=")) {
      if (ownerSid) throw aclParseError();
      ownerSid = line.slice("OWNER=".length);
      if (!isSid(ownerSid)) throw aclParseError();
      continue;
    }
    if (line.startsWith("ACE=")) {
      const body = line.slice("ACE=".length);
      const comma = body.indexOf(",");
      if (comma < 0) throw aclParseError();
      const aceType = body.slice(0, comma);
      const sid = body.slice(comma + 1);
      if (!isSid(sid)) throw aclParseError();
      if (aceType === "0") aces.push({ sid, type: "Allow" });
      else if (aceType === "1") aces.push({ sid, type: "Deny" });
      else throw aclParseError();
      continue;
    }
    throw aclParseError();
  }
  if (!ownerSid) throw aclParseError();
  return { ownerSid, aces };
}

function splitCsvLine(line) {
  const fields = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else current += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(current);
      current = "";
    } else current += ch;
  }
  if (quoted) throw aclParseError();
  fields.push(current);
  return fields;
}

/**
 * Parse `whoami /user /fo csv /nh`.
 * @param {string} text CSV line.
 * @returns {string} Current user SID.
 */
export function parseWhoamiCsv(text) {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter((line) => line.trim());
  if (lines.length !== 1) throw aclParseError();
  const fields = splitCsvLine(lines[0]).map((field) => field.trim());
  const sids = fields.filter((field) => isSid(field));
  if (sids.length !== 1) throw aclParseError();
  if (fields.length === 1) return sids[0];
  if (fields.length === 2 && isSid(fields[1]) && !isSid(fields[0])) return fields[1];
  throw aclParseError();
}
