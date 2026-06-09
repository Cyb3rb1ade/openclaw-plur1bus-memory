/**
 * EmotionalMemoryBus — lightweight pub/sub event bus for emotion-related
 * memory lifecycle events.
 */

const VALID_EVENTS = new Set([
  "engram_created",
  "engram_accessed",
  "engram_decaying",
  "session_ended",
  "mood_shift",
]);

export class EmotionalMemoryBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._subscribers = new Map();
    for (const ev of VALID_EVENTS) {
      this._subscribers.set(ev, new Set());
    }
  }

  /**
   * Subscribe a callback to an event.
   *
   * @param {string} event — one of the VALID_EVENTS
   * @param {Function} callback
   */
  subscribe(event, callback) {
    if (!VALID_EVENTS.has(event)) {
      throw new Error(`Unknown event type: ${event}`);
    }
    if (typeof callback !== "function") {
      throw new TypeError("Callback must be a function");
    }
    this._subscribers.get(event).add(callback);
  }

  /**
   * Publish data to all subscribers of an event.
   * Errors in individual callbacks are caught and logged, not propagated.
   *
   * @param {string} event
   * @param {*} data
   */
  publish(event, data) {
    if (!VALID_EVENTS.has(event)) {
      throw new Error(`Unknown event type: ${event}`);
    }
    const listeners = this._subscribers.get(event);
    for (const cb of listeners) {
      try {
        cb(data);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[EmotionalMemoryBus] Subscriber error on ${event}:`, err?.message ?? err);
      }
    }
  }
}

/** Singleton instance exported for shared use. */
export const emotionBus = new EmotionalMemoryBus();
