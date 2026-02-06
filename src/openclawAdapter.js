import { createSeedGenome } from "./policyGenome.js";
import { id, mean, weightedChoice } from "./utils.js";
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

function roundMetric(value, digits = 4) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Number(parsed.toFixed(digits));
}

function uniqueSortedStrings(values = []) {
  return Array.from(new Set(values.map((value) => String(value)))).sort();
}

function summarizePromptChange(previousPrompt = "", nextPrompt = "") {
  if (previousPrompt === nextPrompt) return null;
  const previousLines = previousPrompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const nextLines = nextPrompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const addedLines = nextLines.filter((line) => !previousLines.includes(line)).slice(0, 6);
  const removedLines = previousLines.filter((line) => !nextLines.includes(line)).slice(0, 6);
  return {
    previousChars: previousPrompt.length,
    nextChars: nextPrompt.length,
    deltaChars: nextPrompt.length - previousPrompt.length,
    addedLines,
    removedLines
  };
}

function summarizeToolPreferenceDiff(previous = {}, next = {}, limit = 8) {
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  const deltas = [];
  for (const toolName of keys) {
    const from = Number(previous?.[toolName] ?? 0);
    const to = Number(next?.[toolName] ?? 0);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const delta = to - from;
    if (Math.abs(delta) < 1e-6) continue;
    deltas.push({
      toolName,
      from: roundMetric(from),
      to: roundMetric(to),
      delta: roundMetric(delta)
    });
  }
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return deltas.slice(0, limit);
}

function summarizePolicyDiff(previous, next) {
  if (!next) return null;

  if (!previous) {
    return {
      kind: "initial",
      changedFields: ["initial_champion"],
      baseModel: { from: null, to: next.baseModel ?? null },
      responseStyle: { from: null, to: next.responseStyle ?? null },
      toolRetryBudget: { from: null, to: next.toolRetryBudget ?? null },
      deliberationBudget: { from: null, to: next.deliberationBudget ?? null },
      memoryDepth: { from: null, to: next.memoryDepth ?? null },
      safeguards: {
        maxRiskScore: { from: null, to: roundMetric(next.safeguards?.maxRiskScore) },
        disallowedTools: {
          added: uniqueSortedStrings(next.safeguards?.disallowedTools || []),
          removed: []
        }
      },
      systemPrompt: summarizePromptChange("", next.systemPrompt || ""),
      topToolPreferenceChanges: summarizeToolPreferenceDiff({}, next.toolPreferences || {})
    };
  }

  const changedFields = [];
  const diff = {
    kind: "update",
    changedFields,
    topToolPreferenceChanges: []
  };

  function recordScalarChange(fieldName, from, to) {
    if (from === to) return;
    changedFields.push(fieldName);
    diff[fieldName] = { from, to };
  }

  recordScalarChange("baseModel", previous.baseModel, next.baseModel);
  recordScalarChange("responseStyle", previous.responseStyle, next.responseStyle);
  recordScalarChange("toolRetryBudget", previous.toolRetryBudget, next.toolRetryBudget);
  recordScalarChange("deliberationBudget", previous.deliberationBudget, next.deliberationBudget);
  recordScalarChange("memoryDepth", previous.memoryDepth, next.memoryDepth);

  const previousRisk = roundMetric(previous.safeguards?.maxRiskScore);
  const nextRisk = roundMetric(next.safeguards?.maxRiskScore);
  if (previousRisk !== nextRisk) {
    changedFields.push("safeguards.maxRiskScore");
    diff.safeguards = {
      ...(diff.safeguards || {}),
      maxRiskScore: {
        from: previousRisk,
        to: nextRisk
      }
    };
  }

  const previousDisallowed = uniqueSortedStrings(previous.safeguards?.disallowedTools || []);
  const nextDisallowed = uniqueSortedStrings(next.safeguards?.disallowedTools || []);
  const addedDisallowed = nextDisallowed.filter((tool) => !previousDisallowed.includes(tool));
  const removedDisallowed = previousDisallowed.filter((tool) => !nextDisallowed.includes(tool));
  if (addedDisallowed.length || removedDisallowed.length) {
    changedFields.push("safeguards.disallowedTools");
    diff.safeguards = {
      ...(diff.safeguards || {}),
      disallowedTools: {
        added: addedDisallowed,
        removed: removedDisallowed
      }
    };
  }

  const promptChange = summarizePromptChange(previous.systemPrompt || "", next.systemPrompt || "");
  if (promptChange) {
    changedFields.push("systemPrompt");
    diff.systemPrompt = promptChange;
  }

  const toolPreferenceChanges = summarizeToolPreferenceDiff(
    previous.toolPreferences || {},
    next.toolPreferences || {}
  );
  if (toolPreferenceChanges.length) {
    changedFields.push("toolPreferences");
    diff.topToolPreferenceChanges = toolPreferenceChanges;
  }

  if (!changedFields.length) {
    return {
      kind: "no_change",
      changedFields: []
    };
  }
  return diff;
}

function summarizeTrajectoryWindow(trajectories, windowSize = 50) {
  const scoped = trajectories.slice(-windowSize);
  if (!scoped.length) {
    return {
      sampleCount: 0
    };
  }

  const successRate = mean(scoped.map((trajectory) => (trajectory.success ? 1 : 0)));
  const satisfaction = mean(scoped.map((trajectory) => Number(trajectory.userFeedback ?? 0)));
  const safetyIncidents = mean(scoped.map((trajectory) => Number(trajectory.safetyIncidents ?? 0)));
  const latencyValues = scoped
    .map((trajectory) => Number(trajectory.latencyMs))
    .filter((value) => Number.isFinite(value));
  const costValues = scoped
    .map((trajectory) => Number(trajectory.costUsd))
    .filter((value) => Number.isFinite(value));

  const toolStats = new Map();
  for (const trajectory of scoped) {
    for (const call of trajectory.toolCalls || []) {
      const toolName = String(call.toolName || "unknown");
      const entry = toolStats.get(toolName) || {
        calls: 0,
        successes: 0,
        riskScores: []
      };
      entry.calls += 1;
      if (call.success) entry.successes += 1;
      const risk = Number(call.riskScore);
      if (Number.isFinite(risk)) entry.riskScores.push(risk);
      toolStats.set(toolName, entry);
    }
  }

  const topTools = [...toolStats.entries()]
    .map(([toolName, stats]) => ({
      toolName,
      calls: stats.calls,
      successRate: roundMetric(stats.calls ? stats.successes / stats.calls : 0),
      avgRiskScore: roundMetric(stats.riskScores.length ? mean(stats.riskScores) : 0)
    }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 8);

  return {
    sampleCount: scoped.length,
    successRate: roundMetric(successRate),
    avgUserFeedback: roundMetric(satisfaction),
    avgSafetyIncidents: roundMetric(safetyIncidents),
    avgLatencyMs: latencyValues.length ? roundMetric(mean(latencyValues), 2) : null,
    avgCostUsd: costValues.length ? roundMetric(mean(costValues), 4) : null,
    topTools
  };
}

function buildTriggerStatus(state, onlineCfg, now = Date.now()) {
  const trajectoriesSeen = state.trajectories.length;
  const missingForMinTrajectories = Math.max(
    0,
    onlineCfg.minTrajectoriesForEvolution - trajectoriesSeen
  );
  const trajectoriesSinceLastEvolution = Math.max(
    0,
    trajectoriesSeen - state.lastEvolutionTrajectoryCount
  );
  const missingForInterval = Math.max(
    0,
    onlineCfg.evolveEveryTrajectories - trajectoriesSinceLastEvolution
  );
  const elapsedSinceLastEvolutionMs =
    state.lastEvolutionAt > 0 ? Math.max(0, now - state.lastEvolutionAt) : null;
  const cooldownRemainingMs =
    state.lastEvolutionAt > 0
      ? Math.max(0, onlineCfg.cooldownMs - (elapsedSinceLastEvolutionMs || 0))
      : 0;

  const blockedBy = [];
  if (!onlineCfg.enabled) blockedBy.push("online_disabled");
  if (state.evolutionInFlight) blockedBy.push("evolution_in_flight");
  if (missingForMinTrajectories > 0) blockedBy.push("waiting_min_trajectories");
  if (missingForMinTrajectories === 0 && missingForInterval > 0) blockedBy.push("waiting_interval");
  if (cooldownRemainingMs > 0) blockedBy.push("cooldown");

  return {
    ready: blockedBy.length === 0,
    blockedBy,
    nextReason: blockedBy[0] || "ready",
    trajectoriesSeen,
    minTrajectoriesForEvolution: onlineCfg.minTrajectoriesForEvolution,
    missingForMinTrajectories,
    trajectoriesSinceLastEvolution,
    evolveEveryTrajectories: onlineCfg.evolveEveryTrajectories,
    missingForInterval,
    trajectoriesUntilReady: Math.max(missingForMinTrajectories, missingForInterval),
    cooldownMs: onlineCfg.cooldownMs,
    elapsedSinceLastEvolutionMs,
    cooldownRemainingMs,
    evolutionInFlight: Boolean(state.evolutionInFlight)
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
    reflectionMinibatchSize: engine?.gepa?.reflectionMinibatchSize ?? 2,
    useMerge: engine?.gepa?.useMerge ?? false
  };

  const onlineCfg = {
    enabled: online?.enabled ?? true,
    minTrajectoriesForEvolution: online?.minTrajectoriesForEvolution ?? 12,
    evolveEveryTrajectories: online?.evolveEveryTrajectories ?? 4,
    cooldownMs: online?.cooldownMs ?? 20_000,
    windowSize: online?.windowSize ?? 400,
    holdoutRatio: online?.holdoutRatio ?? 0.2,
    minHoldout: online?.minHoldout ?? 3,
    generations: online?.generations ?? 3,
    populationSize: online?.populationSize ?? 8,
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
    manualEvolutionInFlight: null,
    activeManualRun: null,
    previousChampion: null,
    baselineEvaluation: null,
    events: [],
    runHistory: [],
    mode: "python-sidecar"
  };
  const EVENT_LIMIT = 1000;
  const RUN_HISTORY_LIMIT = 250;

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

  function recordEvent(event) {
    const entry = {
      at: Date.now(),
      ...event
    };
    state.events.push(entry);
    if (state.events.length > EVENT_LIMIT) {
      state.events.splice(0, state.events.length - EVENT_LIMIT);
    }
    return entry;
  }

  function recordRun(runSummary) {
    state.runHistory.push(runSummary);
    if (state.runHistory.length > RUN_HISTORY_LIMIT) {
      state.runHistory.splice(0, state.runHistory.length - RUN_HISTORY_LIMIT);
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
      recordEvent({
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

  async function runOnlineEvolution(triggerSnapshot = null) {
    const snapshot = [...state.trajectories];
    const { train, holdout } = splitTrainHoldout(
      snapshot,
      onlineCfg.holdoutRatio,
      onlineCfg.minHoldout
    );
    if (train.length < 2) return null;

    const runId = id("evo");
    const startedAt = Date.now();
    const triggerAtStart = triggerSnapshot || buildTriggerStatus(state, onlineCfg, startedAt);
    recordEvent({
      type: "evolution_start",
      source: "online",
      runId,
      trigger: triggerAtStart,
      trainSize: train.length,
      holdoutSize: holdout.length,
      generations: onlineCfg.generations,
      populationSize: onlineCfg.populationSize
    });

    const incumbentGenome = state.champion;

    const seedGenome =
      incumbentGenome ??
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
    const incumbentEval = incumbentGenome
      ? evaluateGenome(incumbentGenome, validationSet, objectiveWeights)
      : null;

    const gate = shouldPromoteCandidate({
      candidateEval,
      incumbentEval,
      promotion: onlineCfg.promotion
    });
    const policyDiff = summarizePolicyDiff(incumbentGenome, run.champion);

    if (gate.promote) {
      if (incumbentGenome) state.previousChampion = incumbentGenome;
      state.champion = run.champion;
      state.baselineEvaluation = candidateEval;
      recordEvent({
        type: "promotion",
        source: "online",
        runId,
        reason: gate.reason,
        policyId: run.champion.id,
        candidateEval,
        incumbentEval,
        policyDiff
      });
    } else {
      recordEvent({
        type: "rejection",
        source: "online",
        runId,
        reason: gate.reason,
        gate
      });
    }

    const completedAt = Date.now();
    const runSummary = {
      runId,
      source: "online",
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      trainSize: train.length,
      holdoutSize: holdout.length,
      promoted: gate.promote,
      reason: gate.reason,
      championId: run.champion.id,
      candidateAggregate: roundMetric(candidateEval.aggregateScore),
      incumbentAggregate: roundMetric(incumbentEval?.aggregateScore),
      gate: structuredClone(gate),
      policyDiff: gate.promote ? policyDiff : null
    };
    recordRun(runSummary);
    recordEvent({
      type: "evolution_complete",
      source: "online",
      runId,
      promoted: gate.promote,
      reason: gate.reason,
      policyId: run.champion.id,
      durationMs: runSummary.durationMs
    });

    state.lastRun = {
      ...run,
      runId,
      source: "online",
      startedAt,
      completedAt,
      durationMs: runSummary.durationMs,
      online: {
        trainSetSize: train.length,
        holdoutSetSize: holdout.length,
        validationSetSize: validationSet.length,
        candidateEval,
        incumbentEval,
        gate,
        promoted: gate.promote,
        policyDiff,
        triggerAtStart
      }
    };
    state.lastEvolutionAt = completedAt;
    state.lastEvolutionTrajectoryCount = state.trajectories.length;
    return state.lastRun;
  }

  function maybeScheduleOnlineEvolution() {
    const trigger = buildTriggerStatus(state, onlineCfg, Date.now());
    if (!trigger.ready) return;

    state.evolutionInFlight = runOnlineEvolution(trigger)
      .catch((error) => {
        recordEvent({
          type: "error",
          source: "online",
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
      runHistory: structuredClone(state.runHistory),
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
    state.events = Array.isArray(snapshot.events) ? snapshot.events.slice(-EVENT_LIMIT) : [];
    state.runHistory = Array.isArray(snapshot.runHistory)
      ? snapshot.runHistory.slice(-RUN_HISTORY_LIMIT)
      : [];
    state.mode = typeof snapshot.mode === "string" ? snapshot.mode : state.mode;
    state.evolutionInFlight = null;
    state.manualEvolutionInFlight = null;
    state.activeManualRun = null;
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

    getDiagnostics() {
      const trigger = buildTriggerStatus(state, onlineCfg, Date.now());
      const lastRunSummary = state.runHistory[state.runHistory.length - 1] || null;
      const latestPromotion = [...state.runHistory].reverse().find((run) => run.promoted) || null;
      return {
        mode: state.mode,
        hasChampion: Boolean(state.champion),
        championId: state.champion?.id || null,
        previousChampionId: state.previousChampion?.id || null,
        trajectoryCount: state.trajectories.length,
        lastEvolutionAt: state.lastEvolutionAt || null,
        lastEvolutionTrajectoryCount: state.lastEvolutionTrajectoryCount,
        onlineConfig: structuredClone(onlineCfg),
        trigger,
        recentWindowMetrics: summarizeTrajectoryWindow(state.trajectories, 50),
        lastRun: structuredClone(lastRunSummary),
        lastRunDetails: state.lastRun ? structuredClone(state.lastRun) : null,
        recentRuns: structuredClone(state.runHistory.slice(-10)),
        recentEvents: structuredClone(state.events.slice(-25)),
        activeManualRun: state.activeManualRun ? structuredClone(state.activeManualRun) : null,
        latestPromotionDiff: latestPromotion?.policyDiff
          ? structuredClone(latestPromotion.policyDiff)
          : null,
        currentPatch: state.champion ? policyToConfigPatch(state.champion) : null
      };
    },

    exportState,
    restoreState,

    async evolve({ generations = 3, populationSize = 8 } = {}) {
      if (state.manualEvolutionInFlight) {
        return state.manualEvolutionInFlight;
      }
      if (state.evolutionInFlight) {
        await state.evolutionInFlight;
      }

      const runId = id("manual");
      const startedAt = Date.now();
      state.activeManualRun = {
        runId,
        startedAt,
        generations,
        populationSize
      };

      const manualRunPromise = (async () => {
        recordEvent({
          type: "evolution_start",
          source: "manual",
          runId,
          trainSize: state.trajectories.length,
          holdoutSize: 0,
          generations,
          populationSize
        });

        const incumbentGenome = state.champion;
        const seedGenome =
          incumbentGenome ??
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
        const evaluationSet = state.trajectories;
        const candidateEval = evaluateGenome(run.champion, evaluationSet, objectiveWeights);
        const incumbentEval = incumbentGenome
          ? evaluateGenome(incumbentGenome, evaluationSet, objectiveWeights)
          : null;
        const policyDiff = summarizePolicyDiff(incumbentGenome, run.champion);
        if (incumbentGenome) state.previousChampion = incumbentGenome;
        state.champion = run.champion;
        state.baselineEvaluation = candidateEval;

        const completedAt = Date.now();
        const runSummary = {
          runId,
          source: "manual",
          startedAt,
          completedAt,
          durationMs: completedAt - startedAt,
          trainSize: state.trajectories.length,
          holdoutSize: 0,
          promoted: true,
          reason: "manual_force_run",
          championId: run.champion.id,
          candidateAggregate: roundMetric(candidateEval.aggregateScore),
          incumbentAggregate: roundMetric(incumbentEval?.aggregateScore),
          gate: {
            promote: true,
            reason: "manual_force_run"
          },
          policyDiff
        };
        recordRun(runSummary);
        recordEvent({
          type: "promotion",
          source: "manual",
          runId,
          reason: "manual_force_run",
          policyId: run.champion.id,
          candidateEval,
          incumbentEval,
          policyDiff
        });
        recordEvent({
          type: "evolution_complete",
          source: "manual",
          runId,
          promoted: true,
          reason: "manual_force_run",
          policyId: run.champion.id,
          durationMs: runSummary.durationMs
        });

        state.lastRun = {
          ...run,
          runId,
          source: "manual",
          startedAt,
          completedAt,
          durationMs: runSummary.durationMs,
          online: {
            trainSetSize: state.trajectories.length,
            holdoutSetSize: 0,
            validationSetSize: state.trajectories.length,
            candidateEval,
            incumbentEval,
            gate: {
              promote: true,
              reason: "manual_force_run"
            },
            promoted: true,
            policyDiff
          }
        };
        state.lastEvolutionAt = completedAt;
        state.lastEvolutionTrajectoryCount = state.trajectories.length;
        return state.lastRun;
      })();

      state.manualEvolutionInFlight = manualRunPromise;
      state.evolutionInFlight = manualRunPromise;
      try {
        return await manualRunPromise;
      } finally {
        if (state.manualEvolutionInFlight === manualRunPromise) {
          state.manualEvolutionInFlight = null;
        }
        if (state.evolutionInFlight === manualRunPromise) {
          state.evolutionInFlight = null;
        }
        if (state.activeManualRun?.runId === runId) {
          state.activeManualRun = null;
        }
      }
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
