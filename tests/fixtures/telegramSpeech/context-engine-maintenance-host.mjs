// Verbatim installed OpenClaw 2026.10.4 helper (context-engine-maintenance-CLQ35L-o.mjs).
const PROMPT_BUILD_DRAIN_CACHE_MAX = 256;
const promptBuildDrainCache = /* @__PURE__ */ new Map();
function rememberDrainedInjections(runId, injections) {
	if (promptBuildDrainCache.has(runId)) promptBuildDrainCache.delete(runId);
	else if (promptBuildDrainCache.size >= PROMPT_BUILD_DRAIN_CACHE_MAX) pruneMapToMaxSize(promptBuildDrainCache, 255);
	promptBuildDrainCache.set(runId, injections);
}
/** Release at run termination so active retries retain cache headroom. */
function forgetPromptBuildDrainCacheForRun(runId) {
	if (runId) promptBuildDrainCache.delete(runId);
}
async function resolvePromptBuildHookResult(params) {
	const runId = params.hookCtx.runId;
	const cachedInjections = runId ? promptBuildDrainCache.get(runId) : void 0;
	const queuedContext = cachedInjections ? {
		queuedInjections: cachedInjections,
		...buildPluginAgentTurnPrepareContext({ queuedInjections: cachedInjections })
	} : await drainPluginNextTurnInjectionContext({
		cfg: params.config,
		sessionKey: params.hookCtx.sessionKey,
		agentId: params.hookCtx.agentId
	});
	if (runId && !cachedInjections) rememberDrainedInjections(runId, queuedContext.queuedInjections);
	const turnPrepareResult = params.hookRunner?.runAgentTurnPrepare && params.hookRunner.hasHooks("agent_turn_prepare") ? await params.hookRunner.runAgentTurnPrepare({
		prompt: params.prompt,
		messages: params.messages,
		queuedInjections: queuedContext.queuedInjections
	}, params.hookCtx).catch((hookErr) => {
		log.warn(`agent_turn_prepare hook failed: ${String(hookErr)}`);
	}) : void 0;
	const heartbeatContribution = params.hookCtx.trigger === "heartbeat" && params.hookRunner?.runHeartbeatPromptContribution && params.hookRunner.hasHooks("heartbeat_prompt_contribution") ? await params.hookRunner.runHeartbeatPromptContribution({
		sessionKey: params.hookCtx.sessionKey,
		agentId: params.hookCtx.agentId,
		heartbeatName: "heartbeat"
	}, params.hookCtx).catch((hookErr) => {
		log.warn(`heartbeat_prompt_contribution hook failed: ${String(hookErr)}`);
	}) : void 0;
	const promptBuildResult = params.hookRunner?.hasHooks("before_prompt_build") ? await params.hookRunner.runBeforePromptBuild({
		prompt: params.prompt,
		messages: params.messages
	}, params.hookCtx).catch((hookErr) => {
		log.warn(`before_prompt_build hook failed: ${String(hookErr)}`);
	}) : void 0;
	const decisionPromptBuildFields = promptBuildResult ? Object.fromEntries([
		"systemPrompt",
		"prependContext",
		"appendContext",
		"prependSystemContext",
		"appendSystemContext"
	].flatMap((field) => typeof promptBuildResult[field] === "string" ? [[field, promptBuildResult[field]]] : [])) : void 0;
	return {
		hasPendingNonPromptBuildContext: Boolean(queuedContext.prependContext?.trim() || queuedContext.appendContext?.trim() || turnPrepareResult?.prependContext?.trim() || turnPrepareResult?.appendContext?.trim() || heartbeatContribution?.prependContext?.trim() || heartbeatContribution?.appendContext?.trim()),
		...decisionPromptBuildFields && Object.keys(decisionPromptBuildFields).length > 0 ? { decisionPromptBuildFields } : {},
		systemPrompt: promptBuildResult?.systemPrompt,
		...promptBuildResult?.toolsAllow !== void 0 ? { toolsAllow: promptBuildResult.toolsAllow } : {},
		prependContext: joinPresentTextSegments([
			queuedContext.prependContext,
			turnPrepareResult?.prependContext,
			heartbeatContribution?.prependContext,
			promptBuildResult?.prependContext
		]),
		appendContext: joinPresentTextSegments([
			queuedContext.appendContext,
			turnPrepareResult?.appendContext,
			heartbeatContribution?.appendContext,
			promptBuildResult?.appendContext
		]),
		prependSystemContext: wrapPluginSystemContextSection(promptBuildResult?.prependSystemContext),
		appendSystemContext: wrapPluginSystemContextSection(promptBuildResult?.appendSystemContext)
	};
}
