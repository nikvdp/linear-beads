import { hostname } from "os";
import type { Issue, LinearIssue } from "../types.js";
import { isTerminalStatus } from "../types.js";
import {
  getAutoLabel,
  getIssueBackendKind,
  getRepoLabel,
  getRepoName,
  getRepoScope,
  isLocalOnly,
} from "./config.js";
import {
  getCachedIssue,
  getChildIds,
  getCurrentAgentHandle,
  getInverseDependencies,
  getParentId,
} from "./database.js";
import { getGraphQLClient, ISSUE_FRAGMENT } from "./graphql.js";
import {
  addComment,
  fetchIssue,
  getTeamId,
  getViewer,
  updateIssue,
} from "./issue-backend.js";
import { ensureRepoLabel, linearToBdIssue } from "./linear.js";
import {
  formatRemoteSyncPauseNotice,
  getCommandRemoteSyncPause,
} from "./remote-sync-state.js";
import { workerLabelName } from "./worker-identity.js";

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

export async function ensureLabel(teamId: string, name: string): Promise<string> {
  ensureLinearAutoMode();
  return ensureRepoLabel(teamId, { repoLabel: name });
}

export async function ensureAutoLabel(teamId: string): Promise<string> {
  return ensureLabel(teamId, getAutoLabel());
}

export function buildAutoIssueQuery(
  teamId: string,
  labelName: string
): { query: string; variables: Record<string, string> } {
  const variables: Record<string, string> = { teamId, labelName };
  let scopeFilter: string;

  if (getRepoScope() === "project") {
    variables.projectName = getRepoName() || "unknown";
    scopeFilter = `{ project: { name: { eq: $projectName } } }`;
  } else if (getRepoScope() === "both") {
    variables.repoLabel = getRepoLabel();
    variables.projectName = getRepoName() || "unknown";
    scopeFilter = `{ or: [{ labels: { name: { eq: $repoLabel } } }, { project: { name: { eq: $projectName } } }] }`;
  } else {
    variables.repoLabel = getRepoLabel();
    scopeFilter = `{ labels: { name: { eq: $repoLabel } } }`;
  }

  const varDecls = Object.keys(variables)
    .map((key) => `$${key}: String!`)
    .join(", ");
  return {
    variables,
    query: `
      query GetClaimableAutoIssues(${varDecls}) {
        team(id: $teamId) {
          issues(
            filter: { and: [
              ${scopeFilter},
              { labels: { name: { eq: $labelName } } },
              { state: { type: { eq: "unstarted" } } }
            ] },
            first: 50
          ) {
            nodes {
              ${ISSUE_FRAGMENT}
            }
          }
        }
      }
    `,
  };
}

async function hasOpenBlocker(issueId: string): Promise<boolean> {
  const blockers = getInverseDependencies(issueId).filter(
    (dependency) => dependency.type === "blocks"
  );
  for (const blocker of blockers) {
    const remote = await fetchIssue(blocker.issue_id);
    if (!remote || !isTerminalStatus(remote.status)) return true;
  }
  return false;
}

function hasOpenChildWork(issueId: string): boolean {
  return getChildIds(issueId).some((childId) => {
    const child = getCachedIssue(childId);
    return !child || !isTerminalStatus(child.status);
  });
}

async function hasBacklogAncestor(issueId: string): Promise<boolean> {
  const seen = new Set<string>();
  let parentId = getParentId(issueId);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = await fetchIssue(parentId);
    if (!parent) return true;
    if (parent.status === "backlog") return true;
    parentId = getParentId(parent.linear_identifier || parent.id);
  }
  return parentId !== null;
}

export async function fetchClaimableAutoIssues(
  teamId: string,
  options: { worker?: string } = {}
): Promise<Issue[]> {
  ensureLinearAutoMode();
  const autoLabel = getAutoLabel();
  const labelName = options.worker ? workerLabelName(options.worker) : autoLabel;
  await ensureLabel(teamId, labelName);

  const client = getGraphQLClient();
  const { query, variables } = buildAutoIssueQuery(teamId, labelName);
  const result = await client.request<{
    team: { issues: { nodes: LinearIssue[] } };
  }>(query, variables);
  const candidates = result.team.issues.nodes.filter(
    (candidate) =>
      options.worker ||
      !candidate.labels.nodes.some((label) => label.name.startsWith(`${autoLabel}:`))
  );

  const claimable: Issue[] = [];
  for (const candidate of candidates) {
    const issue = linearToBdIssue(candidate);
    const fresh = await fetchIssue(issue.linear_identifier || issue.id);
    if (!fresh || fresh.status !== "open") continue;

    const issueId = fresh.linear_identifier || fresh.id;
    if (await hasOpenBlocker(issueId)) continue;
    if (hasOpenChildWork(issueId)) continue;
    if (await hasBacklogAncestor(issueId)) continue;
    claimable.push(fresh);
  }

  return claimable.sort(
    (left, right) =>
      left.priority - right.priority ||
      new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
  );
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
