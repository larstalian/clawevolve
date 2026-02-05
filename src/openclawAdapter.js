import { createSeedGenome } from "./policyGenome.js";
import { weightedChoice } from "./utils.js";
import { evaluateGenome } from "./objectives.js";
import { createEvolutionEngine } from "./evolutionEngines.js";

export function applyPolicyToModelRequest(request, genome) {
  const next = structuredClone(request);

  const styleDirective = {
    concise: "Keep responses concise and execution-focused.",
    balanced: "Balance brevity and explanation.",
    detailed: "Provide detailed rationale for key decisions."
  }[genome.responseStyle];

  const memoryDirective = `Use up to ${genome.memoryDepth} relevant memory items.`;
  const deliberationDirective = `Internal deliberation budget: ${genome.deliberationBudget}.`;
  next.systemPrompt = `${genome.systemPrompt}\n- ${styleDirective}\n- ${memoryDirective}\n- ${deliberationDirective}`;
  next.model = genome.baseModel;

  return next;
}

export function chooseToolInvocation(candidateTools, genome) {
  const allowed = candidateTools.filter(
    (tool) =>
      !genome.safeguards.disallowedTools.includes(tool.name) &&
      (tool.riskScore ?? 0) <= genome.safeguards.maxRiskScore
  );
  if (!allowed.length) return null;

  const weightedItems = allowed.map((tool) => ({
    value: tool,
    weight: genome.toolPreferences[tool.name] ?? 0.01
  }));

  return weightedChoice(weightedItems);
}

export function policyToConfigPatch(genome) {
  return {
    model: genome.baseModel,
    agent: {
      systemPrompt: genome.systemPrompt,
      responseStyle: genome.responseStyle,
      memoryDepth: genome.memoryDepth,
      deliberationBudget: genome.deliberationBudget,
      toolRetryBudget: genome.toolRetryBudget,
      safeguards: genome.safeguards,
      toolPreferences: genome.toolPreferences
    }
  };
}

function splitTrainHoldout(trajectories, holdoutRatio, minHoldout) {
  if (!trajectories.length) return { train: [], holdout: [] };
  const holdoutCount = Math.max(
    Math.min(trajectories.length - 1, minHoldout),
    Math.floor(trajectories.length * holdoutRatio)
  );
  if (holdoutCount <= 0) return { train: trajectories, holdout: [] };
  return {
    train: trajectories.slice(0, trajectories.length - holdoutCount),
    holdout: trajectories.slice(trajectories.length - holdoutCount)
  };
}

function shouldPromoteCandidate({
  candidateEval,
  incumbentEval,
  promotion
}) {
  if (!incumbentEval) {
    return {
      promote: candidateEval.objectives.safety >= promotion.minSafety,
      reason: "initial_promotion"
    };
  }

  const aggregateLift = candidateEval.aggregateScore - incumbentEval.aggregateScore;
  const safetyDrop = incumbentEval.objectives.safety - candidateEval.objectives.safety;
  const successDrop = incumbentEval.objectives.successRate - candidateEval.objectives.successRate;

  const promote =
    aggregateLift >= promotion.minAggregateLift &&
    candidateEval.objectives.safety >= promotion.minSafety &&
    safetyDrop <= promotion.maxSafetyDrop &&
    successDrop <= promotion.maxSuccessDrop;

  return {
    promote,
    reason: promote ? "beat_incumbent_on_holdout" : "candidate_failed_gate",
    aggregateLift,
    safetyDrop,
    successDrop
  };
}

export function createOpenClawEvolutionService({
  baseModel,
  basePrompt,
  toolNames,
  objectiveWeights,
  safeguards,
  online,
  engine
}) {
  const engineCfg = {
    type: "python-sidecar",
    sidecar: engine?.sidecar,
    gepa: engine?.gepa
  };
  const algorithmConfig = {
    mode: "gepa-python-sidecar",
    candidateSelectionStrategy: engine?.gepa?.candidateSelectionStrategy ?? "pareto",
    reflectionMinibatchSize: engine?.gepa?.reflectionMinibatchSize ?? 3,
    useMerge: engine?.gepa?.useMerge ?? true
  };

  const onlineCfg = {
    enabled: online?.enabled ?? true,
    minTrajectoriesForEvolution: online?.minTrajectoriesForEvolution ?? 12,
    evolveEveryTrajectories: online?.evolveEveryTrajectories ?? 4,
    cooldownMs: online?.cooldownMs ?? 20_000,
    windowSize: online?.windowSize ?? 400,
    holdoutRatio: online?.holdoutRatio ?? 0.2,
    minHoldout: online?.minHoldout ?? 3,
    generations: online?.generations ?? 6,
    populationSize: online?.populationSize ?? 18,
    promotion: {
      minAggregateLift: online?.promotion?.minAggregateLift ?? 0.003,
      maxSafetyDrop: online?.promotion?.maxSafetyDrop ?? 0.02,
      maxSuccessDrop: online?.promotion?.maxSuccessDrop ?? 0.03,
      minSafety: online?.promotion?.minSafety ?? 0.65
    },
    rollback: {
      enabled: online?.rollback?.enabled ?? true,
      monitorWindow: online?.rollback?.monitorWindow ?? 60,
      minSamples: online?.rollback?.minSamples ?? 20,
      maxAggregateDrop: online?.rollback?.maxAggregateDrop ?? 0.05,
      maxSafetyDrop: online?.rollback?.maxSafetyDrop ?? 0.05
    }
  };

  const state = {
    trajectories: [],
    champion: null,
    lastRun: null,
    lastEvolutionAt: 0,
    lastEvolutionTrajectoryCount: 0,
    evolutionInFlight: null,
    previousChampion: null,
    baselineEvaluation: null,
    events: [],
    mode: "python-sidecar"
  };

  const evolutionEngine = createEvolutionEngine({
    engineConfig: engineCfg,
    objectiveWeights,
    algorithm: algorithmConfig
  });

  async function runEvolution({
    seedGenome,
    trajectories,
    generations,
    populationSize,
    algorithmOverrides
  }) {
    return evolutionEngine.evolve({
      seedGenome,
      trajectories,
      generations,
      populationSize,
      algorithmOverrides
    });
  }

  function trimTrajectoryWindow() {
    if (state.trajectories.length > onlineCfg.windowSize) {
      state.trajectories.splice(0, state.trajectories.length - onlineCfg.windowSize);
    }
  }

  function maybeRollback() {
    if (!onlineCfg.rollback.enabled) return;
    if (!state.previousChampion || !state.champion || !state.baselineEvaluation) return;

    const recent = state.trajectories.slice(-onlineCfg.rollback.monitorWindow);
    if (!recent.length) return;
    const scoped = recent.filter((t) => t.policyId === state.champion.id);
    const monitorSet = scoped.length >= onlineCfg.rollback.minSamples ? scoped : recent;
    if (monitorSet.length < onlineCfg.rollback.minSamples) return;

    const liveEval = evaluateGenome(state.champion, monitorSet, objectiveWeights);
    const baseEval = state.baselineEvaluation;
    const aggregateDrop = baseEval.aggregateScore - liveEval.aggregateScore;
    const safetyDrop = baseEval.objectives.safety - liveEval.objectives.safety;

    if (
      aggregateDrop > onlineCfg.rollback.maxAggregateDrop ||
      safetyDrop > onlineCfg.rollback.maxSafetyDrop
    ) {
      state.events.push({
        at: Date.now(),
        type: "rollback",
        aggregateDrop,
        safetyDrop,
        fromPolicyId: state.champion.id,
        toPolicyId: state.previousChampion.id
      });
      state.champion = state.previousChampion;
      state.previousChampion = null;
      state.baselineEvaluation = null;
    }
  }

  async function runOnlineEvolution() {
    const snapshot = [...state.trajectories];
    const { train, holdout } = splitTrainHoldout(
      snapshot,
      onlineCfg.holdoutRatio,
      onlineCfg.minHoldout
    );
    if (train.length < 2) return null;

    const seedGenome =
      state.champion ??
      createSeedGenome({
        baseModel,
        systemPrompt: basePrompt,
        toolNames,
        safeguards
      });

    const run = await runEvolution({
      seedGenome,
      trajectories: train,
      generations: onlineCfg.generations,
      populationSize: onlineCfg.populationSize,
      algorithmOverrides: {
        outerHoldoutApplied: true
      }
    });

    const validationSet = holdout.length ? holdout : train;
    const candidateEval = evaluateGenome(run.champion, validationSet, objectiveWeights);
    const incumbentEval = state.champion
      ? evaluateGenome(state.champion, validationSet, objectiveWeights)
      : null;

    const gate = shouldPromoteCandidate({
      candidateEval,
      incumbentEval,
      promotion: onlineCfg.promotion
    });

    if (gate.promote) {
      if (state.champion) state.previousChampion = state.champion;
      state.champion = run.champion;
      state.baselineEvaluation = candidateEval;
      state.events.push({
        at: Date.now(),
        type: "promotion",
        reason: gate.reason,
        policyId: run.champion.id,
        candidateEval,
        incumbentEval
      });
    } else {
      state.events.push({
        at: Date.now(),
        type: "rejection",
        reason: gate.reason,
        gate
      });
    }

    state.lastRun = {
      ...run,
      online: {
        validationSetSize: validationSet.length,
        candidateEval,
        incumbentEval,
        gate
      }
    };
    state.lastEvolutionAt = Date.now();
    state.lastEvolutionTrajectoryCount = state.trajectories.length;
    return state.lastRun;
  }

  function maybeScheduleOnlineEvolution() {
    if (!onlineCfg.enabled) return;
    if (state.evolutionInFlight) return;
    if (state.trajectories.length < onlineCfg.minTrajectoriesForEvolution) return;
    if (
      state.trajectories.length - state.lastEvolutionTrajectoryCount <
      onlineCfg.evolveEveryTrajectories
    ) {
      return;
    }
    if (Date.now() - state.lastEvolutionAt < onlineCfg.cooldownMs) return;

    state.evolutionInFlight = runOnlineEvolution()
      .catch((error) => {
        state.events.push({
          at: Date.now(),
          type: "error",
          error: error.message
        });
      })
      .finally(() => {
        state.evolutionInFlight = null;
      });
  }

  function exportState() {
    return {
      trajectories: structuredClone(state.trajectories),
      champion: structuredClone(state.champion),
      lastRun: structuredClone(state.lastRun),
      lastEvolutionAt: state.lastEvolutionAt,
      lastEvolutionTrajectoryCount: state.lastEvolutionTrajectoryCount,
      previousChampion: structuredClone(state.previousChampion),
      baselineEvaluation: structuredClone(state.baselineEvaluation),
      events: structuredClone(state.events),
      mode: state.mode
    };
  }

  function toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
  }

  function restoreState(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return false;

    const nextTrajectories = Array.isArray(snapshot.trajectories) ? snapshot.trajectories : [];
    state.trajectories = nextTrajectories.slice(-onlineCfg.windowSize);
    state.champion = snapshot.champion && typeof snapshot.champion === "object" ? snapshot.champion : null;
    state.lastRun = snapshot.lastRun && typeof snapshot.lastRun === "object" ? snapshot.lastRun : null;
    state.lastEvolutionAt = toFiniteNumber(snapshot.lastEvolutionAt, 0);
    state.lastEvolutionTrajectoryCount = toFiniteNumber(snapshot.lastEvolutionTrajectoryCount, 0);
    state.previousChampion =
      snapshot.previousChampion && typeof snapshot.previousChampion === "object"
        ? snapshot.previousChampion
        : null;
    state.baselineEvaluation =
      snapshot.baselineEvaluation && typeof snapshot.baselineEvaluation === "object"
        ? snapshot.baselineEvaluation
        : null;
    state.events = Array.isArray(snapshot.events) ? snapshot.events.slice(-1000) : [];
    state.mode = typeof snapshot.mode === "string" ? snapshot.mode : state.mode;
    state.evolutionInFlight = null;
    return true;
  }

  return {
    ingestTrajectory(trajectory) {
      state.trajectories.push(trajectory);
      trimTrajectoryWindow();
      maybeRollback();
      maybeScheduleOnlineEvolution();
    },

    getChampion() {
      return state.champion;
    },

    getState() {
      return structuredClone(state);
    },

    exportState,
    restoreState,

    async evolve({ generations = 8, populationSize = 20 } = {}) {
      const seedGenome =
        state.champion ??
        createSeedGenome({
          baseModel,
          systemPrompt: basePrompt,
          toolNames,
          safeguards
        });
      const run = await runEvolution({
        seedGenome,
        trajectories: state.trajectories,
        generations,
        populationSize
      });
      state.champion = run.champion;
      state.lastRun = run;
      return run;
    },

    async waitForIdle() {
      if (state.evolutionInFlight) {
        await state.evolutionInFlight;
      }
    },

    applyRequestPolicy(modelRequest) {
      if (!state.champion) return modelRequest;
      const next = applyPolicyToModelRequest(modelRequest, state.champion);
      next.metadata = {
        ...(next.metadata || {}),
        clawEvolvePolicyId: state.champion.id
      };
      return next;
    },

    selectTool(candidateTools) {
      if (!state.champion) return candidateTools[0] ?? null;
      return chooseToolInvocation(candidateTools, state.champion);
    },

    exportPatch() {
      if (!state.champion) return null;
      return policyToConfigPatch(state.champion);
    }
  };
}

/**
 * Plugin shape compatible with OpenClaw's plugin architecture.
 * Hook names can be mapped to exact runtime hook ids during integration.
 */
export function createOpenClawEvolutionPlugin(config) {
  const service = createOpenClawEvolutionService(config);

  return {
    name: "openclaw-evolve",
    services: {
      evolution: service
    },
    hooks: {
      session_end: ({ trajectory }) => {
        if (trajectory) service.ingestTrajectory(trajectory);
      },
      before_agent_start: ({ request }) => service.applyRequestPolicy(request),
      before_tool_call: ({ candidateTools }) => service.selectTool(candidateTools),

      // Backward-compatible aliases for older integration glue.
      onSessionEnd: ({ trajectory }) => {
        if (trajectory) service.ingestTrajectory(trajectory);
      },
      beforeModelCall: ({ request }) => service.applyRequestPolicy(request),
      beforeToolCall: ({ candidateTools }) => service.selectTool(candidateTools)
    }
  };
}
