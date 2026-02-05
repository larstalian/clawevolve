# ClawEvolve

ClawEvolve is an OpenClaw plugin plus Python sidecar that evolves agent policy online from real runtime telemetry using official GEPA (`gepa.optimize(...)`).

It optimizes policy artifacts (prompt, tool routing, safety thresholds, execution budgets), not model weights.

## What This Repo Contains
- OpenClaw plugin (`plugin/index.js`) that collects trajectories, applies champion policy, and manages promotion/rollback.
- JS evolution service (`src/openclawAdapter.js`) that drives online triggering, holdout gating, and state snapshots.
- Python GEPA sidecar (`sidecar/app.py`) that runs official GEPA optimization and returns champion candidates.
- CLI demo (`src/cli.js`) for local replay on telemetry JSON.

## End-To-End Flow
1. Runtime hooks collect telemetry (`before_agent_start`, `before_tool_call`, `after_tool_call`, `agent_end`, `session_end`).
2. Trajectories are stored in a rolling window.
3. When thresholds are hit, the plugin calls `POST /v1/evolve` on the Python sidecar.
4. Sidecar runs `gepa.optimize(...)` and returns a candidate champion with metrics.
5. Plugin validates candidate on holdout trajectories and promotes only if gates pass.
6. Live rollback can revert to the previous champion if aggregate/safety regression is detected.
7. State is persisted to OpenClaw `stateDir` as `claw-evolve-state.v1.json`.

## Quick Start

### 1) Prerequisites
- Node.js 18+ (for native `fetch`, `structuredClone`, and `node --test`)
- Docker (recommended) or Python 3.11+ for the sidecar
- `OPENAI_API_KEY` for GEPA reflection model calls
- Optional `CLAW_EVOLVE_SIDECAR_API_KEY` if you want sidecar auth

### 2) Install and sanity check
```bash
npm install
npm test
```

### 3) Start the Python sidecar
Option A: Docker Compose from repo root
```bash
export OPENAI_API_KEY=your-openai-key
export CLAW_EVOLVE_SIDECAR_API_KEY=your-sidecar-token # optional
docker compose -f docker-compose.sidecar.yml up --build
```

Option B: Run sidecar directly
```bash
cd sidecar
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY=your-openai-key
export CLAW_EVOLVE_SIDECAR_API_KEY=your-sidecar-token # optional
uvicorn app:app --host 0.0.0.0 --port 8091
```

Health check:
```bash
curl http://127.0.0.1:8091/healthz
```

### 4) Run demo evolution from telemetry JSON
```bash
export CLAW_EVOLVE_SIDECAR_API_KEY=your-sidecar-token # only if sidecar auth enabled
npm run evolve:demo
```

Equivalent direct command:
```bash
node src/cli.js \
  --input examples/telemetry.json \
  --engine python-sidecar \
  --sidecarBaseUrl http://127.0.0.1:8091
```

### 5) Install and enable the OpenClaw plugin
```bash
openclaw plugins install .
openclaw plugins enable claw-evolve
```

### 6) Troubleshooting install validation errors
If you see:
- `must have required property 'baseModel'`
- `must have required property 'basePrompt'`

you likely have a stale previously installed copy of `claw-evolve` with an older schema.

Fix:
```bash
mv ~/.openclaw/extensions/claw-evolve ~/.openclaw/claw-evolve.bak.$(date +%s) 2>/dev/null || true
openclaw plugins install .
openclaw plugins enable claw-evolve
```

Important:
- Do not leave backup folders under `~/.openclaw/extensions/`; OpenClaw scans that directory for plugins.
- Keep backups outside `~/.openclaw/extensions/` (as in the command above).

## OpenClaw Config (Practical Example)
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
          "safeguards": {
            "maxRiskScore": 0.55,
            "disallowedTools": ["prod_delete"]
          },
          "objectiveWeights": {
            "success": 0.3,
            "satisfaction": 0.2,
            "safety": 0.25,
            "toolReliability": 0.15,
            "efficiency": 0.1
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
            "cooldownMs": 20000,
            "windowSize": 400,
            "holdoutRatio": 0.2,
            "minHoldout": 3,
            "generations": 6,
            "populationSize": 18
          },
          "engine": {
            "type": "python-sidecar",
            "sidecar": {
              "baseUrl": "http://127.0.0.1:8091",
              "apiKeyEnv": "CLAW_EVOLVE_SIDECAR_API_KEY",
              "timeoutMs": 45000,
              "retries": 1,
              "maxPayloadTrajectories": 800
            },
            "gepa": {
              "reflectionLm": "openai/gpt-5-mini",
              "candidateSelectionStrategy": "pareto",
              "reflectionMinibatchSize": 3,
              "useMerge": true,
              "maxMergeInvocations": 5,
              "seed": 0
            }
          }
        }
      }
    }
  }
}
```

## Default Runtime Behavior
- Online evolution defaults:
  `minTrajectoriesForEvolution=12`, `evolveEveryTrajectories=4`, `cooldownMs=20000`, `windowSize=400`.
- Promotion gate defaults:
  `minAggregateLift=0.003`, `maxSafetyDrop=0.02`, `maxSuccessDrop=0.03`, `minSafety=0.65`.
- Rollback defaults:
  enabled, `monitorWindow=60`, `minSamples=20`, rollback on aggregate drop `> 0.05` or safety drop `> 0.05`.
- Sidecar request trimming:
  trajectories are capped to `maxPayloadTrajectories` (default `800`) before POSTing.

## Telemetry Contract
Preferred input is full trajectory on `session_end`:
```json
{
  "id": "traj_123",
  "success": true,
  "userFeedback": 0.6,
  "latencyMs": 1400,
  "costUsd": 0.02,
  "safetyIncidents": 0,
  "toolCalls": [
    { "toolName": "docs_search", "success": true, "latencyMs": 350, "riskScore": 0.1 }
  ]
}
```

If `session_end` does not provide a trajectory, the plugin synthesizes one from lifecycle hooks using observed runtime data only.

## Sidecar API
- `GET /healthz`
- `POST /v1/evolve`

Auth behavior:
- If sidecar env `CLAW_EVOLVE_SIDECAR_API_KEY` is set, caller must send `Authorization: Bearer <token>`.
- Plugin can send this via `engine.sidecar.apiKey` or `engine.sidecar.apiKeyEnv` (default `CLAW_EVOLVE_SIDECAR_API_KEY`).

## Operational Surfaces
- Gateway methods:
  `claw_evolve_status`, `claw_evolve_force_run`, `claw_evolve_export_patch`
- Command:
  `claw-evolve-status`
- Persisted state file:
  `<stateDir>/claw-evolve-state.v1.json`

## GEPA Mapping (Short Version)
What is directly GEPA:
- Official Python `gepa.optimize(...)`
- Candidate selection strategy (`pareto`/`aggregate`)
- Reflection minibatch controls, merge controls, metric budget, seed

What is ClawEvolve-specific:
- Continuous online triggers from rolling telemetry
- Holdout promotion gates and live rollback
- OpenClaw policy patch artifact (not model fine-tuning)

References:
- GEPA paper: https://arxiv.org/abs/2507.19457
- GEPA docs: https://gepa-ai.github.io/gepa/

## Repo Map
- `plugin/index.js`: OpenClaw integration, hook wiring, gateway/command registration, state persistence
- `src/openclawAdapter.js`: evolution service, promotion gate, rollback logic
- `src/evolutionEngines.js`: sidecar transport, retries, payload shaping
- `src/cli.js`: local telemetry replay and forced evolution run
- `sidecar/app.py`: GEPA adapter + FastAPI sidecar
- `openclaw.plugin.json`: plugin manifest/config schema
