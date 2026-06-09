/**
 * lib/fetch-with-timeout.js — Fetch wrapper with timeout, cleanup, and
 * optional retry for idempotent requests.
 */

import { redactError } from "./safe-logging.js";

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
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
        if (logger) logger.debug(`[fetchRetry] attempt ${attempt + 1} failed, retrying in ${delay}ms: ${redactError(err).message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
