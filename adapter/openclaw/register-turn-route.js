/**
 * adapter/openclaw/register-turn-route.js
 *
 * OpenClaw-only: the `reply_dispatch` observer that mints the turn-route
 * ticket the six-step identity chain later claims
 * (lib/memory-request-context.js:1377-1393), and the `agent_end` cleanup that
 * drops the run. The harness supplies a proved principal instead and registers
 * neither (engine-extraction.md §a.1).
 */

/**
 * @param {{api: object, host: object, autoRecall: boolean,
 *          getMemoryTurnRoutes: () => Promise<object|null>,
 *          turnRouteState: {initPromise?: Promise<object|null>}}} ctx Registration context.
 * @returns {void}
 */
export function registerTurnRouteHooks(ctx) {
  const { api, host, autoRecall, getMemoryTurnRoutes, turnRouteState } = ctx;

  // 7.12.35: Registrierung und jeden Aufruf sichtbar machen — auf 7.12.34
  // erschien fuer Bernds Turns (10.09.2026 14:27–15:04) keine einzige
  // Handler-Zeile, `pending=0`; statisch war im Host kein Gate zu finden.
  let replyDispatchInvocations = 0;
  const replyDispatchRegistration = api.on("reply_dispatch", async (event, hookCtx) => {
    replyDispatchInvocations += 1;
    host.logger.info(`memory-turn-routes: reply_dispatch handler invoked #${replyDispatchInvocations} dispatchKind=${String(hookCtx?.dispatchKind || "")} hasCtx=${Boolean(event?.ctx)} sessionKey=${String(event?.sessionKey || event?.ctx?.SessionKey || "").slice(0, 96)}`);
    const turnRoutes = await getMemoryTurnRoutes();
    turnRoutes?.observeReplyDispatch(event);
    // 7.12.33: Ausgang der Beobachtung (Debug); die Fallback-Warnung des
    // Prompt-Hooks traegt denselben Grund als `ticket=`.
    try {
      const sessionKey = event?.sessionKey || event?.ctx?.SessionKey || "";
      const observed = turnRoutes?.lastObserve?.(sessionKey) || "none";
      const line = `memory-turn-routes: dispatch observe:${observed} session=${String(sessionKey).slice(0, 96)} runId=${String(event?.runId || event?.ctx?.RunId || "").slice(0, 40)} eventKeys=${Object.keys(event || {}).filter((k) => k !== "ctx").slice(0, 24).join(",")} ctxKeys=${Object.keys(event?.ctx || {}).filter((k) => /^(CommandTurn|CommandSource|CommandBody|Body|BodyForAgent|RawBody|SenderId|ChatId|Provider|Surface|AccountId|OriginatingTo|OriginatingChannel|OriginatingAccountId|SessionKey|RunId|isTailDispatch|MessageThreadId)$/.test(k)).join(",")}`;
      // 7.12.34: Nicht-Kommando-Ausstiege sichtbar machen (Info), Rest Debug.
      if (/^(registered|slash_command|command_turn:|command_source|is_command|tail_dispatch)/.test(observed)) host.logger.debug(line);
      else host.logger.info(line);
    } catch (_) { /* best-effort */ }
    return undefined;
  }, { priority: Number.MIN_SAFE_INTEGER, eligibleDispatchKinds: ["agent", "acp"] });
  host.logger.info(`memory-turn-routes: reply_dispatch hook registered result=${replyDispatchRegistration === undefined ? "undefined" : typeof replyDispatchRegistration} autoRecall=${autoRecall}`);

  api.on("agent_end", async (event, hookCtx) => {
    if (!turnRouteState.initPromise) return;
    const turnRoutes = await turnRouteState.initPromise;
    const runId = hookCtx?.runId ?? event?.runId;
    if (runId !== undefined && runId !== null) turnRoutes?.clearRun(runId);
  });
}
