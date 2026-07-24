/**
 * lib/with-timeout.js — Race a promise against a timeout.
 *
 * Used to add operation-level timeouts to LanceDB calls and other
 * long-running async work without mutating the underlying promise.
 */

/** Error returned promptly while retaining the underlying operation settlement. */
export class TimeoutError extends Error {
  /**
   * @param {string} label Operation label.
   * @param {number} ms Timeout in milliseconds.
   * @param {Promise<unknown>|null} [settlement] Underlying operation settlement.
   */
  constructor(label, ms, settlement = null) {
    super(`${label || "Operation"} timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.code = "ETIMEOUT";
    this.label = label;
    this.timeoutMs = ms;
    this.settlement = settlement;
  }
}

/**
 * Race `promise` against a timer of `ms` milliseconds.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 * @throws {TimeoutError}
 */
export function withTimeout(promise, ms, label) {
  const settlement = Promise.resolve(promise);
  if (!ms || ms <= 0) return settlement;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(label || "Operation", ms, settlement));
    }, ms);

    settlement.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
