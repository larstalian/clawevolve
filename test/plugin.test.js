import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import plugin from "../plugin/index.js";

function sampleTrajectory(id = "t1") {
  return {
    id,
    success: true,
    userFeedback: 0.7,
    latencyMs: 1500,
    costUsd: 0.02,
    safetyIncidents: 0,
    toolCalls: [{ toolName: "docs_search", success: true, riskScore: 0.2 }]
  };
}

function createBaseConfig() {
  return {
    baseModel: "gpt-5-mini",
    basePrompt: "Be helpful and safe.",
    toolNames: ["docs_search"],
    online: {
      enabled: false,
      minTrajectoriesForEvolution: 1,
      evolveEveryTrajectories: 1,
      cooldownMs: 0,
      holdoutRatio: 0.2,
      minHoldout: 0,
      generations: 2,
      populationSize: 6,
      promotion: {
        minAggregateLift: -1,
        maxSafetyDrop: 1,
        maxSuccessDrop: 1,
        minSafety: 0
      },
      rollback: {
        enabled: false
      }
    }
  };
}

test("plugin uses official OpenClaw API contracts for service, gateway, command, and hooks", async () => {
  const hooks = new Map();
  const gatewayMethods = new Map();
  const commands = [];
  const services = [];
  let registerHookCalls = 0;

  const api = {
    getPluginConfig() {
      return createBaseConfig();
    },
    registerService(service) {
      services.push(service);
    },
    registerGatewayMethod(name, handler) {
      gatewayMethods.set(name, handler);
    },
    registerCommand(command) {
      commands.push(command);
    },
    on(eventName, handler) {
      hooks.set(eventName, handler);
    },
    registerHook() {
      registerHookCalls += 1;
    },
    log: {
      info() {},
      warn() {}
    }
  };

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init = {}) => {
      const body = JSON.parse(init.body);
      const seed = body.seedGenome;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          champion: {
            ...seed,
            id: "plugin_py_champion",
            mutationTrace: [...(seed.mutationTrace || []), "python-sidecar"]
          },
          championEvaluation: {
            objectives: {
              successRate: 0.8,
              satisfaction: 0.7,
              safety: 0.9,
              toolReliability: 0.8,
              efficiency: 0.8
            },
            aggregateScore: 0.8
          },
          history: [{ generation: 1, bestScore: 0.8 }],
          algorithm: { mode: "gepa-python-sidecar" }
        })
      };
    };

    const reg = await plugin.register(api);
    assert.ok(reg?.service);
    assert.equal(services.length, 1);
    assert.equal(services[0].id, "claw-evolve-runtime");
    assert.equal(typeof services[0].start, "function");
    assert.equal(typeof services[0].stop, "function");
    assert.equal(registerHookCalls, 0);

    assert.ok(gatewayMethods.has("claw_evolve_status"));
    assert.ok(gatewayMethods.has("claw_evolve_force_run"));
    assert.ok(gatewayMethods.has("claw_evolve_export_patch"));
    assert.equal(commands.length, 1);
    assert.ok(hooks.has("session_end"));
    assert.ok(hooks.has("before_agent_start"));
    assert.ok(hooks.has("before_tool_call"));
    assert.equal(reg.hooks.sessionHook, true);
    assert.equal(reg.hooks.modelHook, true);
    assert.equal(reg.hooks.toolHook, true);
    assert.equal(reg.hooks.afterToolHook, true);
    assert.equal(reg.hooks.agentEndHook, true);

    await hooks.get("session_end")({ trajectory: sampleTrajectory("t2") });
    await reg.service.waitForIdle();

    let statusResult = null;
    await gatewayMethods.get("claw_evolve_status")({
      params: {},
      respond(ok, payload, error) {
        statusResult = { ok, payload, error };
      }
    });
    assert.equal(statusResult.ok, true);
    assert.equal(typeof statusResult.payload.hasChampion, "boolean");

    let forceResult = null;
    await gatewayMethods.get("claw_evolve_force_run")({
      params: {
        generations: 2,
        populationSize: 6
      },
      respond(ok, payload, error) {
        forceResult = { ok, payload, error };
      }
    });
    assert.equal(forceResult.ok, true);
    assert.ok(forceResult.payload.championId);
    assert.equal(typeof forceResult.payload.aggregateScore, "number");

    let patchResult = null;
    await gatewayMethods.get("claw_evolve_export_patch")({
      params: {},
      respond(ok, payload, error) {
        patchResult = { ok, payload, error };
      }
    });
    assert.equal(patchResult.ok, true);
    assert.ok(patchResult.payload?.agent);

    const commandResponse = await commands[0].handler({
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/claw-evolve-status",
      config: {}
    });
    assert.equal(typeof commandResponse.text, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin synthesizes trajectories from official OpenClaw hook payloads", async () => {
  const hooks = new Map();
  const gatewayMethods = new Map();
  let registerHookCalls = 0;

  const api = {
    getPluginConfig() {
      return {
        ...createBaseConfig(),
        telemetry: {
          toolRiskScores: {
            docs_search: 0.1
          }
        }
      };
    },
    on(eventName, handler) {
      hooks.set(eventName, handler);
    },
    registerHook() {
      registerHookCalls += 1;
    },
    registerService() {},
    registerGatewayMethod(name, handler) {
      gatewayMethods.set(name, handler);
    },
    registerCommand() {},
    log: {
      info() {},
      warn() {}
    }
  };

  const reg = await plugin.register(api);
  assert.equal(registerHookCalls, 0);
  assert.ok(hooks.has("before_agent_start"));
  assert.ok(hooks.has("before_tool_call"));
  assert.ok(hooks.has("after_tool_call"));
  assert.ok(hooks.has("agent_end"));
  assert.equal(reg.hooks.sessionHook, true);
  assert.equal(reg.hooks.modelHook, true);
  assert.equal(reg.hooks.toolHook, true);
  assert.equal(reg.hooks.afterToolHook, true);
  assert.equal(reg.hooks.agentEndHook, true);

  await hooks.get("before_agent_start")(
    { prompt: "Summarize docs." },
    { sessionKey: "session_a", agentId: "main" }
  );
  await hooks.get("before_tool_call")(
    { toolName: "docs_search", params: { query: "Q4 plan" } },
    { sessionKey: "session_a", toolName: "docs_search" }
  );
  await hooks.get("after_tool_call")(
    { toolName: "docs_search", params: { query: "Q4 plan" }, durationMs: 240 },
    { sessionKey: "session_a", toolName: "docs_search" }
  );
  await hooks.get("agent_end")(
    { success: true, durationMs: 1400, messages: [] },
    { sessionKey: "session_a", agentId: "main" }
  );

  const stateAfterRun = reg.service.getState();
  assert.equal(stateAfterRun.trajectories.length, 1);
  assert.equal(stateAfterRun.trajectories[0].userFeedback, 0);
  assert.equal("costUsd" in stateAfterRun.trajectories[0], false);

  let statusResult = null;
  await gatewayMethods.get("claw_evolve_status")({
    params: {},
    respond(ok, payload, error) {
      statusResult = { ok, payload, error };
    }
  });
  assert.equal(statusResult.ok, true);
  assert.equal(statusResult.payload.trajectoryCount, 1);
});

test("service lifecycle persists and restores state through stateDir", async () => {
  const services = [];
  const api = {
    getPluginConfig() {
      return createBaseConfig();
    },
    on() {},
    registerService(service) {
      services.push(service);
    },
    registerGatewayMethod() {},
    registerCommand() {},
    log: {
      info() {},
      warn() {}
    }
  };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claw-evolve-test-"));
  try {
    const reg1 = await plugin.register(api);
    reg1.service.ingestTrajectory(sampleTrajectory("persist_me"));
    await services[0].stop({ stateDir: dir });

    const reg2 = await plugin.register(api);
    await services[1].start({ stateDir: dir });
    const state = reg2.service.getState();
    assert.equal(state.trajectories.length, 1);
    assert.equal(state.trajectories[0].id, "persist_me");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
