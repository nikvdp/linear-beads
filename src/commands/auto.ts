import { Command } from "commander";
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "fs";
import { dirname, join } from "path";
import type { AgentRun, Issue, IssueStatus } from "../types.js";
import { isTerminalStatus } from "../types.js";
import {
  assertAutoModeAvailable,
  ClaimLostError,
  claimAutoIssue,
  ensureAutoLabel,
  fetchClaimableAutoIssues,
} from "../utils/auto.js";
import {
  getAutoAgentName,
  getAutoAgentTemplate,
  getAutoLabel,
  getAutoPollIntervalMs,
  getDbPath,
} from "../utils/config.js";
import {
  generateAgentRunId,
  getAgentRun,
  getCachedIssue,
  getDisplayId,
  getRunningAgentRuns,
  listAgentRuns,
  resolveIssueId,
  resolveIssueLocalId,
  updateAgentRun,
} from "../utils/database.js";
import { fetchIssue, getTeamId } from "../utils/issue-backend.js";
import { output, outputError } from "../utils/output.js";
import { isProcessAlive } from "../utils/pid-manager.js";
import {
  formatRemoteSyncPauseNotice,
  getBlockingAutomaticRemoteSyncPause,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";
import { spawnAgentRun } from "../utils/agent-runner.js";
import { resolveWorkerName, workerLabelName } from "../utils/worker-identity.js";
import { createRunWorktree, getRepoRoot } from "../utils/worktree.js";

const DEFAULT_WAIT_TIMEOUT_MS = 480000;

export type AutoNextPayload =
  | { status: "no_work"; message: string }
  | { status: "claimed"; issue: Issue; workdir: string | null; instructions: string };

export type ObservedAgentRun = AgentRun & { pid_alive: boolean; live_state: string };

export function resolveAutoWaitTimeoutMs(
  cliValue?: string,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = cliValue || env.LB_AUTO_WAIT_TIMEOUT_MS;
  if (!raw) return DEFAULT_WAIT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--timeout-ms must be a positive integer.");
  }
  return parsed;
}

export function noWorkPayload(label: string): AutoNextPayload {
  return {
    status: "no_work",
    message: `No work labeled ${label} is ready. This is not an error. Run \`lb auto next --wait\` again to continue polling.`,
  };
}

export function nextAutoPollDelayMs(deadline: number, pollMs: number, now = Date.now()): number {
  return Math.min(pollMs, Math.max(0, deadline - now));
}

export function resolveAutoRunPollMs(cliValue?: string): number {
  if (!cliValue) return getAutoPollIntervalMs();
  const seconds = Number(cliValue);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("--poll-interval-seconds must be a positive number.");
  }
  return seconds * 1000;
}

export function claimedPayload(issue: Issue, workdir: string | null): AutoNextPayload {
  const id = issue.linear_identifier || issue.id;
  const location = workdir ? `cd to ${workdir}, ` : "";
  return {
    status: "claimed",
    issue,
    workdir,
    instructions: `You have claimed this ticket. ${location}create a branch first, implement the ticket, commit, then \`lb close ${id} --reason ...\`.`,
  };
}

export function observeAgentRun(run: AgentRun): ObservedAgentRun {
  const pidAlive = run.pid !== undefined && isProcessAlive(run.pid);
  const liveState =
    run.status === "running" && !pidAlive
      ? "stale (pid dead — will be reaped by lb auto run)"
      : run.status;
  return { ...run, pid_alive: pidAlive, live_state: liveState };
}

export function decideReapedRunStatus(
  pidAlive: boolean,
  issueStatus?: IssueStatus
): "running" | "done" | "flagged" | null {
  if (pidAlive) return "running";
  if (!issueStatus) return null;
  return isTerminalStatus(issueStatus) ? "done" : "flagged";
}

export function formatRelativeTime(isoDate: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(isoDate).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function tailLogFile(path: string, lineCount: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 64 * 1024);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    let lines = buffer.toString("utf-8").split(/\r?\n/);
    if (start > 0) lines = lines.slice(1);
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-lineCount).join("\n");
  } finally {
    closeSync(fd);
  }
}

function parseLogLineCount(value: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("--lines must be a positive integer.");
  }
  return count;
}

function resolveAgentRun(reference: string): AgentRun | null {
  const exact = getAgentRun(reference);
  if (exact) return exact;

  const displayId = resolveIssueId(reference);
  const localId = resolveIssueLocalId(displayId);
  return (
    listAgentRuns().find(
      (run) => run.issue_id === localId || getDisplayId(run.issue_id) === displayId
    ) || null
  );
}

function formatRunTable(runs: ObservedAgentRun[]): string {
  const rows = runs.map((run) => [
    run.id,
    getDisplayId(run.issue_id),
    run.agent_name,
    run.pid?.toString() || "-",
    run.live_state,
    formatRelativeTime(run.created_at),
    run.log_path || "-",
  ]);
  const allRows = [["RUN", "TICKET", "AGENT", "PID", "STATE", "STARTED", "LOG"], ...rows];
  const widths = allRows[0].map((_, index) =>
    Math.max(...allRows.map((row) => row[index].length))
  );
  return allRows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd())
    .join("\n");
}

function readAppendedLog(path: string, offset: number): { text: string; offset: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size < offset ? 0 : offset;
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf-8"), offset: size };
  } finally {
    closeSync(fd);
  }
}

async function tryClaim(
  teamId: string,
  worker?: string
): Promise<{ issue: Issue; runId: string } | null> {
  const candidates = await fetchClaimableAutoIssues(teamId, { worker });
  for (const candidate of candidates) {
    const runId = generateAgentRunId();
    try {
      return { issue: await claimAutoIssue(candidate, { runId, worker }), runId };
    } catch (error) {
      if (!(error instanceof ClaimLostError)) throw error;
    }
  }
  return null;
}

async function reapRunningAgentRuns(remotePaused: boolean): Promise<number> {
  let liveRuns = 0;
  for (const run of getRunningAgentRuns()) {
    if (run.pid !== undefined && isProcessAlive(run.pid)) {
      liveRuns++;
      continue;
    }

    const ticketId = getDisplayId(run.issue_id);
    const remoteIssue = remotePaused ? null : await fetchIssue(ticketId);
    const issue = remoteIssue || getCachedIssue(run.issue_id);
    const nextStatus = decideReapedRunStatus(false, issue?.status);
    if (!nextStatus) {
      console.warn(
        `Run ${run.id} has exited, but ticket ${ticketId} could not be loaded; leaving the run pending for the next check.`
      );
      continue;
    }

    if (nextStatus === "done") {
      updateAgentRun(run.id, { status: "done", ended_at: new Date().toISOString() });
      continue;
    }

    updateAgentRun(run.id, { status: "flagged", ended_at: new Date().toISOString() });
    console.error(
      `Warning: ${ticketId} / run ${run.id} / log ${run.log_path || "(not recorded)"}: agent exited but the ticket is still open; review the log and either close the ticket or set it back to open.`
    );
  }
  return liveRuns;
}

export const autoCommand = new Command("auto").description("Claim and run auto-labeled work");

autoCommand
  .command("next")
  .description("Claim the next ready auto-labeled ticket")
  .option("--wait", "Wait for work to become ready")
  .option("--timeout-ms <ms>", "Maximum wait before returning no_work")
  .option("--worktree", "Create a detached worktree for the claimed ticket")
  .option("--worker <name>", "Poll only the targeted queue for this worker")
  .option("-j, --json", "Output as JSON (the default for this command)")
  .action(async (options) => {
    try {
      const worker = resolveWorkerName(options.worker);
      const queueLabel = worker ? workerLabelName(worker) : getAutoLabel();
      const timeoutMs = resolveAutoWaitTimeoutMs(options.timeoutMs);
      const pollMs = getAutoPollIntervalMs();
      const deadline = Date.now() + timeoutMs;
      assertAutoModeAvailable();
      const teamId = await getTeamId();
      await ensureAutoLabel(teamId);

      while (true) {
        const claimed = await tryClaim(teamId, worker);
        if (claimed) {
          let workdir: string | null = null;
          if (options.worktree) {
            try {
              workdir = createRunWorktree(getRepoRoot(), claimed.runId);
            } catch (error) {
              console.warn(
                `Claimed ${claimed.issue.id}, but could not create its worktree: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
          output(JSON.stringify(claimedPayload(claimed.issue, workdir), null, 2));
          return;
        }

        // no_work is an expected re-arm signal for agents, not a command error.
        if (!options.wait || Date.now() >= deadline) {
          output(JSON.stringify(noWorkPayload(queueLabel), null, 2));
          return;
        }
        await Bun.sleep(nextAutoPollDelayMs(deadline, pollMs));
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

autoCommand
  .command("ps")
  .description("Show daemon-spawned agent runs")
  .option("--all", "Include completed runs")
  .option("-j, --json", "Output as JSON")
  .action((options) => {
    try {
      const stored = listAgentRuns().filter(
        (run) => options.all || run.status === "running" || run.status === "flagged"
      );
      const runs = stored.map(observeAgentRun);
      if (options.json) {
        output(JSON.stringify(runs, null, 2));
      } else if (runs.length === 0) {
        output("No agent runs.");
      } else {
        output(formatRunTable(runs));
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

autoCommand
  .command("run")
  .description("Poll for auto-labeled work and run one agent at a time")
  .option("--agent-name <name>", "Configured auto_agents template to launch")
  .option("--worker <name>", "Serve only the targeted queue for this worker")
  .option("--poll-interval-seconds <n>", "Polling interval override")
  .option("--once", "Run one reap/claim iteration and exit")
  .action(async (options) => {
    try {
      assertAutoModeAvailable();
      const worker = resolveWorkerName(options.worker);
      const queueLabel = worker ? workerLabelName(worker) : getAutoLabel();
      const agentName = getAutoAgentName(options.agentName);
      if (!getAutoAgentTemplate(agentName)) {
        throw new Error(
          `No auto_agents command template is configured for agent '${agentName}'.`
        );
      }
      const pollMs = resolveAutoRunPollMs(options.pollIntervalSeconds);
      const teamId = await getTeamId();
      await ensureAutoLabel(teamId);
      output(`Auto runner watching ${queueLabel} with agent ${agentName}.`);

      let backoffMs = pollMs;
      while (true) {
        try {
          const activePause = getBlockingAutomaticRemoteSyncPause();
          const liveRuns = await reapRunningAgentRuns(Boolean(activePause));
          if (liveRuns === 0) {
            if (activePause) {
              throw new Error(
                formatRemoteSyncPauseNotice(activePause, { prefix: "Auto runner:" })
              );
            }

            const claimed = await tryClaim(teamId, worker);
            if (claimed) {
              const repoRoot = getRepoRoot();
              const workdir = createRunWorktree(repoRoot, claimed.runId);
              const logPath = join(dirname(getDbPath()), "runs", `${claimed.runId}.log`);
              spawnAgentRun({
                issue: claimed.issue,
                runId: claimed.runId,
                workdir,
                logPath,
                agentName,
                worker,
              });
              output(
                `Claimed ${claimed.issue.linear_identifier || claimed.issue.id} → run ${claimed.runId}, log ${logPath}`
              );
            }
          }
          backoffMs = pollMs;
        } catch (error) {
          recordRemoteSyncPause(error);
          backoffMs = Math.min(backoffMs * 2, 5 * 60 * 1000);
          outputError(
            `Auto runner tick failed; retrying in ${Math.ceil(backoffMs / 1000)}s: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          if (options.once) {
            process.exitCode = 1;
            return;
          }
        }

        if (options.once) return;
        await Bun.sleep(backoffMs);
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

autoCommand
  .command("logs")
  .description("Show logs for an agent run or ticket")
  .argument("<run-id-or-ticket-id>", "Run ID or ticket ID")
  .option("-f, --follow", "Follow appended log output")
  .option("-n, --lines <count>", "Number of trailing lines", "100")
  .action(async (reference: string, options) => {
    try {
      const lineCount = parseLogLineCount(options.lines);
      const run = resolveAgentRun(reference);
      if (!run) throw new Error(`No agent run found for '${reference}'.`);
      const path = run.log_path || "(no log path recorded)";
      if (!run.log_path || !existsSync(run.log_path)) {
        throw new Error(`Agent run log does not exist at ${path}.`);
      }

      const tail = tailLogFile(run.log_path, lineCount);
      if (tail) process.stdout.write(`${tail}\n`);
      if (!options.follow) return;

      let offset = statSync(run.log_path).size;
      while (run.pid !== undefined && isProcessAlive(run.pid)) {
        await Bun.sleep(500);
        const appended = readAppendedLog(run.log_path, offset);
        offset = appended.offset;
        if (appended.text) process.stdout.write(appended.text);
      }
      output(`Run ${run.id} is no longer active; stopped following its log.`);
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
