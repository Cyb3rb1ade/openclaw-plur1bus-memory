/**
 * Throw when an operation's cancellation signal has been aborted.
 *
 * The thrown error is the signal's own `reason` as-is when the runtime
 * exposes `signal.throwIfAborted()` (Node >= 24 always does): for
 * `AbortSignal.timeout()` that is a `TimeoutError` DOMException, not an
 * `AbortError` — this function does not normalise its name. Only when the
 * runtime lacks `throwIfAborted()` and `reason` isn't an `Error` does it fall
 * back to a plain `Error` named `AbortError`.
 *
 * @param {AbortSignal|null|undefined} signal
 * @param {string} [message]
 * @returns {void}
 * @throws {Error} The signal's abort reason, or a fallback `AbortError`.
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

/**
 * Derive a signal that aborts with the parent signal or after its own budget,
 * whichever comes first.
 *
 * For sub-tasks that share a caller's deadline but must not be able to eat all
 * of it: the caller keeps whatever the sub-task leaves behind.
 *
 * @param {AbortSignal|null|undefined} signal Parent signal, may be absent.
 * @param {number} budgetMs Sub-task budget in milliseconds.
 * @returns {AbortSignal|undefined} Combined signal, or the parent alone when
 *   the runtime cannot combine signals.
 */
export function deriveBudgetedSignal(signal, budgetMs) {
  const budget = Number(budgetMs);
  if (!Number.isFinite(budget) || budget <= 0) return signal ?? undefined;
  if (typeof AbortSignal?.timeout !== "function") return signal ?? undefined;
  const timeout = AbortSignal.timeout(budget);
  if (!signal) return timeout;
  if (typeof AbortSignal.any !== "function") return signal;
  return AbortSignal.any([signal, timeout]);
}

/**
 * True when an abort came from a sub-task's own budget rather than the caller.
 *
 * Lets a caller report "the sub-task ran long" separately from "we were
 * cancelled", which are different operational events.
 *
 * @param {unknown} error The error thrown by the sub-task.
 * @param {AbortSignal|null|undefined} parentSignal The caller's signal.
 * @returns {boolean}
 */
export function isBudgetExhaustion(error, parentSignal) {
  const name = error && typeof error === "object" ? error.name : undefined;
  if (name !== "AbortError" && name !== "TimeoutError") return false;
  return !parentSignal?.aborted;
}

/**
 * True for the cancellation errors an aborted signal produces.
 *
 * Lets a caller tell "our budget ran out" from "the work itself broke", which
 * are different operational events and deserve different log lines.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
  const name = error && typeof error === "object" ? error.name : undefined;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Race a promise against a cancellation signal. The underlying work is not
 * stopped (a promise cannot be), but the caller stops waiting the moment the
 * signal aborts, and a late rejection of the losing promise is observed so it
 * never surfaces as an unhandled rejection.
 *
 * The rejection this throws on abort carries the still-running `promise` as
 * `.settlement` (mirroring `lib/with-timeout.js`'s `TimeoutError`), so a
 * caller holding a resource lease across the call — `AgentDbPool.withDb`'s
 * `waitForTimeoutSettlement` (index.js) is the motivating case — can keep the
 * lease until the underlying operation actually finishes instead of handing
 * it back while a live LanceDB read (or any other in-flight work) is still
 * using it.
 *
 * @template T
 * @param {Promise<T>|T} promise
 * @param {AbortSignal|null|undefined} signal
 * @param {string} [message]
 * @returns {Promise<T>}
 */
export function raceAbort(promise, signal, message = "operation aborted") {
  const settlement = Promise.resolve(promise);
  if (!signal) return settlement;
  if (signal.aborted) {
    settlement.catch(() => {});
    return new Promise((_, reject) => {
      try { throwIfAborted(signal, message); } catch (error) { error.settlement = settlement; reject(error); }
    });
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      settlement.catch(() => {});
      try { throwIfAborted(signal, message); } catch (error) { error.settlement = settlement; reject(error); }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    settlement.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
