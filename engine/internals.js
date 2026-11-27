/**
 * engine/internals.js — the adapter's transitional window into EngineInternals.
 *
 * The OpenClaw adapter still registers M1a's context-object handlers, which
 * are views over the engine's internals. That is the only legitimate reader;
 * the harness uses the public Engine surface. Removed with PR-14.
 */

/** The non-enumerable Engine property that holds EngineInternals. */
export const ENGINE_INTERNALS = Symbol.for("plur1bus.engine.internals");

/**
 * The EngineInternals behind an Engine. Adapter-only (see the module comment).
 *
 * @param {object} engine An Engine from createEngine().
 * @returns {object} EngineInternals.
 */
export function internalsOf(engine) {
  const internals = engine?.[ENGINE_INTERNALS];
  if (!internals) throw new TypeError("not a PLUR1BUS engine");
  return internals;
}
