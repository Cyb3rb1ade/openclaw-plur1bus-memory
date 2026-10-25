// Copied installed OpenClaw 2026.10.4 caller fragment; host dependencies supplied by fixture.
export async function call(params, context, execParams, hookRunner) {
 const filterPluginExecEnv = value => value;
 const host = "gateway";
		const sessionId = context?.hookContext?.sessionId ?? params.defaults?.sessionId;
		const pluginEnv = filterPluginExecEnv(await hookRunner.runResolveExecEnv({
			sessionKey: context?.hookContext?.sessionKey ?? params.defaults?.sessionKey,
			toolName: "exec",
			host
		}, {
			agentId: context?.hookContext?.agentId ?? params.agentId,
			sessionKey: context?.hookContext?.sessionKey ?? params.defaults?.sessionKey,
			...sessionId ? { sessionId } : {},
			messageProvider: params.defaults?.messageProvider,
			channelId: params.defaults?.currentChannelId ?? context?.hookContext?.channelId,
			...params.defaults?.channelContext ? { channelContext: params.defaults.channelContext } : {}
		}));
 return pluginEnv;
}
