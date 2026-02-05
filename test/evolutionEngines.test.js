import test from "node:test";
import assert from "node:assert/strict";

import {
  createEvolutionEngine,
  createPythonSidecarEvolutionEngine
} from "../src/evolutionEngines.js";

function sampleSeedGenome() {
  return {
    id: "seed",
    baseModel: "gpt-5-mini",
    systemPrompt: "Seed prompt",
    responseStyle: "balanced",
    toolPreferences: {
      docs_search: 1
    },
    toolRetryBudget: 1,
    deliberationBudget: 2,
    memoryDepth: 6,
    safeguards: {
      maxRiskScore: 0.55,
      disallowedTools: []
    },
    mutationTrace: ["seed"]
  };
}

function sampleTrajectory(id = "t1") {
  return {
    id,
    success: true,
    userFeedback: 0.5,
    latencyMs: 1400,
    costUsd: 0.02,
    safetyIncidents: 0,
    toolCalls: [{ toolName: "docs_search", success: true, riskScore: 0.2 }]
  };
}

test("python sidecar engine sends auth and retries once", async () => {
  let callCount = 0;
  let authHeader = "";
  let postedTrajectories = 0;
  let algorithmOuterHoldoutApplied = false;

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init = {}) => {
      callCount += 1;
      authHeader = init.headers?.Authorization || "";
      const body = JSON.parse(init.body);
      postedTrajectories = body.trajectories.length;
      algorithmOuterHoldoutApplied = Boolean(body.algorithm?.outerHoldoutApplied);

      if (callCount === 1) {
        return {
          ok: false,
          status: 500,
          text: async () => "temporary failure"
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          champion: sampleSeedGenome(),
          championEvaluation: {
            objectives: {
              successRate: 1,
              satisfaction: 0.8,
              safety: 1,
              toolReliability: 0.9,
              efficiency: 0.8
            },
            aggregateScore: 0.9
          },
          history: [],
          algorithm: { mode: "gepa-python-sidecar" }
        })
      };
    };

    const engine = createPythonSidecarEvolutionEngine({
      engineConfig: {
        sidecar: {
          baseUrl: "http://sidecar.local",
          apiKey: "secret-token",
          retries: 1,
          maxPayloadTrajectories: 2,
          timeoutMs: 5000
        }
      },
      objectiveWeights: {},
      algorithm: { mode: "gepa" }
    });

    const run = await engine.evolve({
      seedGenome: sampleSeedGenome(),
      trajectories: [sampleTrajectory("1"), sampleTrajectory("2"), sampleTrajectory("3")],
      generations: 2,
      populationSize: 6,
      algorithmOverrides: {
        outerHoldoutApplied: true
      }
    });

    assert.ok(run.champion);
    assert.equal(callCount, 2);
    assert.equal(authHeader, "Bearer secret-token");
    assert.equal(postedTrajectories, 2);
    assert.equal(algorithmOuterHoldoutApplied, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createEvolutionEngine only supports python-sidecar", () => {
  assert.throws(
    () =>
      createEvolutionEngine({
        engineConfig: { type: "local" },
        objectiveWeights: {},
        algorithm: {}
      }),
    /Only "python-sidecar" is supported|Unsupported engine type/
  );
});
