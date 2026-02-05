from __future__ import annotations

import copy
import json
import os
import statistics
import time
import uuid
from typing import Any, Dict, List, Optional

import dspy
import gepa
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from gepa.core.adapter import EvaluationBatch


def clamp(value: float, min_value: float, max_value: float) -> float:
    return max(min_value, min(max_value, value))


def mean(values: List[float]) -> float:
    if not values:
        return 0.0
    return statistics.fmean(values)


def normalized_cost(cost_usd: float) -> float:
    return clamp(1.0 - (cost_usd / 0.15), 0.0, 1.0)


def normalized_latency(latency_ms: float) -> float:
    return clamp(1.0 - (latency_ms / 20000.0), 0.0, 1.0)


def metric_or_neutral(raw_value: Any, normalizer) -> float:
    try:
        value = float(raw_value)
    except Exception:
        return 0.5
    return normalizer(value)


def normalize_tool_preferences(weights: Dict[str, float]) -> Dict[str, float]:
    safe_weights = {k: max(0.0, float(v)) for k, v in weights.items()}
    total = sum(safe_weights.values())
    if total <= 0:
        n = max(1, len(safe_weights))
        return {k: 1.0 / n for k in safe_weights}
    return {k: v / total for k, v in safe_weights.items()}


def objective_defaults(weights: Optional[Dict[str, float]]) -> Dict[str, float]:
    source = weights or {}
    return {
        "success": float(source.get("success", 0.30)),
        "satisfaction": float(source.get("satisfaction", 0.20)),
        "safety": float(source.get("safety", 0.25)),
        "toolReliability": float(source.get("toolReliability", 0.15)),
        "efficiency": float(source.get("efficiency", 0.10)),
    }


def seed_policy_from_genome(seed_genome: Dict[str, Any]) -> Dict[str, Any]:
    safeguards = seed_genome.get("safeguards") or {}
    return {
        "systemPrompt": seed_genome.get("systemPrompt", ""),
        "responseStyle": seed_genome.get("responseStyle", "balanced"),
        "toolPreferences": normalize_tool_preferences(seed_genome.get("toolPreferences") or {}),
        "toolRetryBudget": int(seed_genome.get("toolRetryBudget", 1)),
        "deliberationBudget": int(seed_genome.get("deliberationBudget", 2)),
        "memoryDepth": int(seed_genome.get("memoryDepth", 6)),
        "safeguards": {
            "maxRiskScore": float(safeguards.get("maxRiskScore", 0.55)),
            "disallowedTools": list(safeguards.get("disallowedTools") or []),
        },
    }


def genome_from_policy(seed_genome: Dict[str, Any], policy: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": f"pygenome_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}",
        "baseModel": seed_genome.get("baseModel", "gpt-5-mini"),
        "systemPrompt": policy["systemPrompt"],
        "responseStyle": policy["responseStyle"],
        "toolPreferences": policy["toolPreferences"],
        "toolRetryBudget": policy["toolRetryBudget"],
        "deliberationBudget": policy["deliberationBudget"],
        "memoryDepth": policy["memoryDepth"],
        "safeguards": policy["safeguards"],
        "mutationTrace": ["python-sidecar-gepa"],
    }


class EvolveRequest(BaseModel):
    seedGenome: Dict[str, Any]
    trajectories: List[Dict[str, Any]]
    generations: int = Field(default=6, ge=1, le=200)
    populationSize: int = Field(default=18, ge=4, le=500)
    objectiveWeights: Optional[Dict[str, float]] = None
    algorithm: Optional[Dict[str, Any]] = None
    gepa: Optional[Dict[str, Any]] = None


class OpenClawTelemetryAdapter:
    def __init__(
        self,
        seed_policy: Dict[str, Any],
        objective_weights: Dict[str, float],
    ) -> None:
        self.seed_policy = seed_policy
        self.objective_weights = objective_weights

    def _parse_policy(self, candidate: Dict[str, str]) -> tuple[Dict[str, Any], Optional[str]]:
        payload = candidate.get("policy_json", "")
        policy = copy.deepcopy(self.seed_policy)
        if not payload:
            return policy, None

        try:
            parsed = json.loads(payload)
        except Exception as exc:
            return policy, f"invalid policy_json: {exc}"

        if isinstance(parsed.get("systemPrompt"), str):
            policy["systemPrompt"] = parsed["systemPrompt"]
        if parsed.get("responseStyle") in {"concise", "balanced", "detailed"}:
            policy["responseStyle"] = parsed["responseStyle"]

        tool_preferences = parsed.get("toolPreferences")
        if isinstance(tool_preferences, dict):
            policy["toolPreferences"] = normalize_tool_preferences(tool_preferences)

        def safe_int(value: Any, fallback: int, min_v: int, max_v: int) -> int:
            try:
                return int(clamp(float(value), float(min_v), float(max_v)))
            except Exception:
                return fallback

        policy["toolRetryBudget"] = safe_int(
            parsed.get("toolRetryBudget"), policy["toolRetryBudget"], 0, 8
        )
        policy["deliberationBudget"] = safe_int(
            parsed.get("deliberationBudget"), policy["deliberationBudget"], 1, 12
        )
        policy["memoryDepth"] = safe_int(parsed.get("memoryDepth"), policy["memoryDepth"], 1, 64)

        safeguards = parsed.get("safeguards")
        if isinstance(safeguards, dict):
            if "maxRiskScore" in safeguards:
                try:
                    policy["safeguards"]["maxRiskScore"] = clamp(
                        float(safeguards["maxRiskScore"]), 0.05, 0.95
                    )
                except Exception:
                    pass
            if isinstance(safeguards.get("disallowedTools"), list):
                policy["safeguards"]["disallowedTools"] = [
                    str(x) for x in safeguards["disallowedTools"]
                ]

        return policy, None

    def _tool_fitness_for_trajectory(
        self, trajectory: Dict[str, Any], policy: Dict[str, Any]
    ) -> float:
        calls = trajectory.get("toolCalls") or []
        if not calls:
            return 0.5

        tool_preferences = policy["toolPreferences"]
        max_risk = float(policy["safeguards"]["maxRiskScore"])
        scores: List[float] = []
        for call in calls:
            name = str(call.get("toolName", ""))
            pref = float(tool_preferences.get(name, 0.01))
            success_boost = 1.0 if call.get("success") else -0.7
            call_risk = clamp(float(call.get("riskScore", 0.0)), 0.0, 1.0)
            baseline_risk_penalty = -0.5 * call_risk
            risk_penalty = -0.8 if call_risk > max_risk else 0.0
            scores.append(pref * (1.0 + success_boost + baseline_risk_penalty + risk_penalty))

        raw = mean(scores)
        return clamp((raw + 1.0) / 2.0, 0.0, 1.0)

    def _evaluate_example(
        self, trajectory: Dict[str, Any], policy: Dict[str, Any]
    ) -> tuple[float, Dict[str, float], Dict[str, Any], str]:
        success_rate = 1.0 if trajectory.get("success") else 0.0
        satisfaction = clamp((float(trajectory.get("userFeedback", 0.0)) + 1.0) / 2.0, 0.0, 1.0)
        safety = clamp(
            1.0 - min(1.0, float(trajectory.get("safetyIncidents", 0.0)) / 3.0), 0.0, 1.0
        )
        tool_reliability = self._tool_fitness_for_trajectory(trajectory, policy)

        cost_score = metric_or_neutral(trajectory.get("costUsd"), normalized_cost)
        latency_score = metric_or_neutral(trajectory.get("latencyMs"), normalized_latency)
        efficiency = clamp((cost_score + latency_score) / 2.0, 0.0, 1.0)

        strategy_penalty = clamp(float(policy["deliberationBudget"]) / 10.0, 0.0, 0.3) + clamp(
            float(policy["memoryDepth"]) / 100.0, 0.0, 0.2
        )
        style_bonus = 0.05 * (
            1.0
            if policy["responseStyle"] == "balanced"
            else (0.95 if policy["responseStyle"] == "concise" else 0.9)
        )

        total = (
            self.objective_weights["success"] * success_rate
            + self.objective_weights["satisfaction"] * satisfaction
            + self.objective_weights["safety"] * safety
            + self.objective_weights["toolReliability"] * tool_reliability
            + self.objective_weights["efficiency"] * efficiency
            + style_bonus
            - strategy_penalty
        )
        total = clamp(total, 0.0, 1.0)

        objectives = {
            "successRate": success_rate,
            "satisfaction": satisfaction,
            "safety": safety,
            "toolReliability": tool_reliability,
            "efficiency": efficiency,
        }
        output = {
            "score": total,
            "objectives": objectives,
            "trajectoryId": trajectory.get("id"),
        }

        failure_hint = "Improve safety checks and tool routing."
        if success_rate >= 1.0 and safety >= 1.0:
            failure_hint = "Preserve this behavior while improving efficiency."
        feedback = (
            f"success={success_rate:.2f}, safety={safety:.2f}, "
            f"toolReliability={tool_reliability:.2f}. {failure_hint}"
        )
        return total, objectives, output, feedback

    def evaluate(
        self, batch: List[Dict[str, Any]], candidate: Dict[str, str], capture_traces: bool = False
    ) -> EvaluationBatch:
        policy, parse_error = self._parse_policy(candidate)

        outputs: List[Dict[str, Any]] = []
        scores: List[float] = []
        trajectories: List[Dict[str, Any]] = []
        objective_scores: Dict[str, List[float]] = {
            "successRate": [],
            "satisfaction": [],
            "safety": [],
            "toolReliability": [],
            "efficiency": [],
        }

        for example in batch:
            score, objectives, output, feedback = self._evaluate_example(example, policy)
            if parse_error:
                score = clamp(score - 0.08, 0.0, 1.0)
                feedback = f"{feedback} Parse error fallback: {parse_error}"
            outputs.append(output)
            scores.append(score)
            for key, value in objectives.items():
                objective_scores[key].append(value)
            if capture_traces:
                trajectories.append(
                    {
                        "data": example,
                        "output": output,
                        "score": score,
                        "objective_scores": objectives,
                        "feedback": feedback,
                    }
                )

        return EvaluationBatch(
            outputs=outputs,
            scores=scores,
            trajectories=trajectories if capture_traces else None,
            objective_scores=objective_scores,
        )

    def make_reflective_dataset(
        self,
        candidate: Dict[str, str],
        eval_batch: EvaluationBatch,
        components_to_update: List[str],
    ) -> Dict[str, List[Dict[str, Any]]]:
        traces = eval_batch.trajectories or []
        rows: List[Dict[str, Any]] = []
        for trace in traces:
            data = trace.get("data", {})
            tool_names = [str(c.get("toolName", "")) for c in (data.get("toolCalls") or [])]
            rows.append(
                {
                    "Inputs": {
                        "trajectoryId": data.get("id"),
                        "prompt": data.get("prompt", ""),
                        "tools": tool_names,
                        "safetyIncidents": data.get("safetyIncidents", 0),
                    },
                    "Generated Outputs": {
                        "policy_json": candidate.get("policy_json", ""),
                        "score": trace.get("score", 0),
                        "objectives": trace.get("objective_scores", {}),
                    },
                    "Feedback": trace.get("feedback", ""),
                }
            )

        return {component: rows for component in components_to_update}


def extract_history(result: Any) -> List[Dict[str, Any]]:
    for attr_name in ("history", "step_history", "timeline"):
        value = getattr(result, attr_name, None)
        if isinstance(value, list):
            history: List[Dict[str, Any]] = []
            for index, item in enumerate(value):
                if isinstance(item, dict):
                    best_score = item.get("best_score", item.get("score"))
                else:
                    best_score = None
                history.append({"generation": index + 1, "bestScore": best_score})
            return history
    return []


def require_auth(authorization: Optional[str]) -> None:
    expected_token = os.getenv("CLAW_EVOLVE_SIDECAR_API_KEY")
    if not expected_token:
        return
    expected_header = f"Bearer {expected_token}"
    if authorization != expected_header:
        raise HTTPException(status_code=401, detail="Unauthorized sidecar token")


app = FastAPI(title="ClawEvolve Python Sidecar", version="0.1.0")


@app.get("/healthz")
def healthz() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/evolve")
def evolve(request: EvolveRequest, authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(authorization)
    if len(request.trajectories) < 1:
        raise HTTPException(status_code=400, detail="At least one trajectory is required")

    seed_policy = seed_policy_from_genome(request.seedGenome)
    objective_weights = objective_defaults(request.objectiveWeights)
    adapter = OpenClawTelemetryAdapter(seed_policy, objective_weights)

    algorithm_cfg = request.algorithm or {}
    outer_holdout_applied = bool(algorithm_cfg.get("outerHoldoutApplied", False))

    trainset = request.trajectories
    if outer_holdout_applied or len(trainset) < 25:
        # Preserve sample efficiency when the caller already holds out data,
        # or when data volume is still low.
        valset = trainset
    elif len(trainset) >= 5:
        split = max(1, int(len(trainset) * 0.2))
        valset = trainset[-split:]
        trainset = trainset[:-split]
        if len(trainset) < 1:
            trainset = request.trajectories
    else:
        valset = request.trajectories

    seed_candidate = {"policy_json": json.dumps(seed_policy, separators=(",", ":"), sort_keys=True)}

    gepa_cfg = request.gepa or {}
    reflection_model = gepa_cfg.get("reflectionLm", "openai/gpt-5-mini")
    try:
        reflection_lm = dspy.LM(reflection_model)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to initialize reflection LM: {exc}") from exc

    strategy = (
        gepa_cfg.get("candidateSelectionStrategy")
        or algorithm_cfg.get("candidateSelectionStrategy")
        or "pareto"
    )
    reflection_minibatch_size = int(
        gepa_cfg.get("reflectionMinibatchSize")
        or algorithm_cfg.get("reflectionMinibatchSize")
        or 3
    )
    use_merge = bool(
        gepa_cfg.get("useMerge")
        if "useMerge" in gepa_cfg
        else algorithm_cfg.get("useMerge", True)
    )
    max_metric_calls = gepa_cfg.get("maxMetricCalls")
    if max_metric_calls is None:
        max_metric_calls = max(40, request.generations * request.populationSize * 2)

    try:
        result = gepa.optimize(
            seed_candidate=seed_candidate,
            trainset=trainset,
            valset=valset,
            adapter=adapter,
            reflection_lm=reflection_lm,
            n_refine=request.generations,
            candidate_selection_strategy=strategy,
            reflection_minibatch_size=reflection_minibatch_size,
            use_merge=use_merge,
            max_merge_invocations=int(gepa_cfg.get("maxMergeInvocations", 5)),
            max_metric_calls=int(max_metric_calls),
            seed=int(gepa_cfg.get("seed", 0)),
            raise_on_exception=False,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"GEPA optimization failed: {exc}") from exc

    best_candidate = getattr(result, "best_candidate", seed_candidate)
    if not isinstance(best_candidate, dict):
        best_candidate = seed_candidate

    eval_batch = adapter.evaluate(valset, best_candidate, capture_traces=False)
    objective_means = {
        key: mean([float(v) for v in values]) for key, values in (eval_batch.objective_scores or {}).items()
    }
    champion_eval = {
        "objectives": objective_means,
        "aggregateScore": mean([float(v) for v in eval_batch.scores]),
    }

    best_policy, _ = adapter._parse_policy(best_candidate)
    champion = genome_from_policy(request.seedGenome, best_policy)

    return {
        "champion": champion,
        "championEvaluation": champion_eval,
        "leaderboard": [{"genome": champion, "evaluation": champion_eval}],
        "telemetrySummary": {
            "trajectoryCount": len(request.trajectories),
            "engine": "python-sidecar",
        },
        "history": extract_history(result),
        "algorithm": {
            "mode": "gepa-python-sidecar",
            "candidateSelectionStrategy": strategy,
            "reflectionMinibatchSize": reflection_minibatch_size,
            "useMerge": use_merge,
        },
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8091")))
