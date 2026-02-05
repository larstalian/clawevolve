#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawEvolutionService } from "./openclawAdapter.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    throw new Error("Missing --input <telemetry.json>");
  }
  if (args.engine && args.engine !== "python-sidecar") {
    throw new Error('Only "--engine python-sidecar" is supported');
  }

  const raw = await fs.readFile(path.resolve(args.input), "utf8");
  const trajectories = JSON.parse(raw);

  const toolNames = Array.from(
    new Set(trajectories.flatMap((t) => (t.toolCalls || []).map((c) => c.toolName)))
  );

  const service = createOpenClawEvolutionService({
    baseModel: args.model || "gpt-5-mini",
    basePrompt:
      args.prompt ||
      "You are a high-reliability assistant. Prioritize user outcomes and safe tool usage.",
    toolNames,
    safeguards: {
      maxRiskScore: 0.55,
      disallowedTools: []
    },
    engine: {
      type: "python-sidecar",
      sidecar: {
        baseUrl: args.sidecarBaseUrl || "http://127.0.0.1:8091",
        apiKey: args.sidecarApiKey,
        apiKeyEnv: args.sidecarApiKeyEnv || "CLAW_EVOLVE_SIDECAR_API_KEY",
        timeoutMs: Number(args.sidecarTimeoutMs || 45000),
        retries: Number(args.sidecarRetries || 1)
      },
      gepa: {
        reflectionLm: args.reflectionModel || "openai/gpt-5-mini",
        candidateSelectionStrategy: args.selection || "pareto",
        reflectionMinibatchSize: Number(args.reflectionMinibatchSize || 3),
        useMerge: args.useMerge !== "false",
        maxMetricCalls: args.maxMetricCalls ? Number(args.maxMetricCalls) : undefined
      }
    }
  });

  for (const trajectory of trajectories) service.ingestTrajectory(trajectory);

  const result = await service.evolve({
    generations: Number(args.generations || 8),
    populationSize: Number(args.population || 20)
  });

  const output = {
    championEvaluation: result.championEvaluation,
    history: result.history,
    patch: service.exportPatch()
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
