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
PRIVATE_DIR = ROOT_DIR / ".private"
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


def _tail_text(text: str, max_chars: int = 30000) -> str:
    if len(text) <= max_chars:
        return text
    return text[-max_chars:]


def _build_dashboard_cmd(
    *,
    force_run: bool,
    generations: int,
    population_size: int,
    timeout_ms: int,
    url: str,
    token: str,
    password: str,
) -> list[str]:
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
    return cmd


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
    cmd = _build_dashboard_cmd(
        force_run=force_run,
        generations=generations,
        population_size=population_size,
        timeout_ms=timeout_ms,
        url=url,
        token=token,
        password=password,
    )

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
        return (
            None,
            f"Dashboard command returned no JSON (exit={proc.returncode}). Check OpenClaw gateway/plugin logs.",
            proc.stdout,
            proc.stderr,
        )
    if not payload.get("ok", False):
        return payload, str(payload.get("error") or "Unknown dashboard error"), proc.stdout, proc.stderr
    return payload, None, proc.stdout, proc.stderr


def _start_force_run_subprocess(
    *,
    generations: int,
    population_size: int,
    timeout_ms: int,
    url: str,
    token: str,
    password: str,
) -> tuple[bool, str]:
    running_proc = st.session_state.get("force_proc")
    if running_proc is not None and running_proc.poll() is None:
        return False, "A force-run is already in progress."

    PRIVATE_DIR.mkdir(parents=True, exist_ok=True)
    log_path = PRIVATE_DIR / f"force_run_{int(time.time() * 1000)}.log"
    cmd = _build_dashboard_cmd(
        force_run=True,
        generations=generations,
        population_size=population_size,
        timeout_ms=max(timeout_ms, DEFAULT_FORCE_TIMEOUT_MS),
        url=url,
        token=token,
        password=password,
    )

    try:
        with log_path.open("w", encoding="utf-8") as handle:
            proc = subprocess.Popen(
                cmd,
                cwd=ROOT_DIR,
                stdout=handle,
                stderr=subprocess.STDOUT,
                text=True,
            )
    except Exception as exc:
        return False, f"Failed to start force-run subprocess: {exc}"

    st.session_state["force_proc"] = proc
    st.session_state["force_log_path"] = str(log_path)
    st.session_state["force_started_at"] = time.time()
    st.session_state["force_result"] = None
    st.session_state["force_cmd"] = " ".join(cmd)
    return True, f"Started force-run (pid={proc.pid})"


def _poll_force_run_subprocess() -> dict[str, Any]:
    proc = st.session_state.get("force_proc")
    if proc is None:
        result = st.session_state.get("force_result")
        if isinstance(result, dict):
            return result
        return {"state": "idle"}

    exit_code = proc.poll()
    if exit_code is None:
        return {
            "state": "running",
            "pid": proc.pid,
            "started_at": st.session_state.get("force_started_at"),
            "cmd": st.session_state.get("force_cmd", ""),
            "log_path": st.session_state.get("force_log_path", ""),
        }

    log_path_str = st.session_state.get("force_log_path")
    log_text = ""
    if isinstance(log_path_str, str) and log_path_str:
        try:
            log_text = Path(log_path_str).read_text(encoding="utf-8")
        except Exception:
            log_text = ""

    payload = _extract_json_blob(log_text)
    force_result = {
        "state": "finished",
        "exit_code": exit_code,
        "payload": payload,
        "log": _tail_text(log_text),
        "log_path": log_path_str,
    }
    st.session_state["force_result"] = force_result
    st.session_state["force_proc"] = None
    return force_result


def _read_sidecar_logs(tail_lines: int) -> tuple[str, str | None]:
    cmd = [
        "docker",
        "compose",
        "-f",
        "docker-compose.sidecar.yml",
        "logs",
        "--tail",
        str(max(1, tail_lines)),
        "claw-evolve-sidecar",
    ]
    try:
        proc = subprocess.run(
            cmd,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except Exception as exc:
        return "", f"Failed to read sidecar logs: {exc}"

    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip() or f"docker logs failed ({proc.returncode})"
        return "", err
    return _tail_text(proc.stdout), None


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
    last_run_details = report.get("lastRunDetails") or {}
    prompt_diff = (last_run.get("policyDiff") or {}).get("systemPrompt") or (
        (report.get("latestPromotionDiff") or {}).get("systemPrompt")
    )

    st.subheader("Status")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Champion", report.get("championId") or "none")
    c2.metric("Trajectories", str(report.get("trajectoryCount", 0)))
    c3.metric("Trigger", trigger.get("nextReason", "n/a"))
    c4.metric("In Flight", str(bool(trigger.get("evolutionInFlight"))))

    active_manual = report.get("activeManualRun") or None
    if active_manual:
        st.info(
            "Active manual run: "
            f"run={active_manual.get('runId')} generations={active_manual.get('generations')} "
            f"population={active_manual.get('populationSize')} started={_fmt_ts(active_manual.get('startedAt'))}"
        )

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

    history = last_run_details.get("history") if isinstance(last_run_details, dict) else None
    if isinstance(history, list) and history:
        st.caption("GEPA History")
        rows = [
            {
                "generation": row.get("generation"),
                "bestScore": _fmt_num(row.get("bestScore"), 6),
            }
            for row in history[-40:]
            if isinstance(row, dict)
        ]
        st.dataframe(rows, width="stretch", hide_index=True)

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
        st.dataframe(rows, width="stretch", hide_index=True)
    else:
        st.write("No events yet.")

    with st.expander("Raw payload"):
        st.json(payload)


def main() -> None:
    st.set_page_config(page_title="ClawEvolve Live", layout="wide")
    st.title("ClawEvolve Live Streamlit Dashboard")

    st.sidebar.header("Controls")
    timeout_ms = int(st.sidebar.number_input("Gateway timeout (ms)", min_value=1000, value=12000, step=1000))
    generations = int(st.sidebar.number_input("Force-run generations", min_value=1, value=3, step=1))
    population_size = int(st.sidebar.number_input("Force-run population", min_value=4, value=8, step=1))
    url = st.sidebar.text_input("Gateway URL override", value="")
    token = st.sidebar.text_input("Gateway token override", value="")
    password = st.sidebar.text_input("Gateway password override", value="", type="password")

    col_a, col_b = st.sidebar.columns(2)
    force_run = col_a.button("Start Force Run", type="primary")
    refresh = col_b.button("Refresh")

    auto_refresh = st.sidebar.checkbox("Auto refresh", value=True)
    refresh_seconds = int(
        st.sidebar.slider("Auto refresh interval (sec)", min_value=1, max_value=30, value=2, step=1)
    )

    show_sidecar_logs = st.sidebar.checkbox("Show sidecar logs", value=True)
    sidecar_tail_lines = int(st.sidebar.slider("Sidecar log lines", min_value=50, max_value=1000, value=250, step=50))

    if force_run:
        started, message = _start_force_run_subprocess(
            generations=generations,
            population_size=population_size,
            timeout_ms=timeout_ms,
            url=url,
            token=token,
            password=password,
        )
        if started:
            st.success(message)
        else:
            st.warning(message)

    force_state = _poll_force_run_subprocess()
    if force_state.get("state") == "running":
        st.warning(
            "Force-run in progress: "
            f"pid={force_state.get('pid')} started={_fmt_ts((force_state.get('started_at') or 0) * 1000)}"
        )
    elif force_state.get("state") == "finished":
        payload = force_state.get("payload")
        if isinstance(payload, dict) and payload.get("ok", False):
            forced = payload.get("forced") or {}
            st.success(
                "Force-run finished: "
                f"run={forced.get('runId')} champion={forced.get('championId')} "
                f"promoted={forced.get('promoted')} durationMs={forced.get('durationMs')}"
            )
            if payload.get("forceRunWarning"):
                st.warning(f"Force-run warning: {payload.get('forceRunWarning')}")
        else:
            st.error(f"Force-run process exited with code {force_state.get('exit_code')}")
        with st.expander("Force-run command output"):
            st.code(force_state.get("log") or "(empty)", language="text")

    report_payload, report_error, stdout_text, stderr_text = _run_dashboard_json(
        force_run=False,
        generations=generations,
        population_size=population_size,
        timeout_ms=timeout_ms,
        url=url,
        token=token,
        password=password,
    )

    if report_error:
        st.error(report_error)
        with st.expander("Report stderr"):
            st.code(stderr_text or "(empty)", language="text")
        with st.expander("Report stdout"):
            st.code(stdout_text or "(empty)", language="text")
    else:
        assert report_payload is not None
        _render_report(report_payload)

    if show_sidecar_logs:
        st.subheader("Sidecar Logs (tail)")
        logs, logs_error = _read_sidecar_logs(sidecar_tail_lines)
        if logs_error:
            st.warning(logs_error)
        else:
            st.code(logs or "(empty)", language="text")

    if auto_refresh and not refresh:
        time.sleep(refresh_seconds)
        st.rerun()


if __name__ == "__main__":
    main()
