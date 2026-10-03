/**
 * Strict, locale-independent parsers for Windows ACL text.
 *
 * SDDL aliases that are machine- or domain-relative (LA, LG, DA, …) are
 * rejected: they cannot be expanded without a lookup. Unknown ACE kinds
 * (object, callback/conditional, audit) fail closed.
 */

/** Untranslated SID, e.g. `S-1-5-18`. */
export const SID_PATTERN = /^S-1-\d+(-\d+)*$/;

/** Well-known SDDL SID aliases whose values are constant (not machine-relative). */
const SID_ALIASES = Object.freeze({
  AA: "S-1-5-32-579",
  AC: "S-1-15-2-1",
  AN: "S-1-5-7",
  AO: "S-1-5-32-548",
  AU: "S-1-5-11",
  BA: "S-1-5-32-544",
  BG: "S-1-5-32-546",
  BO: "S-1-5-32-551",
  BU: "S-1-5-32-545",
  CD: "S-1-5-32-574",
  CG: "S-1-3-1",
  CO: "S-1-3-0",
  CY: "S-1-5-32-569",
  ED: "S-1-5-9",
  ER: "S-1-5-32-573",
  ES: "S-1-5-32-576",
  HA: "S-1-5-32-578",
  HI: "S-1-16-12288",
  IS: "S-1-5-32-568",
  IU: "S-1-5-4",
  LS: "S-1-5-19",
  LU: "S-1-5-32-559",
  LW: "S-1-16-4096",
  ME: "S-1-16-8192",
  MP: "S-1-16-8448",
  MU: "S-1-5-32-558",
  NO: "S-1-5-32-556",
  NS: "S-1-5-20",
  NU: "S-1-5-2",
  OW: "S-1-3-4",
  PS: "S-1-5-10",
  PU: "S-1-5-32-547",
  RC: "S-1-5-12",
  RD: "S-1-5-32-555",
  RE: "S-1-5-32-552",
  RM: "S-1-5-32-580",
  SI: "S-1-16-16384",
  SO: "S-1-5-32-549",
  SU: "S-1-5-6",
  SY: "S-1-5-18",
  UD: "S-1-5-84-0-0-0-0-0",
  WD: "S-1-1-0",
  WR: "S-1-5-33",
});

const ACE_FLAG_PAIRS = new Set(["CI", "FA", "ID", "IO", "NP", "OI", "SA"]);
const GUID_PATTERN = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
const RIGHTS_PATTERN = /^[A-Z0-9]*$/i;

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
 * @param {unknown} value Candidate.
 * @returns {value is string} True when `value` is an untranslated SID.
 */
export function isSid(value) {
  return typeof value === "string" && SID_PATTERN.test(value);
}

/**
 * Expand a SID or a constant SDDL alias. Machine-relative aliases (LA, LG, DA)
 * are rejected.
 * @param {string} token SID or two-letter alias.
 * @returns {string} SID.
 */
export function expandSid(token) {
  if (typeof token !== "string" || token.length === 0) throw aclParseError();
  if (SID_PATTERN.test(token)) return token;
  const sid = SID_ALIASES[token.toUpperCase()];
  if (!sid) throw aclParseError();
  return sid;
}

function takeSection(sddl, letter) {
  const start = sddl.indexOf(`${letter}:`);
  if (start < 0) return null;
  const bodyStart = start + 2;
  let end = sddl.length;
  for (const next of ["O:", "G:", "D:", "S:"]) {
    if (next[0] === letter) continue;
    const at = sddl.indexOf(next, bodyStart);
    if (at >= 0 && at < end) end = at;
  }
  return sddl.slice(bodyStart, end);
}

function splitAces(body) {
  const aces = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "(") throw aclParseError();
    let depth = 0;
    let j = i;
    for (; j < body.length; j += 1) {
      if (body[j] === "(") depth += 1;
      else if (body[j] === ")") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    if (depth !== 0) throw aclParseError();
    aces.push(body.slice(i + 1, j - 1));
    i = j;
  }
  return aces;
}

function parseAce(raw) {
  const fields = raw.split(";");
  if (fields.length !== 6) throw aclParseError();
  const [type, flags, rights, objectGuid, inheritGuid, sidToken] = fields;
  if (type !== "A" && type !== "D") throw aclParseError();
  if (flags.length % 2 !== 0) throw aclParseError();
  for (let i = 0; i < flags.length; i += 2) {
    if (!ACE_FLAG_PAIRS.has(flags.slice(i, i + 2))) throw aclParseError();
  }
  if (!RIGHTS_PATTERN.test(rights)) throw aclParseError();
  if (objectGuid && !GUID_PATTERN.test(objectGuid)) throw aclParseError();
  if (inheritGuid && !GUID_PATTERN.test(inheritGuid)) throw aclParseError();
  return { sid: expandSid(sidToken), type: type === "A" ? "Allow" : "Deny" };
}

function parseDaclFlags(flags) {
  if (flags.includes("NO_ACCESS_CONTROL")) throw aclParseError();
  let rest = flags;
  if (rest.startsWith("P")) rest = rest.slice(1);
  if (rest.startsWith("AR")) rest = rest.slice(2);
  if (rest.startsWith("AI")) rest = rest.slice(2);
  if (rest.length !== 0) throw aclParseError();
}

/**
 * Parse a security descriptor (or DACL-only string that still includes `O:`).
 * @param {string} text SDDL.
 * @returns {{ownerSid: string, aces: Array<{sid: string, type: "Allow"|"Deny"}>}} Owner and access ACEs.
 */
export function parseSddl(text) {
  const sddl = String(text ?? "").replace(/^\uFEFF/, "").replace(/\s+/g, "");
  if (!sddl) throw aclParseError();
  const ownerRaw = takeSection(sddl, "O");
  const daclRaw = takeSection(sddl, "D");
  if (ownerRaw == null || daclRaw == null) throw aclParseError();
  const ownerSid = expandSid(ownerRaw);
  const paren = daclRaw.indexOf("(");
  const flags = paren < 0 ? daclRaw : daclRaw.slice(0, paren);
  const acesBody = paren < 0 ? "" : daclRaw.slice(paren);
  parseDaclFlags(flags);
  const aces = splitAces(acesBody).map(parseAce);
  return { ownerSid, aces };
}

/**
 * Parse `cscript` output from lib/read-directory-acl.vbs.
 * @param {string} text WMI dump.
 * @returns {{ownerSid: string, aces: Array<{sid: string, type: "Allow"|"Deny"}>}} Owner and access ACEs.
 */
export function parseWmiAcl(text) {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let ownerSid = null;
  const aces = [];
  let sawContent = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    sawContent = true;
    if (line === "DACL=NULL") throw aclParseError();
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
  if (!sawContent || !ownerSid) throw aclParseError();
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
