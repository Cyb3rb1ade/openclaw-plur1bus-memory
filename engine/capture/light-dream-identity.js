/**
 * engine/capture/light-dream-identity.js — the binding a light dream writes
 * its insights under (moved out of capture-turn.js in 7.21.1 so the inline
 * and the deferred post-turn path share it).
 *
 * 7.21.1 (acl.user.missing_principal): on the adapter path the hook context
 * was re-resolved with the turn's `senderId` taken at face value, so every
 * dream of a chat with a sender id was bound to that user (scope "user").
 * The recall only grants user scope to a principal it has proved (turn-route
 * ticket); for threaded Telegram DMs and group chats it usually has none
 * ("authenticated=no"), and the dreams were denied with
 * acl.user.missing_principal. Now a light dream is bound to a user only when
 * that user was proved for the same turn (`provedUserPrincipal`, recorded by
 * the recall's turn-principal resolver) or comes from a caller-resolved
 * memory context (Engine.capture); otherwise it is bound to the agent's
 * workspace like a dream without a sender. The stored rows are not changed.
 */

/**
 * @param {object|null|undefined} memoryCtx Caller-resolved memory context (Engine path) or nothing.
 * @param {() => object} resolveFallback Re-resolves the hook context (adapter path).
 * @param {{provedUserPrincipal?: string}} [opts] The user principal the recall
 *   proved for this turn, if any.
 * @returns {{requestContext: object|null, aclBindings: object|null}}
 */
export function lightDreamIdentity(memoryCtx, resolveFallback, { provedUserPrincipal = "" } = {}) {
  let requestContext = memoryCtx ?? null;
  if (!requestContext) {
    try {
      requestContext = resolveFallback();
    } catch (_) {
      requestContext = null;
    }
    // Unproved sender ids do not make a user binding.
    const proved = typeof provedUserPrincipal === "string" ? provedUserPrincipal : "";
    if (requestContext?.userPrincipal && requestContext.userPrincipal !== proved) {
      requestContext = Object.freeze({ ...requestContext, userPrincipal: "" });
    }
  }
  const aclBindings = requestContext
    ? (requestContext.userPrincipal
      ? { scope: "user", agentId: requestContext.agentId, workspaceIdentity: "", ownerUserId: requestContext.userPrincipal }
      : { scope: "workspace", agentId: requestContext.agentId, workspaceIdentity: requestContext.workspaceIdentity, ownerUserId: "" })
    : null;
  return { requestContext, aclBindings };
}
