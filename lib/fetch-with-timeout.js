/**
 * lib/fetch-with-timeout.js — Fetch wrapper with timeout, cleanup, and
 * optional retry for idempotent requests.
 */

import { hostFetch } from "./host-network.js";
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

/** Body readers of a Response; each one settles the deadline when it finishes. */
const BODY_READERS = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"];

/**
 * Fetch with one deadline for the whole exchange: connect, headers AND the
 * response body. The timer is not cleared when the headers arrive; it is
 * cleared when the caller has read the body (`json()`, `text()`, ...), or at
 * once for a response without a body or a non-ok status. A caller that reads
 * `response.body` as a stream stays bound by the deadline as well. A stalled
 * body read rejects with an `AbortError` that names only the host.
 *
 * @param {string} url
 * @param {RequestInit} [opts]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A response nobody reads must not keep the process alive until the deadline.
  timer.unref?.();
  let handedOver = false;
  try {
    let res;
    try {
      res = await hostFetch(url, { ...opts, signal: controller.signal });
    } catch (err) {
      throw sanitizeFetchError(err, url);
    }
    if (!res.ok) {
      try { await res.body?.cancel?.(); } catch { /* the status error below is what matters */ }
      const error = new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
      // Callers that classify failures (credential rejection, rate limit) read `.status`.
      error.status = res.status;
      throw error;
    }
    // No body to wait for (204, HEAD): the exchange is complete.
    if (res.body === null) return res;
    const bodyTimeout = () => {
      const err = new Error(`fetch timed out reading the response body from ${redactUrl(url)} after ${timeoutMs}ms`);
      err.name = "AbortError";
      return err;
    };
    for (const name of BODY_READERS) {
      if (typeof res[name] !== "function") continue;
      const original = res[name].bind(res);
      try {
        Object.defineProperty(res, name, {
          configurable: true,
          writable: true,
          value: async (...args) => {
            try {
              return await original(...args);
            } catch (err) {
              throw controller.signal.aborted ? bodyTimeout() : err;
            } finally {
              clearTimeout(timer);
            }
          },
        });
      } catch { /* a frozen response keeps the deadline timer: it aborts at the deadline */ }
    }
    handedOver = true;
    return res;
  } finally {
    if (!handedOver) clearTimeout(timer);
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
