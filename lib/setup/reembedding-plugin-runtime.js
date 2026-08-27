/** Native OpenClaw operator surfaces for the copy-on-write re-embedding workflow. */

import { stdin, stdout } from "node:process";

import { validateInput } from "../input-limits.js";
import { redactError, safeWarn } from "../safe-logging.js";
import { loadOpenClawGatewayRuntime } from "./feature-cron-plugin-runtime.js";

export const REEMBEDDING_GATEWAY_METHODS = Object.freeze({
  status: "plur1bus.reembedding.status",
  plan: "plur1bus.reembedding.plan",
  apply: "plur1bus.reembedding.apply",
  resume: "plur1bus.reembedding.resume",
  switch: "plur1bus.reembedding.switch",
  rollback: "plur1bus.reembedding.rollback",
});
export const REEMBEDDING_SESSION_ACTION = "reembedding.operation";
export const REEMBEDDING_CLI_COMMAND = "plur1bus-reembedding";

const OPERATION_NAMES = new Set(Object.keys(REEMBEDDING_GATEWAY_METHODS));
const SECRET_FIELD_RE = /^(?:apiKey|token|password|secret|credential|resolvedSecret)$/i;
const MAX_PLAN_STDIN_BYTES = 64 * 1024;

function exactObject(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid PLUR1BUS reembedding request (${label})`);
  }
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`invalid PLUR1BUS reembedding request fields (${label})`);
  }
  return value;
}

function boundedId(value, label = "id") {
  const result = validateInput(value, {
    maxLength: 128,
    name: `reembedding ${label}`,
    required: true,
    allowedPattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  });
  if (!result.ok) throw new Error(`invalid PLUR1BUS ${result.error}`);
  return result.value;
}

function rejectCredentialMaterial(value, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("invalid cyclic PLUR1BUS reembedding request");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD_RE.test(key)) throw new Error("credential material is not accepted by PLUR1BUS reembedding requests");
    rejectCredentialMaterial(child, seen);
  }
  seen.delete(value);
}

function validateStatus(params) {
  exactObject(params, ["id"], [], "status");
  return Object.freeze({ id: boundedId(params.id) });
}

function validatePlan(params) {
  exactObject(params, ["id", "target"], ["targetGeneration", "confirmationTtlMs"], "plan");
  rejectCredentialMaterial(params);
  return structuredClone(params);
}

function validateConfirmed(params, label) {
  exactObject(params, ["id", "token"], [], label);
  const token = validateInput(params.token, { maxLength: 512, name: "reembedding confirmation token", required: true });
  if (!token.ok) throw new Error("invalid PLUR1BUS reembedding confirmation token");
  return Object.freeze({ id: boundedId(params.id), token: token.value });
}

function validateRollback(params) {
  exactObject(params, ["completedId", "newMigrationId"], [], "rollback");
  return Object.freeze({
    completedId: boundedId(params.completedId, "completed id"),
    newMigrationId: boundedId(params.newMigrationId, "new migration id"),
  });
}

async function applyAndValidate(coordinator, operation, params) {
  const migration = await coordinator[operation](params);
  return migration?.state === "validating"
    ? coordinator.validate({ id: params.id })
    : migration;
}

function responder(handler, logger) {
  return async (request) => {
    try {
      request.respond(true, await handler(request.params));
    } catch (error) {
      safeWarn(logger, "reembedding-operator", error);
      request.respond(false, undefined, {
        code: "plur1bus_reembedding_error",
        message: redactError(error).message,
      });
    }
  };
}

/** Create the closed re-embedding Gateway handler set without registering it. */
export function createReembeddingGatewayHandlers({ coordinator, switchRuntime, logger } = {}) {
  for (const name of ["status", "plan", "apply", "resume", "validate"]) {
    if (typeof coordinator?.[name] !== "function") throw new Error(`reembedding coordinator ${name} capability is required`);
  }
  if (typeof switchRuntime?.switchGeneration !== "function" || typeof switchRuntime?.planManualRollback !== "function") {
    throw new Error("reembedding switch runtime is required");
  }
  return Object.freeze({
    status: responder(async (params) => ({ migration: await coordinator.status(validateStatus(params).id) }), logger),
    plan: responder(async (params) => ({ migration: await coordinator.plan(validatePlan(params)) }), logger),
    apply: responder(async (params) => ({ migration: await applyAndValidate(coordinator, "apply", validateConfirmed(params, "apply")) }), logger),
    resume: responder(async (params) => ({ migration: await applyAndValidate(coordinator, "resume", validateConfirmed(params, "resume")) }), logger),
    switch: responder(async (params) => ({ migration: await switchRuntime.switchGeneration(validateConfirmed(params, "switch")) }), logger),
    rollback: responder(async (params) => {
      const reverse = await switchRuntime.planManualRollback(validateRollback(params));
      return { migration: await coordinator.plan(reverse) };
    }, logger),
  });
}

/** Read one confirmation token without placing it in argv or echoing terminal input. */
export async function readHiddenConfirmationToken({ input = stdin, output = stdout } = {}) {
  if (!input?.isTTY) {
    let value = "";
    for await (const chunk of input) value += String(chunk);
    const token = value.trim();
    if (!token) throw new Error("reembedding confirmation token is required on stdin");
    return token;
  }
  if (typeof input.setRawMode !== "function") throw new Error("hidden confirmation input is unavailable");
  output.write("Confirmation token: ");
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      const text = String(chunk);
      if (text === "\u0003") return finish(new Error("confirmation input cancelled"));
      if (text.includes("\r") || text.includes("\n")) return finish(value ? null : new Error("confirmation token is required"));
      if (text === "\u007f") value = value.slice(0, -1);
      else if (value.length + text.length <= 512) value += text;
    };
    input.on("data", onData);
  });
}

/** Read one bounded JSON plan request from stdin without using process arguments. */
export async function readJsonPlanRequest({ input = stdin } = {}) {
  let document = "";
  let bytes = 0;
  for await (const chunk of input) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_PLAN_STDIN_BYTES) throw new Error("reembedding plan JSON exceeds the stdin size limit");
    document += text;
  }
  if (!document.trim()) throw new Error("reembedding plan JSON is required on stdin");
  try {
    const parsed = JSON.parse(document);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("plan document must be an object");
    return parsed;
  } catch (cause) {
    const error = new Error("reembedding plan stdin must contain one valid JSON object");
    error.cause = cause;
    throw error;
  }
}

/** Execute one thin CLI operation through exactly one Gateway request. */
export async function executeReembeddingCli({
  operation,
  id,
  newMigrationId,
  planRequest,
  callGateway,
  readConfirmationToken = readHiddenConfirmationToken,
  write = (chunk) => stdout.write(chunk),
} = {}) {
  if (!OPERATION_NAMES.has(operation)) throw new Error("unknown PLUR1BUS reembedding operation");
  if (typeof callGateway !== "function") throw new Error("Gateway RPC capability unavailable");
  let params;
  if (operation === "plan") params = validatePlan(planRequest);
  else if (operation === "rollback") params = validateRollback({ completedId: id, newMigrationId });
  else if (operation === "status") params = validateStatus({ id });
  else params = validateConfirmed({ id, token: await readConfirmationToken() }, operation);
  const response = await callGateway(
    REEMBEDDING_GATEWAY_METHODS[operation],
    { timeout: "600000", json: true },
    params,
    { progress: false, scopes: [operation === "status" ? "operator.read" : "operator.admin"] },
  );
  write(`${JSON.stringify(response, null, 2)}\n`);
  return response;
}

/** Register Beta-3 RPC, typed-action, and CLI re-embedding surfaces exactly once. */
export function registerReembeddingRuntime({
  api,
  coordinator,
  switchRuntime,
  loadGatewayRuntime = loadOpenClawGatewayRuntime,
  readConfirmationToken = readHiddenConfirmationToken,
  readPlanRequest = readJsonPlanRequest,
  write,
} = {}) {
  if (typeof api?.registerGatewayMethod !== "function" || typeof api?.registerCli !== "function") {
    throw new Error("OpenClaw Gateway and CLI capabilities are required for reembedding");
  }
  const handlers = createReembeddingGatewayHandlers({ coordinator, switchRuntime, logger: api.logger });
  for (const [operation, method] of Object.entries(REEMBEDDING_GATEWAY_METHODS)) {
    api.registerGatewayMethod(method, handlers[operation], {
      scope: operation === "status" ? "operator.read" : "operator.admin",
    });
  }
  const registerSessionAction = api.session?.controls?.registerSessionAction;
  if (typeof registerSessionAction === "function") {
    registerSessionAction({
      id: REEMBEDDING_SESSION_ACTION,
      description: "Run a confirmed PLUR1BUS re-embedding control operation",
      requiredScopes: ["operator.admin"],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["operation", "request"],
        properties: {
          operation: { type: "string", enum: [...OPERATION_NAMES].filter((value) => value !== "status") },
          request: { type: "object" },
        },
      },
      handler: async ({ payload }) => {
        try {
          exactObject(payload, ["operation", "request"], [], "session action");
          if (!OPERATION_NAMES.has(payload.operation) || payload.operation === "status") throw new Error("invalid reembedding action operation");
          let result;
          await handlers[payload.operation]({ params: payload.request, respond: (ok, value, error) => { result = ok ? { result: value } : { ok: false, error: error.message, code: error.code }; } });
          return result;
        } catch (error) {
          return { ok: false, code: "plur1bus_reembedding_error", error: redactError(error).message };
        }
      },
    });
  }
  api.registerCli(({ program }) => {
    program.command(REEMBEDDING_CLI_COMMAND)
      .description("Run the PLUR1BUS copy-on-write re-embedding workflow")
      .argument("<operation>", "status, plan, apply, resume, switch, or rollback")
      .option("--id <id>", "migration id")
      .option("--new-id <id>", "new reverse migration id")
      .action(async (operation, options) => {
        const gatewayRuntime = await loadGatewayRuntime();
        const planRequest = operation === "plan"
          ? await readPlanRequest?.()
          : undefined;
        await executeReembeddingCli({
          operation,
          id: options.id,
          newMigrationId: options.newId,
          planRequest,
          callGateway: gatewayRuntime.callGatewayFromCli,
          readConfirmationToken,
          ...(write ? { write } : {}),
        });
      });
  }, {
    descriptors: [{
      name: REEMBEDDING_CLI_COMMAND,
      description: "Run the PLUR1BUS copy-on-write re-embedding workflow",
      hasSubcommands: false,
      machineOutput: () => true,
    }],
  });
  return handlers;
}
