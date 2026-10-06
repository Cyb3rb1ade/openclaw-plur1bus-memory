/**
 * lib/fetch-with-timeout.js — Fetch wrapper with timeout, cleanup, and
 * optional retry for idempotent requests.
 */

import { describeErrorForLog } from "./safe-logging.js";
import { redactUrl, redactUrlsInText } from "./log-redact.js";

/**
 * Rebuilds a fetch failure without the target URL. Runtime fetch errors can
 * name the URL (`Failed to parse URL from ...`) and their `cause` can carry
 * it too, and callers log `err.message`. Webhook URLs hold the secret in the
 * path or query, so only scheme + host (+ path hash) survive.
 */
function sanitizeFetchError(err, url) {
  const name = err?.name === "AbortError" || err?.name === "TimeoutError" ? err.name : "Error";
  const code = typeof err?.code === "string" ? err.code : typeof err?.cause?.code === "string" ? err.cause.code : undefined;
  let reason = String(err?.cause?.message ?? err?.message ?? "request failed");
  const raw = String(url ?? "");
  if (raw) reason = reason.split(raw).join("<url>");
  try {
    const u = new URL(raw);
    for (const secret of [u.href, `${u.pathname}${u.search}`, u.search.slice(1), u.username, u.password]) {
      if (secret.length >= 4) reason = reason.split(secret).join("<redacted>");
    }
  } catch { /* unparseable: the raw-string replacement above is the only handle */ }
  reason = redactUrlsInText(reason);
  const out = new Error(`fetch failed for ${redactUrl(url)}${code ? ` (${code})` : ""}: ${reason}`.slice(0, 300));
  out.name = name;
  if (code) out.code = code;
  return out;
}

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { ...opts, signal: controller.signal });
    } catch (err) {
      throw sanitizeFetchError(err, url);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithRetry(url, opts = {}, { timeoutMs = 10_000, maxRetries = 2, backoffMs = 500, logger = null } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchWithTimeout(url, opts, timeoutMs);
    } catch (err) {
      lastErr = err;
      const isTimeout = err.name === "AbortError";
      const isIdempotent = opts.method === "GET" || opts.method === "HEAD" || opts.method === undefined;
      if (!isIdempotent && !isTimeout) throw err;
      if (attempt < maxRetries) {
        const delay = backoffMs * 2 ** attempt;
        if (logger) logger.debug(`[fetchRetry] attempt ${attempt + 1} failed, retrying in ${delay}ms: ${describeErrorForLog(err)}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
