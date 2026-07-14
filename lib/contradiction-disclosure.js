/**
 * formatContradictionDisclosure(pairs, opts) -> string | null
 *
 * pairs: Array<{ winner, loser }> where winner/loser each have:
 *   { text?: string, description?: string, updatedAt?: string, createdAt?: string }
 *
 * opts: { enabled?: boolean }  (default enabled: true)
 *
 * Returns: one German context block for the first/most-important pair, or null.
 * Format: "Du hast dazu widersprüchliche Erinnerungen: '<loserText>' (älter) vs. '<winnerText>' (neuer). Du folgst der neueren — erwähne die Unsicherheit beiläufig, falls das Thema aufkommt."
 * Each text truncated to ~120 chars. Total output capped at ~400 chars. Fail-open (try/catch → null).
 */
export function formatContradictionDisclosure(pairs, opts = {}) {
  try {
    if (opts.enabled === false) return null;
    if (!pairs || pairs.length === 0) return null;

    const pair = pairs[0];
    const { winner, loser } = pair;

    const getRaw = (m) => (m?.description ?? m?.text ?? "");

    const truncate = (str, max = 120) => {
      if (!str) return "";
      const s = String(str);
      if (s.length <= max) return s;
      return s.slice(0, max) + "…";
    };

    const winnerText = truncate(getRaw(winner));
    const loserText = truncate(getRaw(loser));

    const result =
      `Du hast dazu widersprüchliche Erinnerungen: '${loserText}' (älter) vs. '${winnerText}' (neuer). Du folgst der neueren — erwähne die Unsicherheit beiläufig, falls das Thema aufkommt.`;

    if (result.length > 400) return result.slice(0, 400);
    return result;
  } catch (_) {
    return null;
  }
}
