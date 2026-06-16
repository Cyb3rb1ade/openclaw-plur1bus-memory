/**
 * lib/with-timeout.js — Race a promise against a timeout.
 *
 * Used to add operation-level timeouts to LanceDB calls and other
 * long-running async work without mutating the underlying promise.
 */

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label || "Operation"} timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.code = "ETIMEOUT";
    this.label = label;
    this.timeoutMs = ms;
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
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(label || "Operation", ms));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
