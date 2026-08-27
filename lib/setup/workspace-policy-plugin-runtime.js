/** OpenClaw-native RPC, session action, and CLI surfaces for workspace policy. */

import { validatedIdentity } from "../memory-request-context.js";
import { INPUT_LIMITS } from "../input-limits.js";
import { loadOpenClawGatewayRuntime } from "./feature-cron-plugin-runtime.js";

export const WORKSPACE_POLICY_GATEWAY_METHODS = Object.freeze({
  get: "plur1bus.workspacePolicy.get",
  list: "plur1bus.workspacePolicy.list",
  set: "plur1bus.workspacePolicy.set",
});

export const WORKSPACE_POLICY_SESSION_ACTION = "workspace-policy.set";
export const WORKSPACE_POLICY_CLI_COMMAND = "plur1bus-workspace";

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid PLUR1BUS workspace policy request (${label})`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`invalid PLUR1BUS workspace policy request fields (${label})`);
  }
}

function sessionKey(value) {
  return validatedIdentity(value, INPUT_LIMITS.SESSION_KEY, "workspace policy sessionKey", { required: true });
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid PLUR1BUS workspace policy request expectedRevision");
  }
  return value;
}

/** Validate a session-bound workspace-policy read request. */
export function validateWorkspacePolicyGetRequest(params) {
  exactObject(params, ["sessionKey"], "get");
  return Object.freeze({ sessionKey: sessionKey(params.sessionKey) });
}

/** Validate a session-bound workspace-policy mutation request. */
export function validateWorkspacePolicySetRequest(params) {
  exactObject(params, ["sessionKey", "enabled", "expectedRevision"], "set");
  if (typeof params.enabled !== "boolean") {
    throw new Error("invalid PLUR1BUS workspace policy request enabled");
  }
  return Object.freeze({
    sessionKey: sessionKey(params.sessionKey),
    enabled: params.enabled,
    expectedRevision: expectedRevision(params.expectedRevision),
  });
}

function validateListRequest(params) {
  if (params === undefined) return Object.freeze({});
  exactObject(params, [], "list");
  return Object.freeze({});
}

function errorMessage(error) {
  if (error?.code === "workspace_policy_revision_conflict") return error.message;
  if (error?.code === "workspace_identity_required") return "canonical workspace identity is required";
  return error instanceof Error ? error.message : String(error);
}

function respondError(respond, error) {
  respond(false, undefined, {
    code: error?.code || "plur1bus_workspace_policy_error",
    message: errorMessage(error),
    ...(error?.current ? { details: { current: error.current } } : {}),
  });
}

function operatorActorId(request) {
  const connId = request?.client?.connId;
  return typeof connId === "string" && connId.length > 0 ? `operator:${connId}` : "operator:gateway";
}

/** Create the three policy Gateway handlers without registering them. */
export function createWorkspacePolicyGatewayHandlers({ store, guard, resolveSessionMemoryContext } = {}) {
  if (!store || typeof store.list !== "function") throw new Error("workspace policy store is required");
  if (!guard || typeof guard.decision !== "function" || typeof guard.set !== "function") {
    throw new Error("workspace policy guard is required");
  }
  if (typeof resolveSessionMemoryContext !== "function") {
    throw new Error("workspace policy session resolver is required");
  }

  return Object.freeze({
    get: async (request) => {
      try {
        const params = validateWorkspacePolicyGetRequest(request.params);
        const memoryCtx = await resolveSessionMemoryContext(params);
        request.respond(true, { policy: guard.decision(memoryCtx).policy });
      } catch (error) {
        respondError(request.respond, error);
      }
    },
    list: async (request) => {
      try {
        validateListRequest(request.params);
        request.respond(true, { policies: store.list() });
      } catch (error) {
        respondError(request.respond, error);
      }
    },
    set: async (request) => {
      try {
        const params = validateWorkspacePolicySetRequest(request.params);
        const memoryCtx = await resolveSessionMemoryContext({ sessionKey: params.sessionKey });
        const policy = await guard.set({
          memoryCtx,
          enabled: params.enabled,
          expectedRevision: params.expectedRevision,
          actorId: operatorActorId(request),
        });
        request.respond(true, { policy });
      } catch (error) {
        respondError(request.respond, error);
      }
    },
  });
}

function validateSessionActionPayload(payload) {
  exactObject(payload, ["enabled", "expectedRevision"], "session action");
  if (typeof payload.enabled !== "boolean") throw new Error("invalid PLUR1BUS workspace policy request enabled");
  return Object.freeze({ enabled: payload.enabled, expectedRevision: expectedRevision(payload.expectedRevision) });
}

/** Execute one policy CLI operation through exactly one Gateway request. */
export async function executeWorkspacePolicyCli({
  operation,
  sessionKey: rawSessionKey,
  expectedRevision: rawExpectedRevision,
  callGateway,
  write = (chunk) => process.stdout.write(chunk),
} = {}) {
  if (typeof callGateway !== "function") throw new Error("Gateway RPC capability unavailable");
  const normalizedSessionKey = sessionKey(rawSessionKey);
  let method;
  let params;
  if (operation === "status") {
    method = WORKSPACE_POLICY_GATEWAY_METHODS.get;
    params = { sessionKey: normalizedSessionKey };
  } else if (operation === "enable" || operation === "disable") {
    method = WORKSPACE_POLICY_GATEWAY_METHODS.set;
    params = {
      sessionKey: normalizedSessionKey,
      enabled: operation === "enable",
      expectedRevision: expectedRevision(rawExpectedRevision),
    };
  } else {
    throw new Error("workspace policy operation must be status, enable, or disable");
  }
  const response = await callGateway(
    method,
    { timeout: "30000", json: true },
    params,
    { progress: false, scopes: [operation === "status" ? "operator.read" : "operator.write"] },
  );
  write(`${JSON.stringify(response, null, 2)}\n`);
  return response;
}

/** Register workspace-policy surfaces once against public OpenClaw capabilities. */
export function registerWorkspacePolicyRuntime({
  api,
  store,
  guard,
  resolveSessionMemoryContext,
  loadGatewayRuntime = loadOpenClawGatewayRuntime,
  write,
} = {}) {
  if (typeof api?.registerGatewayMethod !== "function") {
    throw new Error("OpenClaw registerGatewayMethod capability unavailable for workspace policy");
  }
  if (typeof api?.registerCli !== "function") {
    throw new Error("OpenClaw registerCli capability unavailable for workspace policy");
  }
  const handlers = createWorkspacePolicyGatewayHandlers({ store, guard, resolveSessionMemoryContext });
  api.registerGatewayMethod(WORKSPACE_POLICY_GATEWAY_METHODS.get, handlers.get, { scope: "operator.read" });
  api.registerGatewayMethod(WORKSPACE_POLICY_GATEWAY_METHODS.list, handlers.list, { scope: "operator.read" });
  api.registerGatewayMethod(WORKSPACE_POLICY_GATEWAY_METHODS.set, handlers.set, { scope: "operator.write" });

  const registerSessionAction = api.session?.controls?.registerSessionAction;
  if (typeof registerSessionAction === "function") {
    registerSessionAction({
      id: WORKSPACE_POLICY_SESSION_ACTION,
      description: "Enable or disable PLUR1BUS for this canonical workspace",
      requiredScopes: ["operator.write"],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["enabled", "expectedRevision"],
        properties: {
          enabled: { type: "boolean" },
          expectedRevision: { type: "integer", minimum: 0 },
        },
      },
      handler: async (ctx) => {
        try {
          if (!ctx.sessionKey) throw new Error("workspace policy session action requires a sessionKey");
          const payload = validateSessionActionPayload(ctx.payload);
          const memoryCtx = await resolveSessionMemoryContext({ sessionKey: ctx.sessionKey, agentId: ctx.agentId });
          const policy = await guard.set({
            memoryCtx,
            enabled: payload.enabled,
            expectedRevision: payload.expectedRevision,
            actorId: operatorActorId({ client: ctx.client }),
          });
          return { result: { policy } };
        } catch (error) {
          return { ok: false, error: errorMessage(error), code: error?.code || "plur1bus_workspace_policy_error" };
        }
      },
    });
  } else {
    api.logger?.warn?.("memory-lancedb-namespaced: typed workspace policy action capability unavailable");
  }

  api.registerCli(
    ({ program }) => {
      program
        .command(WORKSPACE_POLICY_CLI_COMMAND)
        .description("Read or change PLUR1BUS policy for a session workspace")
        .argument("<operation>", "status, enable, or disable")
        .requiredOption("--session <key>", "OpenClaw session key")
        .option("--expected-revision <number>", "required for enable/disable")
        .action(async (operation, options) => {
          const gatewayRuntime = await loadGatewayRuntime();
          await executeWorkspacePolicyCli({
            operation,
            sessionKey: options.session,
            ...(options.expectedRevision !== undefined
              ? { expectedRevision: Number(options.expectedRevision) }
              : {}),
            callGateway: gatewayRuntime.callGatewayFromCli,
            ...(write ? { write } : {}),
          });
        });
    },
    {
      descriptors: [{
        name: WORKSPACE_POLICY_CLI_COMMAND,
        description: "Read or change PLUR1BUS policy for a session workspace",
        hasSubcommands: false,
        machineOutput: () => true,
      }],
    },
  );
  return handlers;
}
