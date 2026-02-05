# Rigorous Research Notes (February 5, 2026)

## Scope
Goal: evolve OpenClaw agent behavior for individual users without training model weights, using current evolutionary AI methods and strong safety/cost constraints.

## Primary Sources
1. GEPA paper on arXiv (2507.19457): https://arxiv.org/abs/2507.19457
2. GEPA official repository: https://github.com/gepa-ai/gepa
3. GEPA official docs: https://gepa-ai.github.io/gepa/
4. OpenEvolve paper on arXiv (2506.13131): https://arxiv.org/abs/2506.13131
5. MIPROv2 paper on arXiv (2406.11695): https://arxiv.org/abs/2406.11695
6. OpenClaw official docs: https://docs.openclaw.ai
7. OpenClaw official GitHub repo: https://github.com/openclaw/openclaw

## Findings
1. GEPA: demonstrates reflective evolutionary prompt adaptation that can outperform RL methods on optimization benchmarks, and it is inherently compatible with proprietary-weight models because optimization occurs over prompts/policies, not internal gradients.
2. GEPA docs/repo: confirm runtime controls including reflection minibatch, metric budget, Pareto candidate selection, and optional merge/crossover path (`use_merge`), which are directly relevant to this implementation.
3. OpenEvolve: validates coding-domain evolution loops where LLMs iteratively mutate/evaluate candidate programs with strong benchmark gains. This supports using evolutionary search over agent policies/tool-routing logic.
4. MIPROv2: provides practical evidence that Bayesian optimization + candidate instruction/procedure search significantly improves quality for LLM programs with limited expensive calls.
5. AlphaEvolve (Nature, 2025): reports an asynchronous pipeline with an evolutionary framework where prompt programs are generated/evaluated in parallel and iteratively improved. This supports continuous online optimization instead of one-shot batch runs.
6. OpenClaw architecture: supports plugin/services/hooks extension patterns, model providers, tools, and sessions. This makes it feasible to add an evolution service without modifying core runtime internals.

## Product Implications
1. Optimize behavior policy instead of model weights:
   - system prompt segments
   - tool preference/routing weights
   - retry/deliberation budgets
   - risk thresholds and disallowed tools
2. Use user trajectory replay as fitness signal:
   - success
   - user feedback
   - safety incidents
   - latency and cost
3. Multi-objective optimization is mandatory:
   - maximize success/satisfaction/safety
   - constrain cost and latency
   - preserve policy diversity (Pareto fronts)
4. Safety rollout must include gating:
   - hard disallow list
   - risk threshold
   - holdout validation before full promotion
   - rollback path on live regression
5. Evolution should run online, not only offline batch:
   - trigger on rolling telemetry windows
   - gate promotion on holdout performance
   - rollback if live metrics regress

## Why This Approach Fits "Proprietary Weights"
1. No weight updates are required.
2. Evolution loop can use any closed API model as black-box policy executor/evaluator.
3. Learned artifact is a deployable config/policy patch, not a finetuned model binary.

## Delivery Shape Chosen
1. `evolvePolicy()` GEPA-inspired loop.
2. `createOpenClawEvolutionService()` for session ingestion, **automatic online evolution triggers**, champion export.
3. `createOpenClawEvolutionPlugin()` adapter with OpenClaw-style hooks (`session_end`, `before_agent_start`, `before_tool_call`) plus backward-compatible aliases.
4. CLI + tests for immediate validation in this repo.

## Concrete Source Notes (Verified)
1. GEPA abstract (arXiv:2507.19457): reports improved optimization performance using reflective evolution and includes proprietary-model compatibility observations in the abstract.
2. GEPA docs (`gepa-ai.github.io/gepa`) API references include optimizer controls such as `reflection_minibatch_size`, `candidate_selection_strategy` (`pareto`), `max_metric_calls`, and `use_merge`.
3. AlphaEvolve abstract and method summary (Nature + arXiv:2506.13131): describes asynchronous evolutionary loop and iterative LLM-driven program refinement.
4. MIPROv2 abstract (arXiv:2406.11695): describes 5 candidate generations plus Bayesian optimization over instruction/demo combinations, showing strong benchmark gains.
5. OpenClaw docs plugin overview (`docs.openclaw.ai`): plugin package includes manifest + plugin class and can register hooks/services/config schemas, enabling runtime integration for online evolution.
