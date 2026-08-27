/** Common policy boundary for PLUR1BUS workspace operations. */

function identityFromContext(memoryCtx) {
  if (!memoryCtx?.agentId || !memoryCtx?.workspaceIdentity) {
    const error = new Error("canonical workspace identity is required");
    error.code = "workspace_identity_required";
    throw error;
  }
  return Object.freeze({
    agentId: memoryCtx.agentId,
    workspaceIdentity: memoryCtx.workspaceIdentity,
  });
}

/**
 * Return the stable explicit-operation result for a disabled workspace.
 * @param {object} policy Redacted workspace policy.
 * @returns {object} Structured disabled result.
 */
export function workspaceDisabledResult(policy) {
  return Object.freeze({ ok: false, code: "workspace_disabled", retryable: false, policy });
}

/**
 * Create the shared policy guard for explicit and automatic memory paths.
 * @param {{store: object, invalidate?: Function}} options Guard dependencies.
 * @returns {{decision: Function, requireEnabled: Function, automatic: Function, set: Function}} Guard.
 */
export function createWorkspacePolicyGuard({ store, invalidate = async () => {} } = {}) {
  if (!store || typeof store.get !== "function" || typeof store.set !== "function") {
    throw new Error("workspace policy store is required");
  }
  if (typeof invalidate !== "function") throw new Error("workspace policy invalidate must be a function");

  const decision = (memoryCtx) => {
    const identity = identityFromContext(memoryCtx);
    const policy = store.get(identity);
    return Object.freeze({ allowed: policy.enabled, policy });
  };

  const requireEnabled = (memoryCtx) => {
    const result = decision(memoryCtx);
    if (result.allowed) return result.policy;
    const error = new Error("PLUR1BUS is disabled for this workspace");
    error.code = "workspace_disabled";
    error.policy = result.policy;
    throw error;
  };

  const automatic = (memoryCtx) => {
    try {
      return decision(memoryCtx).allowed
        ? Object.freeze({ allowed: true })
        : Object.freeze({ allowed: false, reason: "workspace_disabled" });
    } catch (error) {
      return Object.freeze({ allowed: false, reason: error?.code || "workspace_policy_unavailable" });
    }
  };

  const set = async ({ memoryCtx, enabled, expectedRevision, actorId }) => {
    const identity = identityFromContext(memoryCtx);
    const policy = await store.set({ ...identity, enabled, expectedRevision, actorId });
    await invalidate(identity);
    return policy;
  };

  return Object.freeze({ decision, requireEnabled, automatic, set });
}
