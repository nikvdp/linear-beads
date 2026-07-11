import { hostname } from "os";
import type { Issue } from "../types.js";
import { getIssueBackendKind, isLocalOnly } from "./config.js";
import { getCurrentAgentHandle } from "./database.js";
import {
  addComment,
  fetchIssue,
  getTeamId,
  getViewer,
  updateIssue,
} from "./issue-backend.js";
import {
  formatRemoteSyncPauseNotice,
  getCommandRemoteSyncPause,
} from "./remote-sync-state.js";

export class ClaimLostError extends Error {
  constructor(public readonly issueId: string) {
    super(`Issue ${issueId} is no longer available to claim.`);
    this.name = "ClaimLostError";
  }
}

function ensureLinearAutoMode(): void {
  if (isLocalOnly() || getIssueBackendKind() === "local") {
    throw new Error("Auto mode requires the Linear issue backend.");
  }
}

export async function claimAutoIssue(
  issue: Issue,
  options: { runId: string; worker?: string }
): Promise<Issue> {
  ensureLinearAutoMode();

  const remotePause = await getCommandRemoteSyncPause();
  if (remotePause) {
    throw new Error(formatRemoteSyncPauseNotice(remotePause, { prefix: "Cannot claim:" }));
  }

  const issueId = issue.linear_identifier || issue.id;
  const fresh = await fetchIssue(issueId);
  if (!fresh || fresh.status !== "open") {
    throw new ClaimLostError(issueId);
  }

  // Auto claims must be confirmed by Linear synchronously; never route this
  // mutation through the local outbox.
  const [teamId, viewer] = await Promise.all([getTeamId(), getViewer()]);
  const claimed = await updateIssue(
    fresh.linear_identifier || fresh.id,
    { status: "in_progress", assigneeId: viewer.id },
    teamId
  );

  const host = hostname();
  const claimant = options.worker || getCurrentAgentHandle() || host;
  try {
    await addComment(
      claimed.linear_identifier || claimed.id,
      `🤖 claimed by ${claimant} on ${host} (run ${options.runId})`
    );
  } catch (error) {
    console.warn(
      `Claimed ${issueId}, but could not post the claim comment: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return claimed;
}
