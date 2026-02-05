# ClawEvolve Hackathon Delivery

## 1) 3-Minute Live Demo Script

### 0:00 - 0:30 Problem
"Most agents are static. They do not adapt tool behavior to each user over time. ClawEvolve adds safe, online policy evolution on top of proprietary-weight models."

### 0:30 - 1:10 What We Evolve
Show:
- Prompt policy (`systemPrompt`, `responseStyle`)
- Tool policy (`toolPreferences`, risk threshold)
- Execution policy (`retry`, `deliberation`, `memoryDepth`)

Say:
"We evolve policy artifacts, not model weights. That makes this compatible with closed APIs."

### 1:10 - 2:10 Live Run
Run:
```bash
npm test
docker compose -f docker-compose.sidecar.yml up --build -d
npm run evolve:demo
```

Point to output:
- `championEvaluation.objectives`
- `history` showing generation improvement
- `patch.agent` showing deployable evolved policy

### 2:10 - 2:45 Safety + Online Behavior
Say:
"This runs online from session telemetry. A candidate policy is promoted only if it passes holdout gates on aggregate lift and safety/success constraints. If live metrics regress, rollback restores the previous champion."

### 2:45 - 3:00 Close
"This is a self-improving policy layer for OpenClaw agents: better personalization, safer tool behavior, no model retraining."

---

## 2) Single-Slide Architecture Content

**Title:** `ClawEvolve: Online Evolution for OpenClaw Agents`

**Flow:**
1. User sessions + tool traces -> trajectory store
2. Python GEPA sidecar -> official `gepa.optimize(...)` over policy candidates
3. Multi-objective evaluator -> success, satisfaction, safety, efficiency
4. Promotion gate (holdout) -> promote only if lift + safety constraints pass
5. Runtime hooks apply champion policy:
   - `before_agent_start`
   - `before_tool_call`
   - `session_end`
6. Rollback monitor -> revert champion on live regression

**Why it matters:**
- Works with proprietary models
- Continuously personalized
- Safety-first deployment controls

---

## 3) Metrics Board (Baseline vs Champion)

Use this exact format during judging:

```json
{
  "baseline": {
    "successRate": 0.61,
    "satisfaction": 0.58,
    "safety": 0.81,
    "toolReliability": 0.54,
    "efficiency": 0.73,
    "aggregateScore": 0.59
  },
  "champion": {
    "successRate": 0.67,
    "satisfaction": 0.65,
    "safety": 0.83,
    "toolReliability": 0.62,
    "efficiency": 0.77,
    "aggregateScore": 0.64
  },
  "delta": {
    "successRate": 0.06,
    "satisfaction": 0.07,
    "safety": 0.02,
    "toolReliability": 0.08,
    "efficiency": 0.04,
    "aggregateScore": 0.05
  }
}
```

Notes:
- Replace baseline/champion with your real run output.
- Keep safety non-decreasing as a hard requirement.

---

## 4) Judge Q&A Quick Answers

1. **Why not RL fine-tuning?**  
Closed/proprietary weights. This evolves deployable policy artifacts instead.

2. **How is this safe?**  
Risk thresholds, tool disallow rules, holdout-gated promotion, rollback.

3. **How do you prove improvement?**  
Repeated baseline-vs-champion comparison on held-out trajectories and live monitoring.

4. **What is novel here?**  
Online evolutionary adaptation integrated into OpenClaw runtime hooks with operational safety controls.

---

## 5) Command Checklist (Before Presenting)

```bash
npm test
```

Python sidecar GEPA demo (clean isolation):
```bash
docker compose -f docker-compose.sidecar.yml up --build -d
node src/cli.js --input examples/telemetry.json --engine python-sidecar --sidecarBaseUrl http://127.0.0.1:8091
```

If using real telemetry:
```bash
node src/cli.js --input /path/to/real_telemetry.json --generations 12 --population 32
```
