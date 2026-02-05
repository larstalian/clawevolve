# ClawEvolve

ClawEvolve is an online policy-evolution layer for OpenClaw agents.

It uses official Python GEPA to optimize deployable agent policy artifacts from real session telemetry, then safely promotes or rolls back those policies in production.

Most agent stacks are static after deployment. ClawEvolve makes them adaptive without touching model weights.

GEPA references:
- Paper: https://arxiv.org/abs/2507.19457
- Docs: https://gepa-ai.github.io/gepa/
- Repo: https://github.com/gepa-ai/gepa

ClawEvolve evolves:
- Prompt policy (`systemPrompt`, `responseStyle`)
- Tool policy (`toolPreferences`, risk thresholds, disallowed tools)
- Execution policy (`toolRetryBudget`, `deliberationBudget`, `memoryDepth`)

ClawEvolve does not change:
- Underlying foundation model weights
- OpenClaw core runtime

## Architecture and Runtime Flow

1. OpenClaw hooks collect trajectory telemetry from real runs.
2. Trajectories are kept in a rolling in-memory window.
3. On schedule, the plugin calls the sidecar (`POST /v1/evolve`).
4. Sidecar runs official `gepa.optimize(...)` and returns a candidate champion.
5. Plugin applies holdout-based promotion gates.
6. If live quality drops, rollback restores the previous champion.
7. State is persisted across restarts via OpenClaw `stateDir`.

## GEPA Mapping and Extensions

GEPA-native pieces:
- Official `gepa.optimize(...)` execution in Python
- Reflection model + candidate selection strategy (`pareto`/`aggregate`)
- Reflection minibatch, merge, metric-budget, and seed controls

ClawEvolve-specific pieces:
- Continuous online triggering from runtime telemetry (not just static offline batch optimization)
- External production gates before promotion (`aggregate lift`, `safety drop`, `success drop`, `min safety`)
- Live rollback monitoring after promotion
- OpenClaw-oriented policy artifact output (config patch), not model retraining

## Safety and Promotion Controls

Before promotion, a candidate must pass holdout gates.

Default gate/rollback thresholds:
- Promotion: `minAggregateLift=0.003`
- Promotion: `maxSafetyDrop=0.02`
- Promotion: `maxSuccessDrop=0.03`
- Promotion: `minSafety=0.65`
- Rollback: enabled
- Rollback trigger: aggregate drop `> 0.05` or safety drop `> 0.05` on live monitor window

Runtime safeguards:
- `disallowedTools` hard blocklist
- `maxRiskScore` threshold for tool usage
- Optional tool-specific risk mapping via telemetry config

## Telemetry Contract

Preferred path: OpenClaw passes a full trajectory on `session_end`.

If `session_end` does not include a trajectory, ClawEvolve synthesizes one from official lifecycle hooks:
- `before_agent_start`
- `before_tool_call`
- `after_tool_call`
- `agent_end`

No synthetic cost or synthetic user-feedback values are injected.

Example trajectory:

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

## OpenClaw Integration

Plugin id: `claw-evolve`

Operational surfaces:
- Gateway: `claw_evolve_status`
- Gateway: `claw_evolve_report`
- Gateway: `claw_evolve_force_run`
- Gateway: `claw_evolve_export_patch`
- Command: `claw-evolve-status`

Persisted state:
- `<stateDir>/claw-evolve-state.v1.json`

Minimal plugin config:

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
          "engine": {
            "type": "python-sidecar",
            "sidecar": {
              "baseUrl": "http://127.0.0.1:8091",
              "apiKeyEnv": "CLAW_EVOLVE_SIDECAR_API_KEY"
            },
            "gepa": {
              "reflectionLm": "openai/gpt-5-mini",
              "candidateSelectionStrategy": "pareto"
            }
          },
          "online": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

## Sidecar API

- `GET /healthz`
- `POST /v1/evolve`

If sidecar env `CLAW_EVOLVE_SIDECAR_API_KEY` is set, callers must send:

`Authorization: Bearer <token>`

## Default Configuration

| Area | Setting | Default |
| --- | --- | --- |
| Online | `minTrajectoriesForEvolution` | `12` |
| Online | `evolveEveryTrajectories` | `4` |
| Online | `cooldownMs` | `20000` |
| Online | `windowSize` | `400` |
| Online | `holdoutRatio` | `0.2` |
| Online | `minHoldout` | `3` |
| Online | `generations` | `6` |
| Online | `populationSize` | `18` |
| Sidecar | `timeoutMs` | `45000` |
| Sidecar | `retries` | `1` |
| Sidecar | `maxPayloadTrajectories` | `800` |

## Repository Structure

- `plugin/index.js`: OpenClaw plugin registration, hooks, gateway methods, command, persistence
- `src/openclawAdapter.js`: online orchestration, holdout gating, rollback
- `src/evolutionEngines.js`: JS-to-sidecar transport, retries, payload shaping
- `src/cli.js`: local telemetry replay demo
- `sidecar/app.py`: FastAPI sidecar running official GEPA
- `openclaw.plugin.json`: plugin manifest and config schema

## Setup and Local Development

### Prerequisites
- Node.js 18+
- Docker (recommended) or Python 3.11+
- `OPENAI_API_KEY`
- Optional `CLAW_EVOLVE_SIDECAR_API_KEY`

### Install dependencies and run tests
```bash
npm install
npm test
```

### Start sidecar (Docker)
```bash
export OPENAI_API_KEY=your-openai-key
export CLAW_EVOLVE_SIDECAR_API_KEY=your-sidecar-token # optional
docker compose -f docker-compose.sidecar.yml up --build
```

### Start sidecar (local Python)
```bash
cd sidecar
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY=your-openai-key
export CLAW_EVOLVE_SIDECAR_API_KEY=your-sidecar-token # optional
uvicorn app:app --host 0.0.0.0 --port 8091
```

### Run the telemetry demo
```bash
export CLAW_EVOLVE_SIDECAR_API_KEY=your-sidecar-token # only if auth is enabled
npm run evolve:demo
```

Direct CLI:
```bash
node src/cli.js \
  --input examples/telemetry.json \
  --engine python-sidecar \
  --sidecarBaseUrl http://127.0.0.1:8091
```

### Install plugin in OpenClaw
```bash
openclaw plugins install .
openclaw plugins enable claw-evolve
```
