/**
 * adapter/openclaw/register-voice-mode.js — Persona/Light for Discord voice
 * rooms (7.17.0, switch via /modus since 7.17.1).
 *
 * Host-specific end to end: the mode only applies to OpenClaw's Discord voice
 * turns (messageProvider "discord-voice"), the model override uses OpenClaw's
 * before_model_resolve, and the switch answers on before_dispatch and through a
 * Discord interactive handler. The engine is not involved; the mode file lives
 * under baseDbPath (lib/voice-mode.js).
 *
 * - lightVoicePromptContext: the short voice guidance instead of recall for a
 *   light voice turn; called by register-recall-hook.js and
 *   register-maintenance-hook.js before they ask the engine.
 * - registerVoiceModelOverride: per-run Haiku for light voice turns.
 * - registerVoiceModeSwitch: /modus [light|full|status] and the plurv buttons,
 *   owner only.
 */

import { isLightVoiceTurn, LIGHT_MODEL, LIGHT_VOICE_GUIDANCE, readVoiceMode } from "../../lib/voice-mode.js";
import {
  applyVoiceMode,
  buildVoiceModeMessage,
  isOwnerSender,
  parseVoiceButtonPayload,
  parseVoiceCommand,
  VOICE_BUTTON_NAMESPACE,
} from "../../lib/voice-mode-switch.js";
import { runtimeIfUsable } from "../../lib/runtime-shutdown.js";

/**
 * Build the light-voice check for a before_prompt_build handler. A disabled
 * workspace policy wins: the check answers only for turns the policy allows.
 *
 * @param {object} params
 * @param {string} params.baseDbPath
 * @param {(event: object, hookCtx: object) => {allowed: boolean}} params.automaticWorkspacePolicyDecision
 * @param {boolean} [params.policyNeedsWorkspaceDir] true for the recall hook, which
 *   consulted the policy only when the turn carries a workspaceDir.
 * @returns {(event: object, hookCtx: object) => ({prependContext: string}|null)}
 */
export function createLightVoicePromptContext({ baseDbPath, automaticWorkspacePolicyDecision, policyNeedsWorkspaceDir = false }) {
  return (event, hookCtx) => {
    const policyApplies = !policyNeedsWorkspaceDir || Boolean(hookCtx?.workspaceDir);
    if (policyApplies && !automaticWorkspacePolicyDecision(event, hookCtx).allowed) return null;
    // 7.17.0: Light in Discord-Sprachräumen — kein Recall, keine
    // Zusatzblöcke, nur die kurze Sprach-Anweisung. Capture bleibt.
    return isLightVoiceTurn(hookCtx, baseDbPath) ? { prependContext: LIGHT_VOICE_GUIDANCE } : null;
  };
}

/**
 * 7.17.0: Light-Sprachzüge laufen pro Lauf auf Haiku. Nie per sessions.patch
 * mit model — das schriebe die Agent-Konfiguration um.
 *
 * @param {{ api: object, host: object, baseDbPath: string }} params
 * @returns {void}
 */
export function registerVoiceModelOverride({ api, host, baseDbPath }) {
  if (typeof api.on !== "function") return;
  api.on("before_model_resolve", async (_event, ctx) => {
    try {
      return isLightVoiceTurn(ctx, baseDbPath) ? { ...LIGHT_MODEL } : undefined;
    } catch (error) {
      host.logger.warn(`memory-lancedb-namespaced: voice light model override failed: ${error?.message || error}`);
      return undefined;
    }
  });
}

/**
 * 7.17.0: /modus [light|full|status] in Discord und Knöpfe plurv:<modus>:<agent>.
 * Die Hook-Antwort kann nur Text tragen, deshalb geht die Knopfnachricht selbst
 * über den Discord-Adapter raus.
 *
 * @param {{ api: object, host: object, baseDbPath: string }} params
 * @returns {void}
 */
export function registerVoiceModeSwitch({ api, host, baseDbPath }) {
  if (typeof api.on !== "function") return;
  const patchVoiceSession = (params) => {
    const patch = runtimeIfUsable(api)?.agent?.session?.patchSessionEntry;
    if (typeof patch !== "function") throw new Error("session patch unavailable");
    return patch({ ...params, preserveActivity: true });
  };
  const sendVoiceModeMessage = async ({ agentId, mode, to, accountId }) => {
    const adapter = await api.runtime?.channel?.outbound?.loadAdapter?.("discord");
    if (typeof adapter?.sendPayload !== "function") throw new Error("discord outbound adapter unavailable");
    const message = buildVoiceModeMessage(agentId, mode);
    await adapter.sendPayload({
      cfg: api.config,
      to,
      ...(accountId ? { accountId } : {}),
      text: message.text,
      payload: { text: message.text, interactive: message.interactive },
    });
  };
  const answerVoiceCommand = async (event, context) => {
    const command = parseVoiceCommand(typeof event?.body === "string" ? event.body : event?.content);
    if (!command) return undefined;
    try {
      const channel = String(context?.channelId || event?.channel || "");
      if (channel !== "discord") {
        return { handled: true, text: "Persona/Light gilt nur für Discord-Sprachräume." };
      }
      const senderId = String(context?.senderId ?? event?.senderId ?? "");
      if (!isOwnerSender(senderId, api.config)) {
        return { handled: true, text: "Nur der Besitzer darf den Sprachmodus umschalten." };
      }
      const sessionKey = String(context?.sessionKey || event?.sessionKey || "");
      const agentId = /^agent:([^:]+):/.exec(sessionKey)?.[1] || "main";
      let mode = readVoiceMode(baseDbPath, agentId);
      if (command.action === "light" || command.action === "persona") {
        const out = await applyVoiceMode({ baseDbPath, agentId, mode: command.action, config: api.config, patchSessionEntry: patchVoiceSession, by: `discord:${senderId}` });
        mode = out.mode;
        host.logger.info(`plur1bus voice[${agentId}]: mode=${mode} patched=${out.patched} failed=${out.failed}`);
      }
      const to = String(context?.conversationId || "");
      if (!to) return { handled: true, text: buildVoiceModeMessage(agentId, mode).text };
      await sendVoiceModeMessage({ agentId, mode, to, accountId: context?.accountId });
      return { handled: true };
    } catch (error) {
      host.logger.warn(`memory-lancedb-namespaced: /modus failed: ${error?.message || error}`);
      return { handled: true, text: "Sprachmodus konnte nicht umgeschaltet werden, Details im Log." };
    }
  };
  try {
    api.on("before_dispatch", answerVoiceCommand);
  } catch (error) {
    host.logger.warn(`memory-lancedb-namespaced: could not listen for /modus: ${error?.message || error}`);
  }
  if (typeof api.registerInteractiveHandler !== "function") return;
  try {
    api.registerInteractiveHandler({
      channel: "discord",
      namespace: VOICE_BUTTON_NAMESPACE,
      handler: async (ctx) => {
        const decision = parseVoiceButtonPayload(ctx?.interaction?.payload);
        if (!decision) return { handled: false };
        if (ctx?.auth?.isAuthorizedSender !== true || !isOwnerSender(ctx?.senderId, api.config)) return { handled: true };
        try {
          const out = await applyVoiceMode({ baseDbPath, agentId: decision.agentId, mode: decision.mode, config: api.config, patchSessionEntry: patchVoiceSession, by: `discord:${ctx.senderId}` });
          host.logger.info(`plur1bus voice[${decision.agentId}]: button mode=${out.mode} patched=${out.patched} failed=${out.failed}`);
          await ctx.respond.clearComponents({ text: buildVoiceModeMessage(decision.agentId, out.mode).text });
          if (ctx.conversationId) {
            await sendVoiceModeMessage({ agentId: decision.agentId, mode: out.mode, to: ctx.conversationId, accountId: ctx.accountId });
          }
        } catch (error) {
          host.logger.warn(`memory-lancedb-namespaced: voice button failed: ${error?.message || error}`);
        }
        return { handled: true };
      },
    });
  } catch (error) {
    host.logger.warn(`memory-lancedb-namespaced: could not register voice buttons: ${error?.message || error}`);
  }
}
