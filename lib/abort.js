/**
 * Throw when an operation's cancellation signal has been aborted.
 *
 * @param {AbortSignal|null|undefined} signal
 * @param {string} [message]
 * @returns {void}
 * @throws {Error} An AbortError (or the signal's supplied abort reason).
 */
export function throwIfAborted(signal, message = "operation aborted") {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
  }
  const error = signal.reason instanceof Error ? signal.reason : new Error(message);
  error.name = "AbortError";
  throw error;
}
