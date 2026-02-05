import { clamp, id, randomChoice } from "./utils.js";
import { RESPONSE_STYLES } from "./types.js";

export function createSeedGenome({
  baseModel,
  systemPrompt,
  toolNames,
  safeguards = {}
}) {
  const toolPreferences = {};
  const uniformWeight = toolNames.length ? 1 / toolNames.length : 1;
  for (const tool of toolNames) {
    toolPreferences[tool] = uniformWeight;
  }

  return {
    id: id("genome"),
    baseModel,
    systemPrompt,
    responseStyle: "balanced",
    toolPreferences,
    toolRetryBudget: 1,
    deliberationBudget: 2,
    memoryDepth: 6,
    safeguards: {
      maxRiskScore: safeguards.maxRiskScore ?? 0.5,
      disallowedTools: safeguards.disallowedTools ?? []
    },
    mutationTrace: ["seed"]
  };
}

function normalizeToolPreferences(toolPreferences) {
  const entries = Object.entries(toolPreferences);
  const sum = entries.reduce((acc, [, v]) => acc + Math.max(0, v), 0);
  if (sum <= 0) {
    const uniform = entries.length ? 1 / entries.length : 1;
    return Object.fromEntries(entries.map(([k]) => [k, uniform]));
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, Math.max(0, v) / sum]));
}

export function crossover(a, b) {
  const childToolPreferences = {};
  const keys = new Set([
    ...Object.keys(a.toolPreferences || {}),
    ...Object.keys(b.toolPreferences || {})
  ]);

  for (const key of keys) {
    childToolPreferences[key] =
      Math.random() < 0.5
        ? a.toolPreferences?.[key] ?? 0
        : b.toolPreferences?.[key] ?? 0;
  }

  return {
    ...a,
    id: id("genome"),
    systemPrompt: Math.random() < 0.5 ? a.systemPrompt : b.systemPrompt,
    responseStyle: Math.random() < 0.5 ? a.responseStyle : b.responseStyle,
    toolPreferences: normalizeToolPreferences(childToolPreferences),
    toolRetryBudget: Math.random() < 0.5 ? a.toolRetryBudget : b.toolRetryBudget,
    deliberationBudget: Math.random() < 0.5 ? a.deliberationBudget : b.deliberationBudget,
    memoryDepth: Math.random() < 0.5 ? a.memoryDepth : b.memoryDepth,
    safeguards: {
      maxRiskScore:
        Math.random() < 0.5
          ? a.safeguards.maxRiskScore
          : b.safeguards.maxRiskScore,
      disallowedTools: Array.from(
        new Set([
          ...(a.safeguards.disallowedTools || []),
          ...(b.safeguards.disallowedTools || [])
        ])
      )
    },
    mutationTrace: [...(a.mutationTrace || []), ...(b.mutationTrace || []), "crossover"]
  };
}

function mutatePrompt(prompt) {
  const mutations = [
    "Prioritize measurable task success and reliable tool usage.",
    "Use minimal tool calls; avoid speculative tool use.",
    "Escalate caution when uncertainty or risk is high.",
    "Explain critical decisions briefly before tool invocation."
  ];
  const selected = randomChoice(mutations);
  if (prompt.includes(selected)) return prompt;
  return `${prompt.trim()}\n- ${selected}`;
}

export function mutateGenome(parent, externalHint) {
  const next = structuredClone(parent);
  next.id = id("genome");

  const mutationTags = [];

  if (Math.random() < 0.7) {
    next.responseStyle = randomChoice(RESPONSE_STYLES);
    mutationTags.push("style");
  }

  if (Math.random() < 0.8) {
    next.toolRetryBudget = clamp(
      next.toolRetryBudget + (Math.random() < 0.5 ? -1 : 1),
      0,
      4
    );
    mutationTags.push("retry");
  }

  if (Math.random() < 0.8) {
    next.deliberationBudget = clamp(
      next.deliberationBudget + (Math.random() < 0.5 ? -1 : 1),
      1,
      6
    );
    mutationTags.push("deliberation");
  }

  if (Math.random() < 0.8) {
    next.memoryDepth = clamp(
      next.memoryDepth + (Math.random() < 0.5 ? -2 : 2),
      2,
      20
    );
    mutationTags.push("memory");
  }

  if (Math.random() < 0.9) {
    for (const toolName of Object.keys(next.toolPreferences)) {
      const delta = (Math.random() - 0.5) * 0.3;
      next.toolPreferences[toolName] = Math.max(
        0,
        next.toolPreferences[toolName] + delta
      );
    }
    next.toolPreferences = normalizeToolPreferences(next.toolPreferences);
    mutationTags.push("tool-weights");
  }

  if (Math.random() < 0.5) {
    next.safeguards.maxRiskScore = clamp(
      next.safeguards.maxRiskScore + (Math.random() - 0.5) * 0.2,
      0.05,
      0.95
    );
    mutationTags.push("risk-threshold");
  }

  if (Math.random() < 0.7) {
    next.systemPrompt = mutatePrompt(next.systemPrompt);
    mutationTags.push("prompt");
  }

  if (externalHint?.systemPromptAppend) {
    if (!next.systemPrompt.includes(externalHint.systemPromptAppend)) {
      next.systemPrompt += `\n- ${externalHint.systemPromptAppend}`;
      mutationTags.push("reflection-prompt");
    }
  }

  if (externalHint?.raiseRiskCaution) {
    next.safeguards.maxRiskScore = clamp(next.safeguards.maxRiskScore - 0.1, 0.05, 0.95);
    mutationTags.push("reflection-risk");
  }

  next.mutationTrace = [...(parent.mutationTrace || []), ...mutationTags];
  return next;
}

