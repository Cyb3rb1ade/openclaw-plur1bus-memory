/**
 * lib/reminder-parser.js
 * Parst zeitliche Aussagen aus DE/EN-Text zu remindAt (epoch ms).
 * Timezone: Europe/Zurich.
 *
 * Scope: relative Zeiten ("in 10 Minuten") und vage Ausdrücke ("später").
 * Kein exact-time Parsing (morgen um 9, next Monday) — das würde einen
 * vollständigen Datetime-Parser erfordern, der über den aktuellen MVP hinausgeht.
 */

const RELATIVE_DE = {
  minuten: 1, minute: 1, min: 1,
  stunden: 60, stunde: 60, std: 60, h: 60,
  tagen: 1440, tage: 1440, tag: 1440, d: 1440,
};

const RELATIVE_EN = {
  minutes: 1, minute: 1, min: 1,
  hours: 60, hour: 60, h: 60,
  days: 1440, day: 1440, d: 1440,
};

const VAGUE_DEFAULTS_MINUTES = {
  "später": 120, "nachher": 60, "bald": 30,
  "later": 120, "soon": 30, "in a while": 60,
};

function nowMs() {
  return Date.now();
}

/**
 * @param {string} text
 * @param {Object} opts
 * @param {number} [opts.now] — epoch ms (default Date.now())
 * @param {string} [opts.timezone] — default "Europe/Zurich"
 * @returns {{remindAt: number|null, timePrecision: "relative"|"vague"|"none", requiresConfirmation: boolean, evidence: string}}
 */
export function parseReminderIntent(text, opts = {}) {
  const now = opts.now || nowMs();
  const lower = String(text || "").toLowerCase();

  // ── 1. Explicit half-hour (must come before generic regex)
  if (/\bin\s+(?:einer\s+)?halben\s+stunde\b/.test(lower)) {
    return {
      remindAt: now + 30 * 60_000,
      timePrecision: "relative",
      requiresConfirmation: false,
      evidence: "in einer halben Stunde",
    };
  }
  if (/\bin\s+half\s+an\s+hour\b/.test(lower)) {
    return {
      remindAt: now + 30 * 60_000,
      timePrecision: "relative",
      requiresConfirmation: false,
      evidence: "in half an hour",
    };
  }

  // ── 2. Relative DE: "in 10 Minuten", "in 2 Stunden"
  const relDe = lower.match(/\bin\s+(\d+|einer|eine|einem)\s*(\w+)/);
  if (relDe) {
    const amountRaw = relDe[1] || "1";
    const amount = amountRaw.match(/^ein/) ? 1 : parseInt(amountRaw, 10);
    const unitRaw = relDe[2];
    const unitMin = RELATIVE_DE[unitRaw];
    if (unitMin && Number.isFinite(amount)) {
      return {
        remindAt: now + amount * unitMin * 60_000,
        timePrecision: "relative",
        requiresConfirmation: false,
        evidence: `in ${amount} ${unitRaw}`,
      };
    }
  }

  // ── 3. Relative EN: "in 10 minutes", "in 2 hours"
  const relEn = lower.match(/\bin\s+(\d+)\s*(\w+)/);
  if (relEn) {
    const amount = parseInt(relEn[1], 10);
    const unitRaw = relEn[2];
    const unitMin = RELATIVE_EN[unitRaw];
    if (unitMin && Number.isFinite(amount)) {
      return {
        remindAt: now + amount * unitMin * 60_000,
        timePrecision: "relative",
        requiresConfirmation: false,
        evidence: `in ${amount} ${unitRaw}`,
      };
    }
  }

  // ── 4. Vague expressions
  for (const [phrase, minutes] of Object.entries(VAGUE_DEFAULTS_MINUTES)) {
    if (lower.includes(phrase)) {
      return {
        remindAt: now + minutes * 60_000,
        timePrecision: "vague",
        requiresConfirmation: true,
        evidence: phrase,
      };
    }
  }

  return {
    remindAt: null,
    timePrecision: "none",
    requiresConfirmation: false,
    evidence: "",
  };
}
