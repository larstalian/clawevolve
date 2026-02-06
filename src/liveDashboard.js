#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = 3;

function parseArgs(argv) {
  const args = {
    intervalMs: 2000,
    timeoutMs: 12000,
    clear: true,
    once: false,
    json: false,
    forceRun: false,
    generations: 3,
    populationSize: 8,
    url: null,
    token: null,
    password: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--once") {
      args.once = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      args.clear = false;
      continue;
    }
    if (token === "--no-clear") {
      args.clear = false;
      continue;
    }
    if (token === "--force-run") {
      args.forceRun = true;
      continue;
    }
    if (token === "--interval-ms" && argv[i + 1]) {
      args.intervalMs = Math.max(250, Number(argv[i + 1]) || args.intervalMs);
      i += 1;
      continue;
    }
    if (token === "--timeout-ms" && argv[i + 1]) {
      args.timeoutMs = Math.max(1000, Number(argv[i + 1]) || args.timeoutMs);
      i += 1;
      continue;
    }
    if (token === "--generations" && argv[i + 1]) {
      args.generations = Math.max(1, Number(argv[i + 1]) || args.generations);
      i += 1;
      continue;
    }
    if (token === "--population-size" && argv[i + 1]) {
      args.populationSize = Math.max(4, Number(argv[i + 1]) || args.populationSize);
      i += 1;
      continue;
    }
    if (token === "--url" && argv[i + 1]) {
      args.url = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--token" && argv[i + 1]) {
      args.token = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--password" && argv[i + 1]) {
      args.password = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  const text = [
    "ClawEvolve live dashboard",
    "",
    "Usage:",
    "  node src/liveDashboard.js [options]",
    "",
    "Options:",
    "  --once                    fetch one snapshot and exit",
    "  --json                    print raw report JSON",
    "  --force-run               trigger one manual evolution run before polling",
    "  --generations <n>         generations for --force-run (default: 3)",
    "  --population-size <n>     population size for --force-run (default: 8)",
    "  --interval-ms <ms>        poll interval (default: 2000)",
    "  --timeout-ms <ms>         request timeout (default: 12000)",
    "  --url <ws-url>            gateway ws url override (e.g. ws://127.0.0.1:18789)",
    "  --token <token>           gateway token override",
    "  --password <password>     gateway password override",
    "  --no-clear                do not clear terminal between refreshes",
    "  -h, --help                show help"
  ];
  console.log(text.join("\n"));
}

async function readGatewayConfig() {
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  return {
    configPath,
    config
  };
}

function resolveGatewayTarget(config, args) {
  const gatewayCfg = config?.gateway || {};
  const authCfg = gatewayCfg?.auth || {};
  const remoteCfg = gatewayCfg?.remote || {};
  const isRemote = gatewayCfg?.mode === "remote";

  const localPort = Number(gatewayCfg.port);
  const port = Number.isFinite(localPort) && localPort > 0 ? localPort : 18789;
  const localScheme = gatewayCfg?.tls?.enabled === true ? "wss" : "ws";
  const localUrl = `${localScheme}://127.0.0.1:${port}`;
  const remoteUrl =
    typeof remoteCfg.url === "string" && remoteCfg.url.trim() ? remoteCfg.url.trim() : null;

  const url = args.url || (isRemote && remoteUrl ? remoteUrl : localUrl);
  const token =
    args.token ||
    process.env.OPENCLAW_GATEWAY_TOKEN ||
    process.env.CLAWDBOT_GATEWAY_TOKEN ||
    (isRemote && typeof remoteCfg.token === "string" ? remoteCfg.token : null) ||
    (typeof authCfg.token === "string" ? authCfg.token : null);
  const password =
    args.password ||
    process.env.OPENCLAW_GATEWAY_PASSWORD ||
    process.env.CLAWDBOT_GATEWAY_PASSWORD ||
    (isRemote && typeof remoteCfg.password === "string" ? remoteCfg.password : null) ||
    (typeof authCfg.password === "string" ? authCfg.password : null);

  return {
    url,
    token: token || undefined,
    password: password || undefined
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return "n/a";
  return Number(value).toFixed(digits);
}

function fmtDate(value) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "invalid";
  return date.toISOString();
}

function fmtAgo(value) {
  if (!value) return "n/a";
  const diffMs = Date.now() - Number(value);
  if (!Number.isFinite(diffMs) || diffMs < 0) return "n/a";
  if (diffMs < 1000) return `${diffMs}ms ago`;
  if (diffMs < 60000) return `${Math.round(diffMs / 1000)}s ago`;
  if (diffMs < 3600000) return `${Math.round(diffMs / 60000)}m ago`;
  return `${Math.round(diffMs / 3600000)}h ago`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m${sec}s`;
}

function formatTrigger(trigger) {
  if (!trigger) return "unavailable";
  if (trigger.ready) return "ready";
  const parts = [];
  if (trigger.missingForMinTrajectories > 0) {
    parts.push(`need_min=${trigger.missingForMinTrajectories}`);
  } else if (trigger.missingForInterval > 0) {
    parts.push(`need_interval=${trigger.missingForInterval}`);
  }
  if (trigger.cooldownRemainingMs > 0) {
    parts.push(`cooldown=${fmtDuration(trigger.cooldownRemainingMs)}`);
  }
  if (trigger.evolutionInFlight) parts.push("in_flight=true");
  return `${trigger.nextReason || "blocked"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function formatToolDelta(change) {
  const delta = Number(change?.delta);
  const sign = Number.isFinite(delta) && delta >= 0 ? "+" : "";
  return `${change.toolName}:${sign}${fmtNumber(delta, 4)} (${fmtNumber(change.from, 4)}->${fmtNumber(change.to, 4)})`;
}

function summarizePromptLines(prompt, maxLines = 5, maxChars = 160) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    return { lines: [], truncated: false };
  }
  const normalized = prompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = normalized.slice(0, maxLines).map((line) =>
    line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line
  );
  return {
    lines,
    truncated: normalized.length > maxLines
  };
}

function formatSignedNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return "n/a";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(digits)}`;
}

function toLinesReport(report, fetchedAt, args, sourceInfo) {
  const lines = [];
  const trigger = report.trigger || {};
  const metrics = report.recentWindowMetrics || {};
  const lastRun = report.lastRun || null;
  const recentEvents = Array.isArray(report.recentEvents) ? report.recentEvents : [];

  lines.push("ClawEvolve Live Dashboard");
  lines.push(
    `Fetched ${fmtDate(fetchedAt)} (${fmtAgo(fetchedAt)}) | interval=${args.intervalMs}ms | ${sourceInfo}`
  );
  lines.push("");

  lines.push("Trigger");
  lines.push(`- state: ${formatTrigger(trigger)}`);
  lines.push(
    `- trajectories: ${trigger.trajectoriesSeen ?? report.trajectoryCount ?? 0} | min=${trigger.minTrajectoriesForEvolution ?? "n/a"} | cadence=${trigger.evolveEveryTrajectories ?? "n/a"}`
  );
  lines.push(
    `- cooldown: ${fmtDuration(trigger.cooldownRemainingMs ?? 0)} remaining | inFlight=${String(Boolean(trigger.evolutionInFlight))}`
  );
  lines.push("");

  lines.push("Champion");
  lines.push(`- active: ${String(Boolean(report.hasChampion))}`);
  lines.push(`- championId: ${report.championId || "none"}`);
  lines.push(`- previousChampionId: ${report.previousChampionId || "none"}`);
  lines.push(`- lastEvolutionAt: ${fmtDate(report.lastEvolutionAt)} (${fmtAgo(report.lastEvolutionAt)})`);
  lines.push("");

  lines.push("Prompt Evolution");
  const currentPrompt = report.currentPatch?.agent?.systemPrompt;
  const currentPromptSummary = summarizePromptLines(currentPrompt, 5, 160);
  if (!currentPromptSummary.lines.length) {
    lines.push("- currentPrompt: unavailable");
  } else {
    lines.push("- currentPrompt:");
    for (const promptLine of currentPromptSummary.lines) {
      lines.push(`  • ${promptLine}`);
    }
    if (currentPromptSummary.truncated) {
      lines.push("  • …");
    }
  }
  const promptDiff = lastRun?.policyDiff?.systemPrompt || report.latestPromotionDiff?.systemPrompt || null;
  if (!promptDiff) {
    lines.push("- lastPromptDiff: none");
  } else {
    lines.push(
      `- lastPromptDiff: chars ${promptDiff.previousChars ?? "n/a"} -> ${promptDiff.nextChars ?? "n/a"} (${formatSignedNumber(promptDiff.deltaChars, 0)})`
    );
    const added = Array.isArray(promptDiff.addedLines) ? promptDiff.addedLines : [];
    const removed = Array.isArray(promptDiff.removedLines) ? promptDiff.removedLines : [];
    lines.push(`- addedLines: ${added.length ? added.slice(0, 4).join(" | ") : "none"}`);
    lines.push(`- removedLines: ${removed.length ? removed.slice(0, 4).join(" | ") : "none"}`);
  }
  lines.push("");

  lines.push("Recent Window (last 50 trajectories)");
  lines.push(`- sampleCount: ${metrics.sampleCount ?? 0}`);
  lines.push(`- successRate: ${fmtNumber(metrics.successRate)}`);
  lines.push(`- avgUserFeedback: ${fmtNumber(metrics.avgUserFeedback)}`);
  lines.push(`- avgSafetyIncidents: ${fmtNumber(metrics.avgSafetyIncidents)}`);
  lines.push(`- avgLatencyMs: ${fmtNumber(metrics.avgLatencyMs, 2)}`);
  lines.push(`- avgCostUsd: ${fmtNumber(metrics.avgCostUsd, 4)}`);
  const topTools = Array.isArray(metrics.topTools) ? metrics.topTools.slice(0, 5) : [];
  lines.push(`- topTools: ${topTools.length ? topTools.map((t) => `${t.toolName}:${t.calls}`).join(", ") : "none"}`);
  lines.push("");

  lines.push("Last Evolution Run");
  if (!lastRun) {
    lines.push("- none");
  } else {
    lines.push(`- runId: ${lastRun.runId || "n/a"} | source=${lastRun.source || "n/a"}`);
    lines.push(`- promoted: ${String(Boolean(lastRun.promoted))} | reason=${lastRun.reason || "n/a"}`);
    lines.push(`- duration: ${fmtDuration(lastRun.durationMs)}`);
    lines.push(
      `- aggregate: candidate=${fmtNumber(lastRun.candidateAggregate)} incumbent=${fmtNumber(lastRun.incumbentAggregate)}`
    );
    if (lastRun.policyDiff?.changedFields?.length) {
      lines.push(`- policyFieldsChanged: ${lastRun.policyDiff.changedFields.join(", ")}`);
    } else {
      lines.push("- policyFieldsChanged: none");
    }
    const toolChanges = lastRun.policyDiff?.topToolPreferenceChanges || [];
    if (Array.isArray(toolChanges) && toolChanges.length) {
      lines.push(`- topToolPreferenceDeltas: ${toolChanges.slice(0, 4).map(formatToolDelta).join(" | ")}`);
    } else {
      lines.push("- topToolPreferenceDeltas: none");
    }
  }
  lines.push("");

  lines.push("Recent Events");
  if (!recentEvents.length) {
    lines.push("- none");
  } else {
    for (const event of recentEvents.slice(-12)) {
      const runId = event.runId ? ` run=${event.runId}` : "";
      const reason = event.reason ? ` reason=${event.reason}` : "";
      lines.push(`- ${fmtDate(event.at)} ${event.type}${runId}${reason}`);
    }
  }

  return lines;
}

function clearScreenIfNeeded(enabled) {
  if (!enabled) return;
  process.stdout.write("\x1Bc");
}

function requestGatewayMethod(target, method, params = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.url);
    const connectRequestId = randomUUID();
    let methodRequestId = null;
    let connectAcked = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new Error(`gateway timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    function succeed(payload) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(payload);
    }

    function sendConnect() {
      const frame = {
        type: "req",
        id: connectRequestId,
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "cli",
            version: "claw-evolve-live-dashboard",
            platform: process.platform,
            mode: "cli",
            instanceId: randomUUID()
          },
          caps: [],
          role: "operator",
          scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
          ...(target.token || target.password
            ? {
                auth: {
                  ...(target.token ? { token: target.token } : {}),
                  ...(target.password ? { password: target.password } : {})
                }
              }
            : {})
        }
      };
      ws.send(JSON.stringify(frame));
    }

    ws.addEventListener("open", () => {
      sendConnect();
    });

    ws.addEventListener("error", (event) => {
      fail(new Error(event?.message || "gateway websocket error"));
    });

    ws.addEventListener("close", (event) => {
      if (settled) return;
      fail(new Error(`gateway closed (${event.code}): ${event.reason || "no close reason"}`));
    });

    ws.addEventListener("message", (message) => {
      let frame;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return;
      }

      if (frame?.type === "event" && frame?.event === "connect.challenge") {
        sendConnect();
        return;
      }

      if (frame?.type !== "res") return;
      if (frame.id === connectRequestId) {
        if (connectAcked) return;
        if (!frame.ok) {
          fail(new Error(frame?.error?.message || "gateway connect failed"));
          return;
        }
        connectAcked = true;
        methodRequestId = randomUUID();
        ws.send(
          JSON.stringify({
            type: "req",
            id: methodRequestId,
            method,
            params
          })
        );
        return;
      }

      if (frame.id === methodRequestId) {
        if (frame.ok) succeed(frame.payload);
        else fail(new Error(frame?.error?.message || `gateway method failed: ${method}`));
      }
    });
  });
}

async function fetchReport(target, timeoutMs) {
  return requestGatewayMethod(target, "claw_evolve_report", {}, timeoutMs);
}

async function maybeForceRun(target, args) {
  if (!args.forceRun) return null;
  const forceRunTimeoutMs = Math.max(120000, args.timeoutMs);
  return requestGatewayMethod(
    target,
    "claw_evolve_force_run",
    {
      generations: args.generations,
      populationSize: args.populationSize
    },
    forceRunTimeoutMs
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gateway = await readGatewayConfig();
  const target = resolveGatewayTarget(gateway.config, args);

  let forced = null;
  let forceRunWarning = null;
  if (args.forceRun) {
    try {
      forced = await maybeForceRun(target, args);
      if (forced && !args.json) {
        console.log(
          `Manual evolution requested: champion=${forced.championId} promoted=${String(forced.promoted)} duration=${fmtDuration(forced.durationMs)}`
        );
      }
    } catch (error) {
      forceRunWarning = String(error?.message || error);
    }
  }

  do {
    const fetchedAt = Date.now();
    let report;
    let error = null;
    try {
      report = await fetchReport(target, args.timeoutMs);
    } catch (err) {
      error = err;
    }

    if (args.json) {
      if (error) {
        console.error(
          JSON.stringify(
            {
              ok: false,
              at: fetchedAt,
              ...(forceRunWarning ? { forceRunWarning } : {}),
              error: String(error?.message || error),
              configPath: gateway.configPath,
              url: target.url
            },
            null,
            2
          )
        );
      } else {
        console.log(
          JSON.stringify(
            {
              ok: true,
              at: fetchedAt,
              ...(forceRunWarning ? { forceRunWarning } : {}),
              ...(forced ? { forced } : {}),
              report
            },
            null,
            2
          )
        );
      }
      if (args.once) break;
      await sleep(args.intervalMs);
      continue;
    }

    clearScreenIfNeeded(args.clear);
    if (error) {
      const lines = [
        "ClawEvolve Live Dashboard",
        `Fetched ${fmtDate(fetchedAt)} (${fmtAgo(fetchedAt)})`,
        "",
        ...(forceRunWarning
          ? [
              "Force-run warning",
              `- ${forceRunWarning}`,
              ""
            ]
          : []),
        "Error fetching claw_evolve_report",
        `- ${String(error?.message || error)}`,
        "",
        "Checks:",
        "- OpenClaw gateway is running",
        "- claw-evolve plugin is loaded",
        "- gateway token/auth is valid",
        "",
        `Gateway url: ${target.url}`,
        `Gateway config: ${gateway.configPath}`
      ];
      console.log(lines.join("\n"));
    } else {
      const warningPrefix = forceRunWarning
        ? [
            "Force-run warning",
            `- ${forceRunWarning}`,
            ""
          ]
        : [];
      const lines = toLinesReport(
        report,
        fetchedAt,
        args,
        `gateway=${target.url} | cfg=${gateway.configPath}`
      );
      console.log([...warningPrefix, ...lines].join("\n"));
    }

    if (args.once) break;
    await sleep(args.intervalMs);
  } while (true);
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
