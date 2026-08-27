const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MIGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Create the fail-closed gate used for an atomic writer-generation switch. */
export function createMemoryMaintenanceGate({ now = Date.now, externalStatus = null } = {}) {
  if (typeof now !== "function") throw new TypeError("maintenance gate clock must be a function");
  if (externalStatus !== null && typeof externalStatus !== "function") {
    throw new TypeError("maintenance gate external status must be a function");
  }
  let lease = null;

  const validate = ({ reason, migrationId } = {}) => {
    if (typeof reason !== "string" || !REASON_PATTERN.test(reason)) {
      throw new Error("invalid maintenance gate reason");
    }
    if (typeof migrationId !== "string" || !MIGRATION_ID_PATTERN.test(migrationId)) {
      throw new Error("invalid maintenance gate migration id");
    }
    return { reason, migrationId };
  };

  const enter = async (input) => {
    const next = validate(input);
    if (lease) throw new Error("PLUR1BUS maintenance gate is already active");
    lease = Object.freeze({ ...next, since: now() });
  };

  const exit = async (input) => {
    const expected = validate(input);
    if (!lease) throw new Error("PLUR1BUS maintenance gate is not active");
    if (lease.reason !== expected.reason || lease.migrationId !== expected.migrationId) {
      throw new Error("PLUR1BUS maintenance gate lease mismatch");
    }
    lease = null;
  };

  const status = () => {
    if (lease) return Object.freeze({ active: true, reason: lease.reason, since: lease.since });
    if (!externalStatus) return Object.freeze({ active: false });
    const durable = externalStatus();
    if (!durable || durable.active !== true) return Object.freeze({ active: false });
    if (typeof durable.reason !== "string" || !REASON_PATTERN.test(durable.reason)) {
      throw new Error("invalid durable maintenance gate reason");
    }
    if (!Number.isFinite(durable.since)) throw new Error("invalid durable maintenance gate timestamp");
    return Object.freeze({ active: true, reason: durable.reason, since: durable.since });
  };

  return Object.freeze({ enter, exit, status });
}
