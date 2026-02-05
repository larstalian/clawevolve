# ClawEvolve

ClawEvolve is an OpenClaw plugin that adds online personalization using the official Python GEPA optimizer running in an isolated sidecar.

## GEPA Reference
1. Original paper: https://arxiv.org/html/2507.19457v1
2. GEPA docs/API: https://gepa-ai.github.io/gepa/

## Architecture
1. OpenClaw plugin ingests session trajectories and applies champion policy at runtime.
2. Plugin calls Python sidecar over HTTP for each evolution cycle.
3. Sidecar runs `gepa.optimize(...)` and returns champion policy candidate.
4. Plugin validates on holdout, promotes with gates, and rolls back on live regression.
5. Plugin persists champion + trajectory window through OpenClaw `stateDir` on service stop/start.

## GEPA Mapping
Implemented from GEPA:
1. Official `gepa.optimize(...)` execution in Python sidecar.
2. GEPA adapter flow with `evaluate(...)` and reflective dataset construction.
3. GEPA controls exposed in config (`candidateSelectionStrategy`, `reflectionMinibatchSize`, `useMerge`, `maxMergeInvocations`, `maxMetricCalls`, `seed`).
4. Train/validation optimization per evolution run and best-candidate extraction.

Changed for OpenClaw online personalization:
1. GEPA runs are triggered continuously from a rolling online trajectory stream (not one static offline batch).
2. External champion promotion gates and live rollback are added around GEPA output.
3. Trajectories are built from OpenClaw runtime hooks and use observed telemetry only (no synthetic feedback/cost injection).
4. Policy artifact is an OpenClaw-oriented genome/config patch (prompt + tool policy + safeguards), not model weight updates.
5. No human-in-the-loop is required for standard operation.

Telemetry note:
- If your runtime does not provide a full trajectory object in `session_end`, the plugin synthesizes trajectories from standard OpenClaw hooks (`before_agent_start`, `before_tool_call`, `after_tool_call`, `agent_end`).

## Install Plugin
```bash
openclaw plugins install /home/talian/priv/ClawEvolve
```

## Start GEPA Sidecar
```bash
docker compose -f docker-compose.sidecar.yml up --build
```

## OpenClaw Config
```json
{
  "plugins": {
    "entries": {
      "claw-evolve": {
        "enabled": true,
        "config": {
          "baseModel": "gpt-5-mini",
          "basePrompt": "You are a reliable assistant.",
          "toolNames": ["docs_search", "sql_query", "deploy_exec"],
          "objectiveWeights": {
            "success": 0.3,
            "satisfaction": 0.2,
            "safety": 0.25,
            "toolReliability": 0.15,
            "efficiency": 0.1
          },
          "safeguards": {
            "maxRiskScore": 0.55,
            "disallowedTools": ["prod_delete"]
          },
          "telemetry": {
            "toolRiskScores": {
              "prod_delete": 0.95,
              "sql_query": 0.25,
              "docs_search": 0.1
            },
            "safetyIncidentRiskThreshold": 0.55,
            "errorCountsAsSafetyIncident": false
          },
          "online": {
            "enabled": true,
            "minTrajectoriesForEvolution": 12,
            "evolveEveryTrajectories": 4,
            "cooldownMs": 20000
          },
          "engine": {
            "type": "python-sidecar",
            "sidecar": {
              "baseUrl": "http://127.0.0.1:8091",
              "apiKeyEnv": "CLAW_EVOLVE_SIDECAR_API_KEY",
              "timeoutMs": 45000,
              "retries": 1
            },
            "gepa": {
              "reflectionLm": "openai/gpt-5-mini",
              "candidateSelectionStrategy": "pareto",
              "reflectionMinibatchSize": 3,
              "useMerge": true
            }
          }
        }
      }
    }
  }
}
```

## CLI Demo
Requires sidecar running.

```bash
CLAW_EVOLVE_SIDECAR_API_KEY=... node src/cli.js \
  --input examples/telemetry.json \
  --engine python-sidecar \
  --sidecarBaseUrl http://127.0.0.1:8091
```

## Online Evolution Behavior
1. Triggered automatically after enough new trajectories and cooldown.
2. Train/holdout split per run.
3. Promotion requires holdout gate pass.
4. Rollback occurs on live aggregate/safety regression.
5. State persists across process restarts when OpenClaw provides `stateDir`.

## Telemetry Semantics
1. For OpenClaw lifecycle hooks, the plugin only uses observed fields (`success`, `durationMs`, tool call outcomes, optional `costUsd`/`userFeedback`/`safetyIncidents` if provided by host/runtime).
2. It no longer injects synthetic cost or synthetic user-feedback values during trajectory synthesis.

## Files
1. `plugin/index.js`: OpenClaw plugin registration.
2. `src/openclawAdapter.js`: online orchestration, gating, rollback.
3. `src/evolutionEngines.js`: sidecar engine transport.
4. `sidecar/app.py`: official Python GEPA execution service.
5. `openclaw.plugin.json`: manifest + config schema.
