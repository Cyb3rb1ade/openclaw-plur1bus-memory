/**
 * adapter/openclaw/register-maintenance-hook.js
 *
 * Registers the auto-recall-off before_prompt_build branch. The OpenClaw hook
 * default of 15 000 ms applies (no timeoutMs was declared here before and none
 * is declared now — host-contract §a.1). The handler joins the engine's
 * RecallResult blocks through join-recall.js before handing OpenClaw its
 * `{ prependContext }` shape.
 */

import { createMinimalMaintenance } from "../../engine/recall/minimal-maintenance.js";
import { prependContextFromRecall } from "./join-recall.js";

/**
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @param {object} ctx.api OpenClaw plugin API (`api.on`).
 * @returns {void}
 */
export function registerMaintenanceHook(ctx) {
  const maintain = createMinimalMaintenance(ctx);
  ctx.api.on("before_prompt_build", async (event, hookCtx) => prependContextFromRecall(await maintain(event, hookCtx)));
}
