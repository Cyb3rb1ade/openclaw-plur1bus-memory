/**
 * engine/events.js
 *
 * The single path engine code uses to tell the host something happened
 * (types/engine.d.ts HostServices.events). Absent events are a no-op; a
 * throwing listener is the host's bug and must never break a turn, so it is
 * logged at debug and swallowed.
 */

/**
 * @param {{events?: {emit?: (name: string, payload: unknown) => void}, logger: {debug: (m: string) => void}}} host HostServices.
 * @param {string} name Event name.
 * @param {object} payload Event payload.
 * @returns {void}
 */
export function emitEngineEvent(host, name, payload) {
  const emit = host?.events?.emit;
  if (typeof emit !== "function") return;
  try {
    emit.call(host.events, name, payload);
  } catch (error) {
    host.logger.debug(`engine event ${name}: listener failed: ${String(error?.message || error)}`);
  }
}
