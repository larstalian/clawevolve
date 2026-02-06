#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import streamlit as st

ROOT_DIR = Path(__file__).resolve().parent
DEFAULT_TIMEOUT_MS = 12000
DEFAULT_FORCE_TIMEOUT_MS = 120000


def _extract_json_blob(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    decoder = json.JSONDecoder()
    for idx, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            obj, consumed = decoder.raw_decode(text[idx:])
        except Exception:
            continue
        trailing = text[idx + consumed :].strip()
        if trailing:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def _run_dashboard_json(
    *,
    force_run: bool,
    generations: int,
    population_size: int,
    timeout_ms: int,
    url: str,
    token: str,
    password: str,
) -> tuple[dict[str, Any] | None, str | None, str, str]:
    cmd = [
        "node",
        "src/liveDashboard.js",
        "--json",
        "--once",
        "--timeout-ms",
        str(timeout_ms),
    ]
    if force_run:
        cmd += [
            "--force-run",
            "--generations",
            str(generations),
            "--population-size",
            str(population_size),
            "--timeout-ms",
            str(max(timeout_ms, DEFAULT_FORCE_TIMEOUT_MS)),
        ]
    if url.strip():
        cmd += ["--url", url.strip()]
    if token.strip():
        cmd += ["--token", token.strip()]
    if password.strip():
        cmd += ["--password", password.strip()]

    try:
        proc = subprocess.run(
            cmd,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=max(20, int(timeout_ms / 1000) + 20),
            check=False,
        )
    except Exception as exc:
        return None, f"Failed to run dashboard command: {exc}", "", ""

    payload = _extract_json_blob(proc.stdout) or _extract_json_blob(proc.stderr)

    if payload is None:
        error = (
            f"Dashboard command returned no JSON (exit={proc.returncode}). "
            "Check OpenClaw gateway/plugin logs."
        )
        return None, error, proc.stdout, proc.stderr

    if not payload.get("ok", False):
        msg = payload.get("error") or "Unknown dashboard error"
        return payload, msg, proc.stdout, proc.stderr

    return payload, None, proc.stdout, proc.stderr


def _fmt_ts(value: Any) -> str:
    if value in (None, ""):
        return "never"
    try:
        dt = datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc)
        return dt.isoformat()
    except Exception:
        pass
    try:
        return str(datetime.fromisoformat(str(value).replace("Z", "+00:00")))
    except Exception:
        return str(value)


def _fmt_num(value: Any, digits: int = 3) -> str:
    try:
        return f"{float(value):.{digits}f}"
    except Exception:
        return "n/a"


def _render_report(payload: dict[str, Any]) -> None:
    report = payload.get("report") or {}
    trigger = report.get("trigger") or {}
    metrics = report.get("recentWindowMetrics") or {}
    last_run = report.get("lastRun") or {}
    prompt_diff = (last_run.get("policyDiff") or {}).get("systemPrompt") or (
        (report.get("latestPromotionDiff") or {}).get("systemPrompt")
    )

    st.subheader("Status")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Champion", report.get("championId") or "none")
    c2.metric("Trajectories", str(report.get("trajectoryCount", 0)))
    c3.metric("Trigger", trigger.get("nextReason", "n/a"))
    c4.metric("In Flight", str(bool(trigger.get("evolutionInFlight"))))

    st.subheader("Trigger")
    tc1, tc2, tc3 = st.columns(3)
    tc1.write(
        {
            "ready": trigger.get("ready"),
            "state": trigger.get("nextReason"),
            "min": trigger.get("minTrajectoriesForEvolution"),
            "cadence": trigger.get("evolveEveryTrajectories"),
            "seen": trigger.get("trajectoriesSeen"),
        }
    )
    tc2.write(
        {
            "missingForMin": trigger.get("missingForMinTrajectories"),
            "missingForInterval": trigger.get("missingForInterval"),
            "cooldownRemainingMs": trigger.get("cooldownRemainingMs"),
        }
    )
    tc3.write(
        {
            "lastEvolutionAt": _fmt_ts(report.get("lastEvolutionAt")),
            "lastEvolutionTrajectoryCount": report.get("lastEvolutionTrajectoryCount"),
            "previousChampionId": report.get("previousChampionId"),
        }
    )

    st.subheader("Prompt Evolution")
    current_prompt = (((report.get("currentPatch") or {}).get("agent") or {}).get("systemPrompt"))
    if current_prompt:
        st.caption("Current Champion Prompt")
        st.code(current_prompt, language="text")
    else:
        st.info("No current champion prompt available yet.")

    if prompt_diff:
        st.caption("Last Prompt Diff")
        dc1, dc2, dc3 = st.columns(3)
        dc1.metric("Previous chars", str(prompt_diff.get("previousChars", "n/a")))
        dc2.metric("New chars", str(prompt_diff.get("nextChars", "n/a")))
        dc3.metric("Delta", str(prompt_diff.get("deltaChars", "n/a")))
        added = prompt_diff.get("addedLines") or []
        removed = prompt_diff.get("removedLines") or []
        ac, rc = st.columns(2)
        ac.write({"addedLines": added[:8] or ["none"]})
        rc.write({"removedLines": removed[:8] or ["none"]})
    else:
        st.write("No prompt diff recorded on the latest run.")

    st.subheader("Recent Window")
    st.write(
        {
            "sampleCount": metrics.get("sampleCount", 0),
            "successRate": _fmt_num(metrics.get("successRate")),
            "avgUserFeedback": _fmt_num(metrics.get("avgUserFeedback")),
            "avgSafetyIncidents": _fmt_num(metrics.get("avgSafetyIncidents")),
            "avgLatencyMs": _fmt_num(metrics.get("avgLatencyMs"), 2),
            "avgCostUsd": _fmt_num(metrics.get("avgCostUsd"), 4),
            "topTools": metrics.get("topTools") or [],
        }
    )

    st.subheader("Last Run")
    if last_run:
        st.write(
            {
                "runId": last_run.get("runId"),
                "source": last_run.get("source"),
                "promoted": last_run.get("promoted"),
                "reason": last_run.get("reason"),
                "durationMs": last_run.get("durationMs"),
                "candidateAggregate": _fmt_num(last_run.get("candidateAggregate")),
                "incumbentAggregate": _fmt_num(last_run.get("incumbentAggregate")),
                "changedFields": (last_run.get("policyDiff") or {}).get("changedFields") or [],
                "topToolPreferenceChanges": (last_run.get("policyDiff") or {}).get("topToolPreferenceChanges") or [],
            }
        )
    else:
        st.write("No evolution run recorded yet.")

    st.subheader("Recent Events")
    recent_events = report.get("recentEvents") or []
    if recent_events:
        rows = []
        for event in recent_events[-25:]:
            rows.append(
                {
                    "at": _fmt_ts(event.get("at")),
                    "type": event.get("type"),
                    "runId": event.get("runId"),
                    "source": event.get("source"),
                    "reason": event.get("reason"),
                }
            )
        st.dataframe(rows, use_container_width=True, hide_index=True)
    else:
        st.write("No events yet.")

    with st.expander("Raw payload"):
        st.json(payload)


def main() -> None:
    st.set_page_config(page_title="ClawEvolve Live", layout="wide")
    st.title("ClawEvolve Live Streamlit Dashboard")

    st.sidebar.header("Controls")
    timeout_ms = int(st.sidebar.number_input("Gateway timeout (ms)", min_value=1000, value=12000, step=1000))
    generations = int(st.sidebar.number_input("Force-run generations", min_value=1, value=6, step=1))
    population_size = int(st.sidebar.number_input("Force-run population", min_value=4, value=18, step=1))
    url = st.sidebar.text_input("Gateway URL override", value="")
    token = st.sidebar.text_input("Gateway token override", value="")
    password = st.sidebar.text_input("Gateway password override", value="", type="password")

    col_a, col_b = st.sidebar.columns(2)
    force_run = col_a.button("Force Run", type="primary")
    refresh = col_b.button("Refresh")

    auto_refresh = st.sidebar.checkbox("Auto refresh", value=True)
    refresh_seconds = int(
        st.sidebar.slider("Auto refresh interval (sec)", min_value=2, max_value=30, value=3, step=1)
    )

    payload, error, stdout_text, stderr_text = _run_dashboard_json(
        force_run=force_run,
        generations=generations,
        population_size=population_size,
        timeout_ms=timeout_ms,
        url=url,
        token=token,
        password=password,
    )

    if error:
        st.error(error)
        if payload and payload.get("forceRunWarning"):
            st.warning(f"Force-run warning: {payload.get('forceRunWarning')}")
        with st.expander("Command stderr"):
            st.code(stderr_text or "(empty)", language="text")
        with st.expander("Command stdout"):
            st.code(stdout_text or "(empty)", language="text")
    else:
        assert payload is not None
        if payload.get("forceRunWarning"):
            st.warning(f"Force-run warning: {payload.get('forceRunWarning')}")
        forced = payload.get("forced")
        if forced:
            st.success(
                "Force-run completed: "
                f"run={forced.get('runId')} champion={forced.get('championId')} "
                f"promoted={forced.get('promoted')} durationMs={forced.get('durationMs')}"
            )
        _render_report(payload)

    if auto_refresh and not refresh:
        time.sleep(refresh_seconds)
        st.rerun()


if __name__ == "__main__":
    main()
