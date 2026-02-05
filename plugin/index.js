import {
  createOpenClawEvolutionService,
  policyToConfigPatch,
  applyPolicyToModelRequest
} from "../src/openclawAdapter.js";
import fs from "node:fs/promises";
import path from "node:path";

const PLUGIN_ID = "claw-evolve";
const PLUGIN_NAME = "ClawEvolve";
const SERVICE_ID = `${PLUGIN_ID}-runtime`;
const STATE_FILENAME = "claw-evolve-state.v1.json";
const SKIP_REGISTRATION = Symbol("skip-registration");

const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    baseModel: {
      type: "string",
      description: "Base model to optimize policy behavior for."
    },
    basePrompt: {
      type: "string",
      description: "Initial system prompt seed for policy evolution."
    },
    toolNames: {
      type: "array",
      items: { type: "string" },
      description: "Allowed tool names participating in policy routing."
    },
    objectiveWeights: {
      type: "object",
      additionalProperties: false,
      properties: {
        success: { type: "number", minimum: 0 },
        satisfaction: { type: "number", minimum: 0 },
        safety: { type: "number", minimum: 0 },
        toolReliability: { type: "number", minimum: 0 },
        efficiency: { type: "number", minimum: 0 }
      }
    },
    safeguards: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxRiskScore: { type: "number", minimum: 0, maximum: 1 },
        disallowedTools: {
          type: "array",
          items: { type: "string" }
        }
      }
    },
    online: {
      type: "object",
      additionalProperties: true,
      properties: {
        enabled: { type: "boolean" },
        minTrajectoriesForEvolution: { type: "integer", minimum: 1 },
        evolveEveryTrajectories: { type: "integer", minimum: 1 },
        cooldownMs: { type: "integer", minimum: 0 },
        windowSize: { type: "integer", minimum: 10 }
      }
    },
    engine: {
      type: "object",
      additionalProperties: true,
      properties: {
        type: { type: "string", enum: ["python-sidecar"] },
        sidecar: {
          type: "object",
          additionalProperties: true,
          properties: {
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            apiKeyEnv: { type: "string" },
            timeoutMs: { type: "integer", minimum: 1000 },
            retries: { type: "integer", minimum: 0 },
            maxPayloadTrajectories: { type: "integer", minimum: 10 }
          }
        },
        gepa: {
          type: "object",
          additionalProperties: true,
          properties: {
            reflectionLm: { type: "string" },
            candidateSelectionStrategy: { type: "string", enum: ["pareto", "aggregate"] },
            reflectionMinibatchSize: { type: "integer", minimum: 1 },
            useMerge: { type: "boolean" },
            maxMergeInvocations: { type: "integer", minimum: 0 },
            maxMetricCalls: { type: "integer", minimum: 1 },
            seed: { type: "integer", minimum: 0 }
          }
        }
      }
    },
    telemetry: {
      type: "object",
      additionalProperties: true,
      properties: {
        toolRiskScores: {
          type: "object",
          additionalProperties: {
            type: "number",
            minimum: 0,
            maximum: 1
          }
        },
        safetyIncidentRiskThreshold: { type: "number", minimum: 0, maximum: 1 },
        errorCountsAsSafetyIncident: { type: "boolean" }
      }
    }
  }
};

function log(api, level, message, meta = {}) {
  if (api?.log?.[level]) {
    api.log[level](message, meta);
    return;
  }
  if (level === "error") {
    console.error(`[${PLUGIN_NAME}] ${message}`, meta);
    return;
  }
  console.log(`[${PLUGIN_NAME}] ${message}`, meta);
}

function resolvePluginConfig(api) {
  const fromGetter =
    typeof api?.getPluginConfig === "function"
      ? api.getPluginConfig(PLUGIN_ID) || api.getPluginConfig()
      : null;
  if (fromGetter) return fromGetter;

  const fromDirect = api?.pluginConfig || api?.config;
  if (fromDirect && typeof fromDirect === "object") return fromDirect;

  const fromContainer = api?.runtimeConfig?.plugins?.entries?.[PLUGIN_ID]?.config;
  if (fromContainer && typeof fromContainer === "object") return fromContainer;

  return {};
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildTelemetryConfig(raw, safeguards) {
  return {
    toolRiskScores:
      raw.telemetry?.toolRiskScores && typeof raw.telemetry.toolRiskScores === "object"
        ? raw.telemetry.toolRiskScores
        : {},
    safetyIncidentRiskThreshold: clamp(
      raw.telemetry?.safetyIncidentRiskThreshold ?? safeguards.maxRiskScore ?? 0.55,
      0,
      1
    ),
    errorCountsAsSafetyIncident: Boolean(raw.telemetry?.errorCountsAsSafetyIncident ?? false)
  };
}

function normalizeConfig(raw) {
  const safeguards = raw.safeguards || {
    maxRiskScore: 0.55,
    disallowedTools: []
  };
  return {
    baseModel: raw.baseModel || "gpt-5-mini",
    basePrompt:
      raw.basePrompt ||
      "You are a high-reliability assistant. Prioritize user outcomes and safe tool usage.",
    toolNames: Array.isArray(raw.toolNames) ? raw.toolNames : [],
    objectiveWeights: raw.objectiveWeights,
    safeguards,
    online: raw.online,
    engine: raw.engine,
    telemetry: buildTelemetryConfig(raw, safeguards)
  };
}

async function loadPersistedState(api, service, stateDir) {
  if (!stateDir || typeof service?.restoreState !== "function") return;
  const statePath = path.join(stateDir, STATE_FILENAME);
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    service.restoreState(parsed);
    log(api, "info", "Restored persisted ClawEvolve state", {
      statePath,
      trajectoryCount: parsed?.trajectories?.length ?? 0
    });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    log(api, "warn", "Failed to restore persisted ClawEvolve state", {
      statePath,
      error: String(error?.message || error)
    });
  }
}

async function savePersistedState(api, service, stateDir) {
  if (!stateDir || typeof service?.exportState !== "function") return;
  const statePath = path.join(stateDir, STATE_FILENAME);
  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(statePath, `${JSON.stringify(service.exportState(), null, 2)}\n`, "utf8");
  } catch (error) {
    log(api, "warn", "Failed to persist ClawEvolve state", {
      statePath,
      error: String(error?.message || error)
    });
  }
}

function normalizeGatewayInvocation(invocation) {
  if (invocation && typeof invocation === "object") {
    if ("params" in invocation || "respond" in invocation || "context" in invocation) {
      return {
        params:
          invocation.params && typeof invocation.params === "object" ? invocation.params : {},
        respond: typeof invocation.respond === "function" ? invocation.respond : null
      };
    }
    return {
      params: invocation,
      respond: null
    };
  }
  return {
    params: {},
    respond: null
  };
}

function wrapGatewayHandler(handler) {
  return async (invocation = {}) => {
    const { params, respond } = normalizeGatewayInvocation(invocation);
    try {
      const payload = await handler(params || {});
      if (respond) {
        respond(true, payload);
        return;
      }
      return payload;
    } catch (error) {
      if (respond) {
        respond(false, undefined, {
          code: "CLAW_EVOLVE_ERROR",
          message: String(error?.message || error)
        });
        return;
      }
      throw error;
    }
  };
}

function safeRegisterService(api, service) {
  if (typeof api?.registerService !== "function") return false;
  try {
    api.registerService({
      id: SERVICE_ID,
      async start(ctx = {}) {
        await loadPersistedState(api, service, ctx.stateDir);
      },
      async stop(ctx = {}) {
        await savePersistedState(api, service, ctx.stateDir);
      }
    });
    return true;
  } catch {
    try {
      // Legacy OpenClaw compatibility path.
      api.registerService("evolution", service);
      return true;
    } catch {
      return false;
    }
  }
}

function safeRegisterGateway(api, service) {
  if (typeof api?.registerGatewayMethod !== "function") return false;
  api.registerGatewayMethod(
    "claw_evolve_status",
    wrapGatewayHandler(async () => {
      const state = service.getState();
      return {
        hasChampion: Boolean(state.champion),
        lastEvolutionAt: state.lastEvolutionAt,
        trajectoryCount: state.trajectories.length,
        recentEvents: state.events.slice(-10)
      };
    })
  );

  api.registerGatewayMethod(
    "claw_evolve_force_run",
    wrapGatewayHandler(async (params = {}) => {
      const run = await service.evolve({
        generations: Number(params.generations || 6),
        populationSize: Number(params.populationSize || 18)
      });
      return {
        championId: run.champion.id,
        aggregateScore: run.championEvaluation.aggregateScore,
        objectives: run.championEvaluation.objectives
      };
    })
  );

  api.registerGatewayMethod(
    "claw_evolve_export_patch",
    wrapGatewayHandler(async () => {
      const champion = service.getChampion();
      if (!champion) return null;
      return policyToConfigPatch(champion);
    })
  );
  return true;
}

function safeRegisterCommand(api, service) {
  if (typeof api?.registerCommand !== "function") return false;

  api.registerCommand({
    name: "claw-evolve-status",
    description: "Show ClawEvolve status and champion policy health.",
    async handler() {
      const state = service.getState();
      const lastEventType = state.events.length
        ? state.events[state.events.length - 1].type
        : "none";
      const championText = state.champion
        ? `Champion active: ${state.champion.id}`
        : "No champion policy promoted yet.";
      return {
        text: `${championText} Trajectories=${state.trajectories.length}. Last event=${lastEventType}.`
      };
    }
  });
  return true;
}

function registerLifecycleHook(api, eventName, handler) {
  const candidates = [
    () => (typeof api?.on === "function" ? api.on(eventName, handler) : SKIP_REGISTRATION),
    () =>
      typeof api?.registerAgentHook === "function"
        ? api.registerAgentHook(eventName, handler)
        : SKIP_REGISTRATION,
    () => (typeof api?.hooks?.on === "function" ? api.hooks.on(eventName, handler) : SKIP_REGISTRATION),
    () =>
      typeof api?.lifecycle?.on === "function"
        ? api.lifecycle.on(eventName, handler)
        : SKIP_REGISTRATION
  ];

  for (const attempt of candidates) {
    try {
      const result = attempt();
      if (result === SKIP_REGISTRATION) continue;
      if (result === false) continue;
      return true;
    } catch {
      // Try next registration strategy.
    }
  }
  return false;
}

function createRunTelemetryBridge({ service, baseModel, safeguards, telemetry }) {
  const activeRuns = new Map();
  const blockedCallsBySession = new Map();

  function nowId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeSessionKey(value) {
    if (!value || typeof value !== "string") return "main";
    return value;
  }

  function toSessionKeyFromCtx(ctx = {}) {
    return normalizeSessionKey(ctx.sessionKey || ctx.sessionId || ctx.agentId || "main");
  }

  function toRiskScore(toolName, params = {}) {
    const fromMap = telemetry.toolRiskScores?.[toolName];
    if (Number.isFinite(fromMap)) return clamp(Number(fromMap), 0, 1);
    if (typeof params.riskScore === "number") return clamp(params.riskScore, 0, 1);
    if (safeguards.disallowedTools?.includes(toolName)) return 1;
    return 0;
  }

  function ensureRun(sessionKey) {
    const key = normalizeSessionKey(sessionKey);
    let run = activeRuns.get(key);
    if (!run) {
      run = {
        id: nowId("run"),
        sessionKey: key,
        startedAt: Date.now(),
        prompt: "",
        model: baseModel,
        toolCalls: [],
        policyIdAtStart: service.getChampion()?.id || null
      };
      activeRuns.set(key, run);
    }
    return run;
  }

  function beginRun({ sessionKey, prompt }) {
    const run = ensureRun(sessionKey);
    run.startedAt = Date.now();
    run.prompt = typeof prompt === "string" ? prompt : "";
    run.policyIdAtStart = service.getChampion()?.id || null;
  }

  function trackToolCall({ sessionKey, toolName, success, durationMs, riskScore, blocked }) {
    const run = ensureRun(sessionKey);
    run.toolCalls.push({
      toolName: String(toolName || "unknown"),
      success: Boolean(success),
      latencyMs: Math.max(0, Number(durationMs || 0)),
      riskScore: clamp(Number(riskScore ?? 0.2), 0, 1),
      blocked: Boolean(blocked)
    });
  }

  function trackBlockedToolCall({ sessionKey, toolName, params }) {
    const key = normalizeSessionKey(sessionKey);
    const blocked = blockedCallsBySession.get(key) || [];
    blocked.push({
      toolName: String(toolName || "unknown"),
      riskScore: toRiskScore(toolName, params),
      blocked: true
    });
    blockedCallsBySession.set(key, blocked);
  }

  function popBlockedToolCalls(sessionKey) {
    const key = normalizeSessionKey(sessionKey);
    const blocked = blockedCallsBySession.get(key) || [];
    blockedCallsBySession.delete(key);
    return blocked;
  }

  function finishRun({
    sessionKey,
    success,
    durationMs,
    messageCount,
    userFeedback,
    costUsd,
    safetyIncidents
  }) {
    const key = normalizeSessionKey(sessionKey);
    const run = activeRuns.get(key);
    activeRuns.delete(key);
    if (!run) return null;

    const blockedCalls = popBlockedToolCalls(key).map((call) => ({
      toolName: call.toolName,
      success: false,
      latencyMs: 0,
      riskScore: call.riskScore,
      blocked: true
    }));
    const allToolCalls = [...run.toolCalls, ...blockedCalls];
    const resolvedDuration = Math.max(
      1,
      Number(durationMs || Date.now() - run.startedAt || 1200)
    );
    const inferredSuccess = allToolCalls.every((call) => call.success && !call.blocked);
    const isSuccess = typeof success === "boolean" ? success : inferredSuccess;
    const riskThreshold = telemetry.safetyIncidentRiskThreshold;

    const observedSafetyIncidents = Number.isFinite(safetyIncidents)
      ? Math.max(0, Number(safetyIncidents))
      : null;
    let inferredSafetyIncidents = allToolCalls.filter(
      (call) => call.riskScore > riskThreshold || call.blocked
    ).length;
    if (telemetry.errorCountsAsSafetyIncident) {
      inferredSafetyIncidents += allToolCalls.filter((call) => !call.success).length;
    }
    const resolvedFeedback = Number.isFinite(userFeedback) ? clamp(Number(userFeedback), -1, 1) : 0;
    const resolvedCostUsd = Number.isFinite(costUsd) ? Math.max(0, Number(costUsd)) : null;

    const trajectory = {
      id: nowId("traj"),
      policyId: service.getChampion()?.id || run.policyIdAtStart || undefined,
      model: run.model || baseModel,
      prompt: run.prompt || "",
      success: isSuccess,
      userFeedback: resolvedFeedback,
      latencyMs: resolvedDuration,
      ...(resolvedCostUsd === null ? {} : { costUsd: resolvedCostUsd }),
      safetyIncidents:
        observedSafetyIncidents === null ? inferredSafetyIncidents : observedSafetyIncidents,
      messageCount: Number(messageCount || 0),
      toolCalls: allToolCalls.map((call) => ({
        toolName: call.toolName,
        success: call.success,
        latencyMs: call.latencyMs,
        riskScore: call.riskScore
      }))
    };
    return trajectory;
  }

  function policyPatchForAgentStart() {
    const champion = service.getChampion();
    if (!champion) return null;
    const patched = applyPolicyToModelRequest(
      {
        model: champion.baseModel,
        systemPrompt: champion.systemPrompt
      },
      champion
    );
    return {
      systemPrompt: patched.systemPrompt
    };
  }

  function blockDecisionForTool({ toolName, params = {} }) {
    const champion = service.getChampion();
    if (!champion) return { blocked: false };

    const riskScore = toRiskScore(toolName, params);
    const selected = service.selectTool([{ name: toolName, riskScore }]);
    if (selected) return { blocked: false, riskScore };
    return {
      blocked: true,
      riskScore,
      reason: `Blocked by evolved policy safeguards (risk=${riskScore.toFixed(2)}).`
    };
  }

  return {
    toSessionKeyFromCtx,
    beginRun,
    trackToolCall,
    trackBlockedToolCall,
    finishRun,
    policyPatchForAgentStart,
    blockDecisionForTool
  };
}

function registerEvolutionHooks(api, service, config) {
  const bridge = createRunTelemetryBridge({
    service,
    baseModel: config.baseModel,
    safeguards: config.safeguards || { maxRiskScore: 0.55, disallowedTools: [] },
    telemetry: config.telemetry || {}
  });

  const sessionHook = registerLifecycleHook(
    api,
    "session_end",
    async (payload = {}, ctx = {}) => {
      const trajectory = payload.trajectory || payload.session?.trajectory;
      if (trajectory) {
        service.ingestTrajectory(trajectory);
        return payload;
      }

      const sessionKey = bridge.toSessionKeyFromCtx({
        ...ctx,
        sessionId: payload.sessionId
      });
      const synthesized = bridge.finishRun({
        sessionKey,
        success: typeof payload.success === "boolean" ? payload.success : undefined,
        durationMs: payload.durationMs,
        messageCount: payload.messageCount,
        userFeedback: payload.userFeedback,
        costUsd: payload.costUsd,
        safetyIncidents: payload.safetyIncidents
      });
      if (synthesized) service.ingestTrajectory(synthesized);
      return payload;
    }
  );

  const modelHook = registerLifecycleHook(
    api,
    "before_agent_start",
    async (payload = {}, ctx = {}) => {
      if (payload.request) {
        return {
          ...payload,
          request: service.applyRequestPolicy(payload.request)
        };
      }

      const sessionKey = bridge.toSessionKeyFromCtx(ctx);
      bridge.beginRun({
        sessionKey,
        prompt: payload.prompt
      });
      const hookPatch = bridge.policyPatchForAgentStart();
      return hookPatch || undefined;
    }
  );

  const toolHook = registerLifecycleHook(
    api,
    "before_tool_call",
    async (payload = {}, ctx = {}) => {
      if (Array.isArray(payload.candidateTools)) {
        return {
          ...payload,
          selectedTool: service.selectTool(payload.candidateTools)
        };
      }

      if (!payload.toolName) return payload;
      const sessionKey = bridge.toSessionKeyFromCtx(ctx);
      const decision = bridge.blockDecisionForTool({
        toolName: payload.toolName,
        params: payload.params || {}
      });
      if (!decision.blocked) {
        return {
          params: payload.params || {}
        };
      }

      bridge.trackBlockedToolCall({
        sessionKey,
        toolName: payload.toolName,
        params: payload.params || {}
      });

      return {
        block: true,
        blockReason: decision.reason
      };
    }
  );

  const afterToolHook = registerLifecycleHook(
    api,
    "after_tool_call",
    async (payload = {}, ctx = {}) => {
      if (!payload.toolName) return payload;
      bridge.trackToolCall({
        sessionKey: bridge.toSessionKeyFromCtx(ctx),
        toolName: payload.toolName,
        success: !payload.error,
        durationMs: payload.durationMs || 0,
        riskScore: bridge.blockDecisionForTool({
          toolName: payload.toolName,
          params: payload.params || {}
        }).riskScore
      });
      return payload;
    }
  );

  const agentEndHook = registerLifecycleHook(
    api,
    "agent_end",
    async (payload = {}, ctx = {}) => {
      const sessionKey = bridge.toSessionKeyFromCtx(ctx);
      const trajectory = bridge.finishRun({
        sessionKey,
        success: payload.success,
        durationMs: payload.durationMs,
        userFeedback: payload.userFeedback,
        costUsd: payload.costUsd,
        safetyIncidents: payload.safetyIncidents
      });
      if (trajectory) service.ingestTrajectory(trajectory);
      return payload;
    }
  );

  return {
    sessionHook,
    modelHook,
    toolHook,
    afterToolHook,
    agentEndHook
  };
}

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  configSchema,
  async register(api) {
    const config = normalizeConfig(resolvePluginConfig(api));
    const service = createOpenClawEvolutionService(config);

    const serviceRegistered = safeRegisterService(api, service);
    const gatewayRegistered = safeRegisterGateway(api, service);
    const commandRegistered = safeRegisterCommand(api, service);
    const hooks = registerEvolutionHooks(api, service, config);

    log(api, "info", "Plugin registered", {
      serviceRegistered,
      gatewayRegistered,
      commandRegistered,
      hooks
    });

    return {
      service,
      hooks
    };
  }
};

export { PLUGIN_ID, PLUGIN_NAME, configSchema };
