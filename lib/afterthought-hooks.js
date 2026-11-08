import { isBackgroundTurn } from "./runtime-scheduler.js";
import { isInternalOutcome } from "./persona-voice.js";
import { safeAgentId } from "./sql-safety.js";
import { validateInput } from "./input-limits.js";
import { safeWarn } from "./safe-logging.js";

function userText(event) {
  if (typeof event?.prompt === "string") return event.prompt;
  const message = [...(Array.isArray(event?.messages) ? event.messages : [])].reverse().find((item) => item?.role === "user");
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n") : "";
}

/**
 * Observe only eligible interactive turns; never store the conversation itself.
 * @param {{api: object, observe: Function, enabled?: boolean, classifyIncognito: Function, isAllowed?: Function, resolveSession?: Function, phases?: string[]}} options
 * @returns {void}
 */
export function registerAfterthoughtActivityHooks({ api, observe, enabled = true, classifyIncognito, isAllowed = () => true, resolveSession = null, phases = ["start", "end"] } = {}) {
  if (!enabled || typeof api?.on !== "function") return;
  const observeTurn = async (phase, event = {}, ctx = {}) => {
    try {
      const sessionKey = ctx.sessionKey ?? event.sessionKey;
      if (!ctx.workspaceDir || !sessionKey || !ctx.agentId || !isAllowed(event, ctx)) return;
      const prompt = userText(event);
      if (isBackgroundTurn(event, ctx) || isInternalOutcome({ ...ctx, ...event, sessionKey, userPrompt: prompt })) return;
      if (phase === "end" && (event.success === false || !prompt)) return;
      if (typeof classifyIncognito !== "function" || await classifyIncognito(sessionKey)) return;
      safeAgentId(ctx.agentId);
      if (!validateInput(sessionKey, { name: "sessionKey", maxLength: 1024, required: true }).ok) return;
      const sessionId = ctx.sessionId ?? event.sessionId ?? (typeof resolveSession === "function" ? (await resolveSession({ agentId: ctx.agentId, sessionKey }))?.sessionId : null);
      if (!sessionId) return;
      observe(ctx.workspaceDir, { sessionKey, sessionId, phase, runId: ctx.runId ?? event.runId });
    } catch (error) {
      safeWarn(api.logger, "afterthought.activity", error);
    }
  };
  if (phases.includes("start")) api.on("before_prompt_build", (event, ctx) => observeTurn("start", event, ctx), { priority: 1000 });
  if (phases.includes("end")) api.on("agent_end", (event, ctx) => observeTurn("end", event, ctx));
}
