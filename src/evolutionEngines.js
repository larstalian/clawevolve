function normalizeSidecarConfig(engineConfig = {}) {
  const sidecar = engineConfig.sidecar || {};
  return {
    baseUrl: sidecar.baseUrl || "http://127.0.0.1:8091",
    apiKey: sidecar.apiKey,
    apiKeyEnv: sidecar.apiKeyEnv || "CLAW_EVOLVE_SIDECAR_API_KEY",
    timeoutMs: sidecar.timeoutMs ?? 45_000,
    retries: sidecar.retries ?? 1,
    maxPayloadTrajectories: sidecar.maxPayloadTrajectories ?? 800
  };
}

function normalizePythonGepaConfig(engineConfig = {}) {
  const gepa = engineConfig.gepa || {};
  return {
    reflectionLm: gepa.reflectionLm || "openai/gpt-5-mini",
    candidateSelectionStrategy: gepa.candidateSelectionStrategy || "pareto",
    reflectionMinibatchSize: gepa.reflectionMinibatchSize ?? 3,
    useMerge: gepa.useMerge ?? true,
    maxMergeInvocations: gepa.maxMergeInvocations ?? 5,
    maxMetricCalls: gepa.maxMetricCalls,
    seed: gepa.seed ?? 0
  };
}

function validateSidecarRun(run) {
  if (!run || typeof run !== "object") {
    throw new Error("python-sidecar returned empty response");
  }
  if (!run.champion || typeof run.champion !== "object") {
    throw new Error("python-sidecar response missing champion");
  }
  if (!run.championEvaluation || typeof run.championEvaluation !== "object") {
    throw new Error("python-sidecar response missing championEvaluation");
  }
  return run;
}

function withRetry(asyncFn, retries) {
  return async (...args) => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await asyncFn(...args);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
}

function clampTrajectories(trajectories, maxPayloadTrajectories) {
  if (trajectories.length <= maxPayloadTrajectories) return trajectories;
  return trajectories.slice(-maxPayloadTrajectories);
}

export function createPythonSidecarEvolutionEngine({
  engineConfig,
  objectiveWeights,
  algorithm
}) {
  const sidecarCfg = normalizeSidecarConfig(engineConfig);
  const pythonGepaCfg = normalizePythonGepaConfig(engineConfig);
  const apiKey = sidecarCfg.apiKey || process.env[sidecarCfg.apiKeyEnv] || null;

  async function postEvolve(payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), sidecarCfg.timeoutMs);
    try {
      const response = await fetch(`${sidecarCfg.baseUrl}/v1/evolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`python-sidecar ${response.status}: ${text.slice(0, 400)}`);
      }
      const body = await response.json();
      return validateSidecarRun(body);
    } finally {
      clearTimeout(timeout);
    }
  }

  const postWithRetry = withRetry(postEvolve, sidecarCfg.retries);

  return {
    mode: "python-sidecar",
    async evolve({
      seedGenome,
      trajectories,
      generations,
      populationSize,
      algorithmOverrides
    }) {
      const trimmedTrajectories = clampTrajectories(
        trajectories,
        sidecarCfg.maxPayloadTrajectories
      );
      const mergedAlgorithm = {
        ...(algorithm || {}),
        ...(algorithmOverrides || {})
      };
      return postWithRetry({
        seedGenome,
        trajectories: trimmedTrajectories,
        generations,
        populationSize,
        objectiveWeights,
        algorithm: mergedAlgorithm,
        gepa: pythonGepaCfg
      });
    }
  };
}

export function createEvolutionEngine({
  engineConfig,
  objectiveWeights,
  algorithm
}) {
  const type = engineConfig?.type || "python-sidecar";
  if (type !== "python-sidecar") {
    throw new Error(`Unsupported engine type: ${type}. Only "python-sidecar" is supported.`);
  }
  return createPythonSidecarEvolutionEngine({
    engineConfig,
    objectiveWeights,
    algorithm
  });
}
