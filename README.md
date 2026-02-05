# ClawEvolve

Online policy evolution for OpenClaw agents, powered by GEPA in a Python sidecar.

ClawEvolve learns from session telemetry and continuously updates deployable policy artifacts (prompt behavior, tool routing, safety limits) without fine-tuning model weights.

## Quick Start

### Prerequisites
- Node.js 18+
- Docker (recommended) or Python 3.11+
- `OPENAI_API_KEY` for GEPA reflection calls
- Optional sidecar auth token: `CLAW_EVOLVE_SIDECAR_API_KEY`

### 1) Install and verify
```bash
npm install
npm test
```

### 2) Start the GEPA sidecar
```bash
export OPENAI_API_KEY=your-openai-key
export CLAW_EVOLVE_SIDECAR_API_KEY=your-sidecar-token # optional
docker compose -f docker-compose.sidecar.yml up --build
```

Health check:
```bash
curl http://127.0.0.1:8091/healthz
```

### 3) Run a local evolution demo
```bash
export CLAW_EVOLVE_SIDECAR_API_KEY=your-sidecar-token # only if auth is enabled
npm run evolve:demo
```

Equivalent direct command:
```bash
node src/cli.js \
  --input examples/telemetry.json \
  --engine python-sidecar \
  --sidecarBaseUrl http://127.0.0.1:8091
```

## Install As OpenClaw Plugin

```bash
openclaw plugins install .
openclaw plugins enable claw-evolve
```

Minimal working plugin config:

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

## Runtime Flow

1. OpenClaw hooks collect trajectory telemetry.
2. Trajectories are stored in a rolling window.
3. The plugin calls the Python sidecar (`POST /v1/evolve`) on schedule.
4. Sidecar runs official `gepa.optimize(...)`.
5. Candidate policy is validated on holdout data before promotion.
6. Live rollback reverts to the prior champion if metrics regress.
7. State persists at `<stateDir>/claw-evolve-state.v1.json`.

## Key Defaults

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
| Promotion gate | `minAggregateLift` | `0.003` |
| Promotion gate | `maxSafetyDrop` | `0.02` |
| Promotion gate | `maxSuccessDrop` | `0.03` |
| Promotion gate | `minSafety` | `0.65` |
| Rollback | `enabled` | `true` |
| Rollback | `monitorWindow` | `60` |
| Rollback | `minSamples` | `20` |
| Rollback | `maxAggregateDrop` | `0.05` |
| Rollback | `maxSafetyDrop` | `0.05` |
| Sidecar | `timeoutMs` | `45000` |
| Sidecar | `retries` | `1` |
| Sidecar | `maxPayloadTrajectories` | `800` |

## Telemetry Contract

Preferred input is a full trajectory at `session_end`:

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

If `session_end` does not include a trajectory, ClawEvolve synthesizes one from hook payloads (`before_agent_start`, `before_tool_call`, `after_tool_call`, `agent_end`) using observed values.

## Sidecar API

- `GET /healthz`
- `POST /v1/evolve`

If sidecar env `CLAW_EVOLVE_SIDECAR_API_KEY` is set, requests must send:

`Authorization: Bearer <token>`

## Operational Interfaces

- Gateway methods:
  `claw_evolve_status`, `claw_evolve_force_run`, `claw_evolve_export_patch`
- Command:
  `claw-evolve-status`

## GEPA Alignment

Implemented directly with GEPA:
- Official Python `gepa.optimize(...)`
- Candidate selection strategy (`pareto` or `aggregate`)
- Reflection minibatching, merge controls, metric budget, and seed controls

ClawEvolve adds:
- Continuous online triggering from live telemetry
- External promotion gates + live rollback safety controls
- OpenClaw policy patch output instead of model training

References:
- GEPA paper: https://arxiv.org/abs/2507.19457
- GEPA docs: https://gepa-ai.github.io/gepa/

## Development

Run tests:
```bash
npm test
```

## Project Structure

- `plugin/index.js`: OpenClaw integration layer (hooks, gateway methods, command, persistence)
- `src/openclawAdapter.js`: evolution orchestration, promotion gate, rollback
- `src/evolutionEngines.js`: JS -> sidecar transport with retries/timeouts
- `src/cli.js`: local telemetry replay and one-shot evolution
- `sidecar/app.py`: GEPA adapter and FastAPI server
- `openclaw.plugin.json`: plugin manifest and config schema
