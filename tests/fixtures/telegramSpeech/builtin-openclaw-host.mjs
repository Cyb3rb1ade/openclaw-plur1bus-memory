// Verbatim installed OpenClaw 2026.10.4 native producer prefixes (builtin-openclaw-D3tz5Ca2.mjs).
// Fixture returns immediately after each relevant boundary; unrelated later host work is excluded.
async function prepareEmbeddedAttemptPromptAssembly(input) {
	const { attempt } = input;
	const readConfig = createRuntimeConfigReader(attempt.config ?? getRuntimeConfig());
	const attemptAbortSignal = attempt.abortSignal;
	const runAbortSignal = input.runAbortSignal;
	const activeAbortSignal = attemptAbortSignal && runAbortSignal ? AbortSignal.any([attemptAbortSignal, runAbortSignal]) : attemptAbortSignal ?? runAbortSignal;
	activeAbortSignal?.throwIfAborted();
	const isSettledTurnFinalization = attempt.operation === "settled-tool-finalization";
	const preserveExactPrompt = input.isRawModelRun || isSettledTurnFinalization;
	let systemPromptText = input.systemPromptText;
	const setSystemPrompt = (next) => {
		systemPromptText = next;
		input.setActiveSessionSystemPrompt(next);
	};
	let effectivePrompt = preserveExactPrompt ? attempt.prompt : resolveInternalEventPromptBody(attempt.prompt, attempt.internalEvents, attempt.inputProvenance);
	const originContext = !preserveExactPrompt && attempt.inputProvenance?.kind === "inter_session" ? buildInterSessionPromptContext(attempt.inputProvenance) : void 0;
	if (originContext && (effectivePrompt === originContext.text || effectivePrompt.startsWith(`${originContext.text}\n`))) effectivePrompt = effectivePrompt.slice(originContext.text.length).replace(/^\n/, "");
	const hookCtx = {
		...buildEmbeddedAgentHookContext(attempt, input.hookAgentId, freezeDiagnosticTraceContext(input.diagnosticTrace)),
		activeProjectKeys: [...attempt.preparedModelRuntime?.activeProjectKeys ?? []],
		modelProviderId: attempt.model.provider,
		modelId: attempt.model.id,
		inputProvenance: attempt.inputProvenance
	};
	const promptBuildMessages = pruneProcessedHistoryImages(input.activeSession.messages) ?? input.activeSession.messages;
	const promptEvent = {
		prompt: effectivePrompt,
		messages: promptBuildMessages
	};
	const hookResult = preserveExactPrompt ? void 0 : await resolvePromptBuildHookResult({
		config: attempt.config ?? getRuntimeConfig(),
		prompt: effectivePrompt,
		messages: promptBuildMessages,
		hookCtx,
		hookRunner: input.hookRunner
	});
	return hookResult;
}
async function runEmbeddedAttemptPromptPhase(input, promptState) {
	const { attempt, activeContextEngine, isRawModelRun, prepared, preparedStreamRuntime, runAbortController } = input;
	const { sessionRuntime, promptToolPolicy } = prepared;
	const { agentSession: { activeSession, hookRunner, setActiveSessionSystemPrompt, settingsManager }, boundary: { boundaryTimezone, includeBoundaryTimestamp, orphanRepair, setCurrentUserTimestampOverride }, cacheTrace, contextGuards, preparedUserTurnMessage, sessionManager, sessionPromptState, state: sessionRuntimeState, toolResultPromptProjectionState, trajectoryRecorder, transcriptPolicy: { appendOnlyRuntimeContext, inHistorySystemUpdates }, transport: { effectiveAgentTransport, effectiveExtraParams, streamStrategy, compactionReplayEnabled } } = sessionRuntime;
	const { effectiveFsWorkspaceOnly, effectiveWorkspace, sandbox, sessionAgentId } = input.setup;
	const { history: { contextEngineAssemblySucceeded, contextEnginePromptAuthority, unwindowedContextEngineMessagesForPrecheck }, promptActiveSession, stream: { stopAcceptingSteerMessages } } = preparedStreamRuntime;
	const { withOwnedTranscriptWrite } = input.sessionLock;
	const { diagnosticTrace, runTrace } = input.diagnostics;
	const { systemPromptReport, runtimeInfo } = prepared.systemPrompt;
	let systemPromptText = sessionRuntimeState.systemPromptText;
	const toolSearchCompacted = prepared.toolCatalog.toolSearch.compacted;
	let skipPromptSubmission = false;
	let leasedSteering;
	const setFailure = (error, source) => {
		input.state.terminal = setAgentRunAttemptTerminalFailure(input.state.terminal, error !== null && error !== void 0 ? {
			error,
			source: source ?? "prompt"
		} : null);
	};
	const publishDispatchState = (state) => {
		skipPromptSubmission = state.skipPromptSubmission;
		promptState.contextBudgetStatus = state.contextBudgetStatus;
		promptState.preflightRecovery = state.preflightRecovery;
		setFailure(state.promptError, state.promptErrorSource);
	};
	const releaseLeasedSteering = async (error) => {
		if (!leasedSteering) return;
		await releasePendingAgentSteeringItems({
			runIds: leasedSteering.runIds,
			leaseId: leasedSteering.leaseId,
			error: error ? formatErrorMessage(error) : void 0
		});
		leasedSteering = void 0;
	};
	const handleMidTurnPrecheckRequest = async (request) => {
		const outcome = await handleEmbeddedAttemptMidTurnPrecheck({
			attempt,
			request,
			sessionAgentId,
			sessionManager,
			toolResultPromptProjectionState,
			prePromptMessageCount: sessionRuntimeState.prePromptMessageCount,
			replaceSessionMessages: (messages) => {
				activeSession.agent.state.messages = messages;
			}
		});
		promptState.preflightRecovery = outcome.preflightRecovery;
		if (outcome.promptError) setFailure(outcome.promptError, "precheck");
	};
	const promptStartedAt = Date.now();
	let transcriptLeafId = null;
	try {
		const promptAssembly = await prepareEmbeddedAttemptPromptAssembly({
			attempt,
			activeSession,
			sessionManager,
			hookRunner,
			hookAgentId: sessionAgentId,
			diagnosticTrace,
			isRawModelRun,
			...orphanRepair ? { orphanRepair } : {},
			sessionAgentId,
			runtimeModel: runtimeInfo.model,
			systemPromptText,
			runAbortSignal: input.runAbortController.signal,
			setActiveSessionSystemPrompt,
			applyPromptBuildToolsAllow: (toolsAllow, decisionIsCurrent) => {
				return promptToolPolicy.apply(toolsAllow, decisionIsCurrent).callableToolNames;
			},
			prepareSystemPrompt: async (currentSystemPrompt) => {
				const refresh = await prepared.systemPrompt.prepareToolPrompt?.(promptToolPolicy.current.effectiveTools);
				return refresh ? refresh(currentSystemPrompt) : currentSystemPrompt;
			},
			setLeasedSteering: (lease) => {
				leasedSteering = lease;
			}
		});
		return promptAssembly;
	} catch (error) { throw error; }
}

// Verbatim admitted transcript resolution from the installed session preparation.
async function resolveFixturePreparedUserTurnMessage(attempt) {
	const preparedUserTurnMessage = attempt.skipPreparedUserTurnMessage ? void 0 : await attempt.userTurnTranscriptRecorder?.resolveMessage();
	return preparedUserTurnMessage;
}
