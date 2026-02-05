# ClawEvolve Long-Horizon Plan

## Phase 1 (Today): Production-Ready Online Loop Baseline
1. Continuous online evolution triggers from live trajectories.
2. Holdout-gated promotion with safety/success constraints.
3. Automatic rollback on live aggregate/safety regression.
4. Exportable policy patches for deployment.

## Phase 2 (1-2 Weeks): Real Runtime Integration
1. Bind hook payloads to exact OpenClaw runtime event schemas.
2. Persist trajectories/champions/events in durable storage.
3. Add scheduler + distributed lock for single evolution worker.
4. Add observability: dashboards for promotion/rejection/rollback.

## Phase 3 (2-4 Weeks): Robust Evaluation and Safer Rollout
1. Add canary routing between incumbent/challenger.
2. Add stratified evaluation by task/tool domain.
3. Add off-policy estimators and confidence intervals.
4. Add policy approval workflow with human override gates.

## Phase 4 (1-2 Months): Advanced Evolutionary Intelligence
1. Add novelty/diversity pressure beyond Pareto fronts.
2. Add reflection advisor model with retrieval over failure cases.
3. Add hierarchical genomes (global policy + per-domain subpolicy).
4. Add meta-optimization of objective weights and budgets.

## Phase 5 (Quarter): Multi-Tenant Personalization at Scale
1. Tenant-specific evolution pools with privacy boundaries.
2. Cold-start policy priors by task cluster.
3. Continual adaptation with drift detectors.
4. Governance: audit trails, policy diffs, and compliance exports.

