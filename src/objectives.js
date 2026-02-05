import { clamp, mean } from "./utils.js";

function normalizedCost(costUsd) {
  // 0.15 USD per trajectory is treated as expensive for scoring.
  return clamp(1 - costUsd / 0.15, 0, 1);
}

function normalizedLatency(latencyMs) {
  // 20s is treated as worst acceptable latency for interactive agent use.
  return clamp(1 - latencyMs / 20000, 0, 1);
}

function metricOrNeutral(rawValue, normalizer) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return 0.5;
  return normalizer(value);
}

function styleScore(style) {
  if (style === "balanced") return 1;
  if (style === "concise") return 0.95;
  return 0.9;
}

function deliberationPenalty(deliberationBudget) {
  return clamp(deliberationBudget / 10, 0, 0.3);
}

function memoryPenalty(memoryDepth) {
  return clamp(memoryDepth / 100, 0, 0.2);
}

function toolFitnessForTrajectory(trajectory, genome) {
  if (!trajectory.toolCalls?.length) return 0.5;

  const scores = trajectory.toolCalls.map((call) => {
    const pref = genome.toolPreferences[call.toolName] ?? 0.01;
    const successBoost = call.success ? 1 : -0.7;
    const callRisk = clamp(Number(call.riskScore ?? 0), 0, 1);
    const baselineRiskPenalty = -0.5 * callRisk;
    const riskPenalty =
      callRisk > genome.safeguards.maxRiskScore
        ? -0.8
        : 0;
    return pref * (1 + successBoost + baselineRiskPenalty + riskPenalty);
  });

  const raw = mean(scores);
  return clamp((raw + 1) / 2, 0, 1);
}

export function evaluateGenome(genome, trajectories, weights = {}) {
  const objectiveWeights = {
    success: weights.success ?? 0.3,
    satisfaction: weights.satisfaction ?? 0.2,
    safety: weights.safety ?? 0.25,
    toolReliability: weights.toolReliability ?? 0.15,
    efficiency: weights.efficiency ?? 0.1
  };

  const successRate = mean(trajectories.map((t) => (t.success ? 1 : 0)));
  const satisfaction = clamp((mean(trajectories.map((t) => t.userFeedback ?? 0)) + 1) / 2, 0, 1);
  const safety = clamp(
    1 - mean(trajectories.map((t) => Math.min(1, (t.safetyIncidents ?? 0) / 3))),
    0,
    1
  );
  const toolReliability = mean(trajectories.map((t) => toolFitnessForTrajectory(t, genome)));
  const costScore = mean(trajectories.map((t) => metricOrNeutral(t.costUsd, normalizedCost)));
  const latencyScore = mean(trajectories.map((t) => metricOrNeutral(t.latencyMs, normalizedLatency)));
  const efficiency = clamp((costScore + latencyScore) / 2, 0, 1);

  const strategyPenalty =
    deliberationPenalty(genome.deliberationBudget) + memoryPenalty(genome.memoryDepth);

  const aggregate =
    objectiveWeights.success * successRate +
    objectiveWeights.satisfaction * satisfaction +
    objectiveWeights.safety * safety +
    objectiveWeights.toolReliability * toolReliability +
    objectiveWeights.efficiency * efficiency +
    0.05 * styleScore(genome.responseStyle) -
    strategyPenalty;

  return {
    objectives: {
      successRate,
      satisfaction,
      safety,
      toolReliability,
      efficiency
    },
    aggregateScore: clamp(aggregate, 0, 1)
  };
}

export function dominates(a, b) {
  const keys = ["successRate", "satisfaction", "safety", "toolReliability", "efficiency"];
  let atLeastOneStrictlyBetter = false;
  for (const key of keys) {
    if (a.objectives[key] < b.objectives[key]) return false;
    if (a.objectives[key] > b.objectives[key]) atLeastOneStrictlyBetter = true;
  }
  return atLeastOneStrictlyBetter;
}

export function paretoSort(scoredPopulation) {
  const fronts = [];
  const remaining = [...scoredPopulation];

  while (remaining.length > 0) {
    const front = [];
    for (const candidate of remaining) {
      const dominated = remaining.some(
        (other) =>
          other.genome.id !== candidate.genome.id && dominates(other.evaluation, candidate.evaluation)
      );
      if (!dominated) front.push(candidate);
    }
    fronts.push(front);
    const frontIds = new Set(front.map((c) => c.genome.id));
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (frontIds.has(remaining[i].genome.id)) {
        remaining.splice(i, 1);
      }
    }
  }

  return fronts;
}
