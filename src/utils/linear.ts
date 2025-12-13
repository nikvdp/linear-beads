/**
 * Linear API operations
 */

import { getGraphQLClient, ISSUE_FRAGMENT, ISSUE_WITH_RELATIONS_FRAGMENT } from "./graphql.js";
import { getRepoLabel, getTeamKey, getOption } from "./config.js";
import {
  cacheIssue,
  cacheIssues,
  cacheDependency,
  cacheLabel,
  getLabelIdByName,
  updateLastSync,
} from "./database.js";
import type { Issue, Dependency, IssueType, Priority, LinearIssue } from "../types.js";
import {
  linearStateToStatus,
  linearToPriority,
  labelToIssueType,
  priorityToLinear,
  issueTypeToLabel,
  statusToLinearState,
} from "../types.js";

/**
 * Convert Linear issue to bd-compatible issue
 */
function linearToBdIssue(linear: LinearIssue): Issue & { linear_state_id: string } {
  const labels = linear.labels.nodes.map((l) => l.name);

  return {
    id: linear.identifier,
    title: linear.title,
    description: linear.description || undefined,
    status: linearStateToStatus(linear.state.type),
    priority: linearToPriority(linear.priority),
    issue_type: labelToIssueType(labels),
    created_at: linear.createdAt,
    updated_at: linear.updatedAt,
    closed_at: linear.completedAt || linear.canceledAt || undefined,
    assignee: linear.assignee?.email || undefined,
    linear_state_id: linear.state.id,
  };
}

/**
 * Get or create repo label
 */
export async function ensureRepoLabel(teamId: string): Promise<string> {
  const client = getGraphQLClient();
  const repoLabel = getRepoLabel();

  // Check cache first
  const cachedId = getLabelIdByName(repoLabel);
  if (cachedId) return cachedId;

  // Query existing labels
  const query = `
    query GetLabels($teamId: String!) {
      team(id: $teamId) {
        labels {
          nodes {
            id
            name
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: { labels: { nodes: Array<{ id: string; name: string }> } };
  }>(query, { teamId });

  const existing = result.team.labels.nodes.find((l) => l.name === repoLabel);
  if (existing) {
    cacheLabel(existing.id, existing.name, teamId);
    return existing.id;
  }

  // Create label
  const createMutation = `
    mutation CreateLabel($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) {
        success
        issueLabel {
          id
          name
        }
      }
    }
  `;

  const createResult = await client.request<{
    issueLabelCreate: {
      success: boolean;
      issueLabel: { id: string; name: string };
    };
  }>(createMutation, {
    input: {
      name: repoLabel,
      teamId,
    },
  });

  if (!createResult.issueLabelCreate.success) {
    throw new Error(`Failed to create repo label: ${repoLabel}`);
  }

  cacheLabel(
    createResult.issueLabelCreate.issueLabel.id,
    createResult.issueLabelCreate.issueLabel.name,
    teamId
  );

  return createResult.issueLabelCreate.issueLabel.id;
}

/**
 * Ensure issue type label exists
 */
export async function ensureTypeLabel(teamId: string, type: IssueType): Promise<string> {
  const client = getGraphQLClient();
  const labelName = issueTypeToLabel(type);

  // Check cache first
  const cachedId = getLabelIdByName(labelName);
  if (cachedId) return cachedId;

  // Query existing labels
  const query = `
    query GetLabels($teamId: String!) {
      team(id: $teamId) {
        labels {
          nodes {
            id
            name
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: { labels: { nodes: Array<{ id: string; name: string }> } };
  }>(query, { teamId });

  const existing = result.team.labels.nodes.find((l) => l.name === labelName);
  if (existing) {
    cacheLabel(existing.id, existing.name, teamId);
    return existing.id;
  }

  // Create label
  const createMutation = `
    mutation CreateLabel($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) {
        success
        issueLabel {
          id
          name
        }
      }
    }
  `;

  const createResult = await client.request<{
    issueLabelCreate: {
      success: boolean;
      issueLabel: { id: string; name: string };
    };
  }>(createMutation, {
    input: {
      name: labelName,
      teamId,
    },
  });

  if (!createResult.issueLabelCreate.success) {
    throw new Error(`Failed to create type label: ${labelName}`);
  }

  cacheLabel(
    createResult.issueLabelCreate.issueLabel.id,
    createResult.issueLabelCreate.issueLabel.name,
    teamId
  );

  return createResult.issueLabelCreate.issueLabel.id;
}

/**
 * Get team ID from team key, or auto-detect if not provided
 */
export async function getTeamId(teamKey?: string): Promise<string> {
  const client = getGraphQLClient();
  const key = teamKey || getTeamKey();

  // If team key is provided, look it up
  if (key) {
    const query = `
      query GetTeam($key: String!) {
        teams(filter: { key: { eq: $key } }) {
          nodes {
            id
            key
            name
          }
        }
      }
    `;

    const result = await client.request<{
      teams: { nodes: Array<{ id: string; key: string; name: string }> };
    }>(query, { key });

    if (result.teams.nodes.length === 0) {
      throw new Error(`Team not found: ${key}`);
    }

    return result.teams.nodes[0].id;
  }

  // No team key provided - auto-detect from user's teams
  const query = `
    query GetTeams {
      teams {
        nodes {
          id
          key
          name
        }
      }
    }
  `;

  const result = await client.request<{
    teams: { nodes: Array<{ id: string; key: string; name: string }> };
  }>(query);

  if (result.teams.nodes.length === 0) {
    throw new Error("No teams found for this Linear account.");
  }

  if (result.teams.nodes.length === 1) {
    // Auto-select single team
    const team = result.teams.nodes[0];
    return team.id;
  }

  // Multiple teams - ask user to specify
  const teamList = result.teams.nodes.map((t) => `  - ${t.name} (${t.key})`).join("\n");
  throw new Error(`Multiple teams found. Please set LB_TEAM_KEY or use --team flag:\n${teamList}`);
}

/**
 * Get workflow state ID for a status
 */
export async function getWorkflowStateId(teamId: string, status: Issue["status"]): Promise<string> {
  const client = getGraphQLClient();
  const stateType = statusToLinearState(status);

  const query = `
    query GetWorkflowStates($teamId: String!) {
      team(id: $teamId) {
        states {
          nodes {
            id
            name
            type
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: { states: { nodes: Array<{ id: string; name: string; type: string }> } };
  }>(query, { teamId });

  const state = result.team.states.nodes.find((s) => s.type === stateType);
  if (!state) {
    throw new Error(`Workflow state not found for type: ${stateType}`);
  }

  return state.id;
}

/**
 * Fetch issues from Linear with repo scoping
 * Uses a simplified query to avoid Linear API complexity limits
 */
export async function fetchIssues(teamId: string): Promise<Issue[]> {
  const client = getGraphQLClient();
  const repoLabel = getRepoLabel();

  // Use simpler query without nested children/relations to avoid complexity limits
  const query = `
    query GetIssues($teamId: String!, $labelName: String!) {
      team(id: $teamId) {
        issues(filter: { labels: { name: { eq: $labelName } } }, first: 100) {
          nodes {
            ${ISSUE_FRAGMENT}
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: { issues: { nodes: LinearIssue[] } };
  }>(query, { teamId, labelName: repoLabel });

  const issues = result.team.issues.nodes.map(linearToBdIssue);

  // Cache issues
  cacheIssues(issues);

  // Cache parent-child relations from the basic query
  for (const linear of result.team.issues.nodes) {
    if (linear.parent) {
      cacheDependency({
        issue_id: linear.identifier,
        depends_on_id: linear.parent.identifier,
        type: "parent-child",
        created_at: linear.createdAt,
        created_by: "sync",
      });
    }
  }

  // Note: We don't fetch relations on bulk sync (too slow - O(n) network calls).
  // Relations are fetched on-demand via `lb show <id> --sync`.
  // This means `lb ready` may show blocked issues until their blockers are synced individually.

  updateLastSync();
  return issues;
}

/**
 * Fetch relations for a set of issues (exported for background worker)
 * Fetches in parallel batches for speed
 */
export async function fetchRelations(issueIds: string[]): Promise<void> {
  const client = getGraphQLClient();
  const BATCH_SIZE = 10; // Parallel requests per batch

  const query = `
    query GetIssueRelations($id: String!) {
      issue(id: $id) {
        identifier
        relations {
          nodes {
            type
            relatedIssue {
              identifier
            }
          }
        }
      }
    }
  `;

  // Process in parallel batches
  for (let i = 0; i < issueIds.length; i += BATCH_SIZE) {
    const batch = issueIds.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (issueId) => {
        try {
          const result = await client.request<{
            issue: {
              identifier: string;
              relations: {
                nodes: Array<{
                  type: string;
                  relatedIssue: { identifier: string };
                }>;
              };
            } | null;
          }>(query, { id: issueId });

          if (result.issue?.relations?.nodes) {
            for (const rel of result.issue.relations.nodes) {
              cacheDependency({
                issue_id: result.issue.identifier,
                depends_on_id: rel.relatedIssue.identifier,
                type: rel.type === "blocks" ? "blocks" : "related",
                created_at: new Date().toISOString(),
                created_by: "sync",
              });
            }
          }
        } catch {
          // Ignore errors for individual relation fetches
        }
      })
    );
  }
}

/**
 * Fetch single issue by ID
 */
export async function fetchIssue(issueId: string): Promise<Issue | null> {
  const client = getGraphQLClient();

  const query = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        ${ISSUE_WITH_RELATIONS_FRAGMENT}
      }
    }
  `;

  try {
    const result = await client.request<{ issue: LinearIssue | null }>(query, {
      id: issueId,
    });

    if (!result.issue) return null;

    const issue = linearToBdIssue(result.issue);
    cacheIssue(issue);

    // Cache parent-child relation
    if (result.issue.parent) {
      cacheDependency({
        issue_id: result.issue.identifier,
        depends_on_id: result.issue.parent.identifier,
        type: "parent-child",
        created_at: result.issue.createdAt,
        created_by: "sync",
      });
    }

    // Cache other relations
    if (result.issue.relations?.nodes) {
      for (const rel of result.issue.relations.nodes) {
        cacheDependency({
          issue_id: result.issue.identifier,
          depends_on_id: rel.relatedIssue.identifier,
          type: rel.type === "blocks" ? "blocks" : "related",
          created_at: result.issue.createdAt,
          created_by: "sync",
        });
      }
    }

    return issue;
  } catch {
    return null;
  }
}

/**
 * Resolve issue identifier (e.g., LIN-123) to UUID
 */
export async function resolveIssueId(issueId: string): Promise<string | null> {
  const client = getGraphQLClient();

  const query = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id
      }
    }
  `;

  try {
    const result = await client.request<{ issue: { id: string } | null }>(query, {
      id: issueId,
    });
    return result.issue?.id || null;
  } catch {
    return null;
  }
}

/**
 * Create issue in Linear
 */
export async function createIssue(params: {
  title: string;
  description?: string;
  priority: Priority;
  issueType: IssueType;
  teamId: string;
  parentId?: string;
  assigneeId?: string;
  status?: IssueStatus;
}): Promise<Issue> {
  const client = getGraphQLClient();

  // Get required labels
  const repoLabelId = await ensureRepoLabel(params.teamId);
  const typeLabelId = await ensureTypeLabel(params.teamId, params.issueType);
  const stateId = await getWorkflowStateId(params.teamId, params.status || "open");

  // Resolve parentId if provided (identifier -> UUID)
  let parentUuid: string | undefined;
  if (params.parentId) {
    parentUuid = (await resolveIssueId(params.parentId)) || undefined;
    if (!parentUuid) {
      throw new Error(`Parent issue not found: ${params.parentId}`);
    }
  }

  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          ${ISSUE_FRAGMENT}
        }
      }
    }
  `;

  const input: Record<string, unknown> = {
    title: params.title,
    description: params.description,
    priority: priorityToLinear(params.priority),
    teamId: params.teamId,
    stateId,
    labelIds: [repoLabelId, typeLabelId],
    parentId: parentUuid,
  };

  if (params.assigneeId) {
    input.assigneeId = params.assigneeId;
  }

  const result = await client.request<{
    issueCreate: { success: boolean; issue: LinearIssue | null };
  }>(mutation, { input });

  if (!result.issueCreate.success || !result.issueCreate.issue) {
    throw new Error("Failed to create issue");
  }

  const issue = linearToBdIssue(result.issueCreate.issue);
  cacheIssue(issue);
  return issue;
}

/**
 * Update issue in Linear
 */
export async function updateIssue(
  issueId: string,
  updates: {
    title?: string;
    description?: string;
    status?: Issue["status"];
    priority?: Priority;
    assigneeId?: string | null;
  },
  teamId: string
): Promise<Issue> {
  const client = getGraphQLClient();

  // Build input
  const input: Record<string, unknown> = {};
  if (updates.title) input.title = updates.title;
  if (updates.description !== undefined) input.description = updates.description;
  if (updates.priority !== undefined) input.priority = priorityToLinear(updates.priority);
  if (updates.status) {
    input.stateId = await getWorkflowStateId(teamId, updates.status);
  }
  if (updates.assigneeId !== undefined) {
    input.assigneeId = updates.assigneeId;
  }

  const mutation = `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          ${ISSUE_FRAGMENT}
        }
      }
    }
  `;

  const result = await client.request<{
    issueUpdate: { success: boolean; issue: LinearIssue | null };
  }>(mutation, { id: issueId, input });

  if (!result.issueUpdate.success || !result.issueUpdate.issue) {
    throw new Error("Failed to update issue");
  }

  const issue = linearToBdIssue(result.issueUpdate.issue);
  cacheIssue(issue);
  return issue;
}

/**
 * Update issue parent in Linear
 */
export async function updateIssueParent(issueId: string, parentId: string): Promise<void> {
  const client = getGraphQLClient();

  // Resolve parentId if it's an identifier
  const parentUuid = (await resolveIssueId(parentId)) || parentId;

  const mutation = `
    mutation UpdateIssueParent($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
      }
    }
  `;

  const result = await client.request<{
    issueUpdate: { success: boolean };
  }>(mutation, { id: issueId, input: { parentId: parentUuid } });

  if (!result.issueUpdate.success) {
    throw new Error("Failed to set parent");
  }
}

/**
 * Close issue in Linear
 */
export async function closeIssue(issueId: string, teamId: string, reason?: string): Promise<Issue> {
  const client = getGraphQLClient();
  const stateId = await getWorkflowStateId(teamId, "closed");

  // Build input - add reason as comment if provided
  const input: Record<string, unknown> = { stateId };

  const mutation = `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          ${ISSUE_FRAGMENT}
        }
      }
    }
  `;

  const result = await client.request<{
    issueUpdate: { success: boolean; issue: LinearIssue | null };
  }>(mutation, { id: issueId, input });

  if (!result.issueUpdate.success || !result.issueUpdate.issue) {
    throw new Error("Failed to close issue");
  }

  // Add close reason as comment if provided
  if (reason) {
    const commentMutation = `
      mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
        }
      }
    `;
    await client.request(commentMutation, {
      input: {
        issueId,
        body: `Closed: ${reason}`,
      },
    });
  }

  const issue = linearToBdIssue(result.issueUpdate.issue);
  cacheIssue(issue);
  return issue;
}

/**
 * Create relation between issues
 */
export async function createRelation(
  issueId: string,
  relatedIssueId: string,
  type: "blocks" | "related"
): Promise<void> {
  const client = getGraphQLClient();

  // Resolve identifiers to UUIDs
  const issueUuid = (await resolveIssueId(issueId)) || issueId;
  const relatedUuid = (await resolveIssueId(relatedIssueId)) || relatedIssueId;

  const mutation = `
    mutation CreateRelation($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) {
        success
      }
    }
  `;

  const result = await client.request<{
    issueRelationCreate: { success: boolean };
  }>(mutation, {
    input: {
      issueId: issueUuid,
      relatedIssueId: relatedUuid,
      type,
    },
  });

  if (!result.issueRelationCreate.success) {
    throw new Error("Failed to create relation");
  }

  // Cache the dependency
  cacheDependency({
    issue_id: issueId,
    depends_on_id: relatedIssueId,
    type,
    created_at: new Date().toISOString(),
    created_by: "user",
  });
}

/**
 * Add comment to an issue
 */
export async function addComment(issueId: string, body: string): Promise<void> {
  const client = getGraphQLClient();

  const mutation = `
    mutation CreateComment($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
      }
    }
  `;

  const result = await client.request<{
    commentCreate: { success: boolean };
  }>(mutation, {
    input: {
      issueId,
      body,
    },
  });

  if (!result.commentCreate.success) {
    throw new Error("Failed to create comment");
  }
}

/**
 * Verify API connection
 */
export async function verifyConnection(): Promise<{
  userId: string;
  userName: string;
  teams: Array<{ id: string; key: string; name: string }>;
}> {
  const client = getGraphQLClient();

  const query = `
    query Viewer {
      viewer {
        id
        name
      }
      teams {
        nodes {
          id
          key
          name
        }
      }
    }
  `;

  const result = await client.request<{
    viewer: { id: string; name: string };
    teams: { nodes: Array<{ id: string; key: string; name: string }> };
  }>(query);

  return {
    userId: result.viewer.id,
    userName: result.viewer.name,
    teams: result.teams.nodes,
  };
}

/**
 * Get current user (viewer) - for auto-assign
 */
export async function getViewer(): Promise<{ id: string; email: string; name: string }> {
  const client = getGraphQLClient();

  const query = `
    query Viewer {
      viewer {
        id
        email
        name
      }
    }
  `;

  const result = await client.request<{
    viewer: { id: string; email: string; name: string };
  }>(query);

  return result.viewer;
}

/**
 * Find user by email
 */
export async function getUserByEmail(
  email: string
): Promise<{ id: string; email: string; name: string } | null> {
  const client = getGraphQLClient();

  const query = `
    query GetUser($email: String!) {
      users(filter: { email: { eq: $email } }) {
        nodes {
          id
          email
          name
        }
      }
    }
  `;

  const result = await client.request<{
    users: { nodes: Array<{ id: string; email: string; name: string }> };
  }>(query, { email });

  return result.users.nodes[0] || null;
}
