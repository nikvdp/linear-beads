import { Command } from "commander";
import type { Issue } from "../types.js";
import {
  assertAutoModeAvailable,
  ClaimLostError,
  claimAutoIssue,
  ensureAutoLabel,
  fetchClaimableAutoIssues,
} from "../utils/auto.js";
import { getAutoLabel, getAutoPollIntervalMs } from "../utils/config.js";
import { generateAgentRunId } from "../utils/database.js";
import { getTeamId } from "../utils/issue-backend.js";
import { output, outputError } from "../utils/output.js";
import { resolveWorkerName, workerLabelName } from "../utils/worker-identity.js";
import { createRunWorktree, getRepoRoot } from "../utils/worktree.js";

const DEFAULT_WAIT_TIMEOUT_MS = 480000;

export type AutoNextPayload =
  | { status: "no_work"; message: string }
  | { status: "claimed"; issue: Issue; workdir: string | null; instructions: string };

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
