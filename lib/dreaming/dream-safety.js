/** Shared boundaries for model-generated dreams and REM pattern descriptions. */

const UNSAFE_TEXT = [
  ["structure", /<\|[^>]*\|>|<\/?(?:system|assistant|developer|tool|evidence)\b|<!--|```/i],
  ["role_directive", /(?:^|\n)\s*(?:system|developer|assistant|tool)\s*:|\b(?:ignore|disregard|forget|ignorier\w*|vergiss)\b[^.\n]{0,70}\b(?:instructions?|prompts?|rules?|anweisungen?|regeln?|richtlinien?)\b|\b(?:system|developer)[ _-]?(?:prompt|message|instruction)|\b(?:admin|developer|debug|god)[ -]?(?:mode|modus)\b|\b(?:you are now|du bist jetzt|from now on|von nun an|act as|pretend|impersonate|übernimm die rolle|verhalte dich als)\b/i],
  ["tool_directive", /\b(?:sudo\s+|rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|chmod\s+\d{3,4}|(?:exec|eval)\s*\()|\bmemory_[a-z_]+\b|\b(?:run|execute|invoke|call|use|führe|rufe|verwende|benutze)\b[^.\n]{0,60}\b(?:shell|bash|powershell|sudo|exec|curl|wget|chmod|tools?|function)\b|["'](?:tool|tool_call|function_call)["']\s*:|\b(?:delete|remove|wipe|purge|forget|lösch\w*|entferne|vergiss)\b[^.\n]{0,60}\b(?:memor\w*|files?|data|erinnerung\w*|dateien|daten)\b/i],
  ["rights_directive", /\b(?:grant|elevate|disable|bypass|override|gewähr\w*|erteil\w*|verleih\w*|deaktivier\w*|umgeh\w*)\b[^.\n]{0,100}\b(?:admin\w*|permissions?|privileges?|access|safety|security|polic\w*|berechtigung\w*|rechte\w*|zugriffsrechte\w*|sicherheit\w*|schutz\w*)\b/i],
  ["url", /\b[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript):|\bwww\.|\b[a-z0-9-]{2,}\.(?:com|net|org|io|de|ru|cn|xyz|info|biz|app|dev|ly|me|co|tk|top)\b/i],
  ["secret", /\b(?:api[_ -]?key|apikey|secret|token|passwor[dt]|passwd|kennwort|credential\w*|zugangsdaten)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{16,}|\b(?:ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza)[A-Za-z0-9_-]{10,}|\bbearer\s+\S{8,}|\beyJ[A-Za-z0-9_-]{10,}\.|-----BEGIN [A-Z ]*(?:KEY|CERTIFICATE)|\b(?=[A-Za-z0-9+\/_=-]*\d)[A-Za-z0-9+\/_=-]{32,}\b/i],
];

/**
 * Frame bounded external material as data, escaping delimiters supplied by it.
 * @param {string[]} values Evidence strings.
 * @param {{maxItems?: number, maxChars?: number}} [options] Per-block bounds.
 * @returns {string} One evidence block.
 */
export function formatDreamEvidence(values, { maxItems = 15, maxChars = 250 } = {}) {
  const lines = values.filter((value) => typeof value === "string" && value.trim())
    .slice(0, maxItems)
    .map((value) => `- ${value.slice(0, maxChars).replace(/</g, "‹").replace(/>/g, "›")}`);
  return `<evidence>\n${lines.join("\n") || "(kaum Material)"}\n</evidence>`;
}

/**
 * Reject unsafe generated content before any durable dream or pattern write.
 * @param {unknown} text Candidate text; never included in the returned reason.
 * @param {{minChars?: number, maxChars?: number}} [options] Inclusive length bounds.
 * @returns {{ok: boolean, reason?: string}} Content-free verdict.
 */
export function validateDreamText(text, { minChars = 40, maxChars = 3000 } = {}) {
  if (typeof text !== "string" || text.trim().length < minChars) return { ok: false, reason: "too_short" };
  if (text.length > maxChars) return { ok: false, reason: "too_long" };
  for (const [reason, pattern] of UNSAFE_TEXT) {
    if (pattern.test(text)) return { ok: false, reason };
  }
  return { ok: true };
}
