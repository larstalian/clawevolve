import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPolicyToModelRequest,
  chooseToolInvocation,
  createOpenClawEvolutionService
} from "../src/openclawAdapter.js";

function withMockSidecar(mockImplementation, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockImplementation;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

test("applyPolicyToModelRequest injects evolved directives", () => {
  const request = {
    model: "gpt-5-mini",
    systemPrompt: "Base prompt"
  };
  const genome = {
    baseModel: "gpt-5",
    systemPrompt: "Evolved prompt",
    responseStyle: "concise",
    deliberationBudget: 2,
    memoryDepth: 7
  };

  const next = applyPolicyToModelRequest(request, genome);
  assert.equal(next.model, "gpt-5");
  assert.match(next.systemPrompt, /Evolved prompt/);
  assert.match(next.systemPrompt, /concise/i);
  assert.match(next.systemPrompt, /memory items/);
});

test("chooseToolInvocation enforces risk and disallow rules", () => {
  const genome = {
    toolPreferences: {
      safe_tool: 0.9,
      risky_tool: 0.1
    },
    safeguards: {
      maxRiskScore: 0.5,
      disallowedTools: ["blocked_tool"]
    }
  };

  const choice = chooseToolInvocation(
    [
      { name: "blocked_tool", riskScore: 0.1 },
      { name: "risky_tool", riskScore: 0.9 },
      { name: "safe_tool", riskScore: 0.2 }
    ],
    genome
  );
  assert.equal(choice.name, "safe_tool");
});

test("service exports patch after evolution", async () => {
  await withMockSidecar(async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    const seed = body.seedGenome;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        champion: {
          ...seed,
          id: "py_patch",
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
        history: []
      })
    };
  }, async () => {
    const service = createOpenClawEvolutionService({
      baseModel: "gpt-5-mini",
      basePrompt: "Be safe.",
      toolNames: ["docs_search"],
      safeguards: { maxRiskScore: 0.55 }
    });

    service.ingestTrajectory({
      id: "x",
      success: true,
      userFeedback: 0.8,
      latencyMs: 1300,
      costUsd: 0.01,
      safetyIncidents: 0,
      toolCalls: [{ toolName: "docs_search", success: true, riskScore: 0.1 }]
    });

    await service.evolve({ generations: 2, populationSize: 6 });
    const patch = service.exportPatch();
    assert.ok(patch?.agent?.systemPrompt);
    assert.equal(patch.model.includes("gpt"), true);
  });
});

test("service performs online evolution automatically", async () => {
  let sawOuterHoldoutFlag = false;
  await withMockSidecar(async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    sawOuterHoldoutFlag = Boolean(body.algorithm?.outerHoldoutApplied);
    const seed = body.seedGenome;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        champion: {
          ...seed,
          id: "py_online",
          mutationTrace: [...(seed.mutationTrace || []), "python-sidecar"]
        },
        championEvaluation: {
          objectives: {
            successRate: 0.75,
            satisfaction: 0.7,
            safety: 0.9,
            toolReliability: 0.8,
            efficiency: 0.8
          },
          aggregateScore: 0.78
        },
        history: [{ generation: 1, bestScore: 0.78 }]
      })
    };
  }, async () => {
    const service = createOpenClawEvolutionService({
      baseModel: "gpt-5-mini",
      basePrompt: "Be safe and useful.",
      toolNames: ["docs_search", "sql_query"],
      safeguards: { maxRiskScore: 0.55 },
      online: {
        enabled: true,
        minTrajectoriesForEvolution: 4,
        evolveEveryTrajectories: 2,
        cooldownMs: 0,
        windowSize: 50,
        holdoutRatio: 0.25,
        minHoldout: 1,
        generations: 2,
        populationSize: 8,
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
    });

    const trajectories = [
      {
        id: "a",
        success: true,
        userFeedback: 0.8,
        latencyMs: 1100,
        costUsd: 0.01,
        safetyIncidents: 0,
        toolCalls: [{ toolName: "docs_search", success: true, riskScore: 0.1 }]
      },
      {
        id: "b",
        success: true,
        userFeedback: 0.6,
        latencyMs: 1300,
        costUsd: 0.01,
        safetyIncidents: 0,
        toolCalls: [{ toolName: "sql_query", success: true, riskScore: 0.2 }]
      },
      {
        id: "c",
        success: true,
        userFeedback: 0.4,
        latencyMs: 1700,
        costUsd: 0.02,
        safetyIncidents: 0,
        toolCalls: [{ toolName: "docs_search", success: true, riskScore: 0.1 }]
      },
      {
        id: "d",
        success: false,
        userFeedback: -0.2,
        latencyMs: 2600,
        costUsd: 0.03,
        safetyIncidents: 1,
        toolCalls: [{ toolName: "sql_query", success: false, riskScore: 0.5 }]
      }
    ];

    for (const t of trajectories) {
      service.ingestTrajectory(t);
    }
    await service.waitForIdle();

    const state = service.getState();
    assert.ok(state.champion);
    assert.ok(state.events.some((event) => event.type === "promotion"));
    assert.equal(sawOuterHoldoutFlag, true);
  });
});

test("service can evolve via python-sidecar engine", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init = {}) => {
      const body = JSON.parse(init.body);
      const seed = body.seedGenome;
      const champion = {
        ...seed,
        id: "py_champion",
        systemPrompt: `${seed.systemPrompt}\n- Sidecar tuned.`,
        mutationTrace: [...(seed.mutationTrace || []), "python-sidecar"]
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          champion,
          championEvaluation: {
            objectives: {
              successRate: 0.7,
              satisfaction: 0.7,
              safety: 0.9,
              toolReliability: 0.7,
              efficiency: 0.8
            },
            aggregateScore: 0.72
          },
          history: [{ generation: 1, bestScore: 0.72 }],
          algorithm: { mode: "gepa-python-sidecar" }
        })
      };
    };

    const service = createOpenClawEvolutionService({
      baseModel: "gpt-5-mini",
      basePrompt: "Be safe and useful.",
      toolNames: ["docs_search", "sql_query"],
      safeguards: { maxRiskScore: 0.55 },
      engine: {
        type: "python-sidecar",
        sidecar: {
          baseUrl: "http://sidecar.local",
          timeoutMs: 5000,
          retries: 0
        }
      },
      online: {
        enabled: false
      }
    });

    service.ingestTrajectory({
      id: "x",
      success: true,
      userFeedback: 0.7,
      latencyMs: 1200,
      costUsd: 0.01,
      safetyIncidents: 0,
      toolCalls: [{ toolName: "docs_search", success: true, riskScore: 0.1 }]
    });

    const run = await service.evolve({ generations: 2, populationSize: 6 });
    assert.equal(run.champion.id, "py_champion");
    const patched = service.applyRequestPolicy({ model: "gpt-5-mini", systemPrompt: "base" });
    assert.match(patched.systemPrompt, /Sidecar tuned/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("service can export and restore state snapshots", async () => {
  const serviceA = createOpenClawEvolutionService({
    baseModel: "gpt-5-mini",
    basePrompt: "Be safe and useful.",
    toolNames: ["docs_search"],
    safeguards: { maxRiskScore: 0.55 },
    online: { enabled: false }
  });

  serviceA.ingestTrajectory({
    id: "restore_x",
    success: true,
    userFeedback: 0.7,
    latencyMs: 1200,
    costUsd: 0.01,
    safetyIncidents: 0,
    toolCalls: [{ toolName: "docs_search", success: true, riskScore: 0.1 }]
  });

  const snapshot = serviceA.exportState();
  assert.equal(Array.isArray(snapshot.trajectories), true);
  assert.equal(snapshot.trajectories.length, 1);

  const serviceB = createOpenClawEvolutionService({
    baseModel: "gpt-5-mini",
    basePrompt: "Be safe and useful.",
    toolNames: ["docs_search"],
    safeguards: { maxRiskScore: 0.55 },
    online: { enabled: false }
  });
  const restored = serviceB.restoreState(snapshot);
  assert.equal(restored, true);
  assert.equal(serviceB.getState().trajectories[0].id, "restore_x");
});
