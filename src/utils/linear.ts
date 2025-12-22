/**
 * Linear API operations
 */

import { getGraphQLClient, ISSUE_FRAGMENT, ISSUE_WITH_RELATIONS_FRAGMENT } from "./graphql.js";
import { getRepoLabel, getTeamKey, useTypes } from "./config.js";
import {
  cacheIssue,
  cacheIssues,
  cacheDependency,
  clearIssueDependencies,
  clearIssuesCache,
  cacheLabel,
  getLabelIdByName,
  updateLastSync,
} from "./database.js";
import type { Issue, IssueType, Priority, LinearIssue, IssueStatus } from "../types.js";
import {
  linearStateToStatus,
  linearToPriority,
  labelToIssueType,
  priorityToLinear,
  statusToLinearState,
} from "../types.js";

/**
 * Convert Linear issue to bd-compatible issue
 */
function linearToBdIssue(linear: LinearIssue): Issue & { linear_state_id: string } {
  const labels = linear.labels.nodes.map((l) => l.name);
  const issueType = useTypes() ? labelToIssueType(labels) : undefined;

  const issue: Issue & { linear_state_id: string } = {
    id: linear.identifier,
    title: linear.title,
    description: linear.description || undefined,
    status: linearStateToStatus(linear.state.type),
    priority: linearToPriority(linear.priority),
    created_at: linear.createdAt,
    updated_at: linear.updatedAt,
    closed_at: linear.completedAt || linear.canceledAt || undefined,
    assignee: linear.assignee?.email || undefined,
    linear_state_id: linear.state.id,
  };

  if (issueType) {
    issue.issue_type = issueType;
  }

  return issue;
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
 * Ensure issue type label exists in label group
 * Uses Linear label groups for proper categorization
 */
export async function ensureTypeLabel(teamId: string, type: IssueType): Promise<string> {
  const client = getGraphQLClient();
  const groupName = "Type";
  // Label names are capitalized (e.g., "Bug", "Feature")
  const labelName = type.charAt(0).toUpperCase() + type.slice(1);

  // Check cache first
  const cachedId = getLabelIdByName(labelName);
  if (cachedId) return cachedId;

  // Query existing labels and label groups
  const query = `
    query GetLabelsAndGroups($teamId: String!) {
      team(id: $teamId) {
        labels {
          nodes {
            id
            name
            parent {
              id
              name
            }
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: {
      labels: {
        nodes: Array<{
          id: string;
          name: string;
          parent?: { id: string; name: string } | null;
        }>;
      };
    };
  }>(query, { teamId });

  // Look for existing label in the Type group (or matching name)
  const existing = result.team.labels.nodes.find(
    (l) =>
      l.name.toLowerCase() === labelName.toLowerCase() &&
      (l.parent?.name === groupName || !l.parent)
  );
  if (existing) {
    cacheLabel(existing.id, existing.name, teamId);
    return existing.id;
  }

  // Find or create the label group
  let groupId: string | undefined;
  const existingGroup = result.team.labels.nodes.find(
    (l) => l.parent?.name === groupName
  )?.parent;
  
  if (existingGroup) {
    groupId = existingGroup.id;
  } else {
    // Create the label group
    const createGroupMutation = `
      mutation CreateLabelGroup($teamId: String!, $name: String!) {
        issueLabelCreate(input: { name: $name, teamId: $teamId }) {
          success
          issueLabel {
            id
            name
          }
        }
      }
    `;
    
    const groupResult = await client.request<{
      issueLabelCreate: {
        success: boolean;
        issueLabel: { id: string; name: string };
      };
    }>(createGroupMutation, { teamId, name: groupName });
    
    if (groupResult.issueLabelCreate.success) {
      groupId = groupResult.issueLabelCreate.issueLabel.id;
    }
  }

  // Create the type label (under group if we have one)
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

  const input: Record<string, unknown> = {
    name: labelName,
    teamId,
  };
  if (groupId) {
    input.parentId = groupId;
  }

  const createResult = await client.request<{
    issueLabelCreate: {
      success: boolean;
      issueLabel: { id: string; name: string };
    };
  }>(createMutation, { input });

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

  // Clear old issues before caching fresh ones (prevents stale issues from other repos)
  clearIssuesCache();

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
        inverseRelations {
          nodes {
            type
            issue {
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
              inverseRelations: {
                nodes: Array<{
                  type: string;
                  issue: { identifier: string };
                }>;
              };
            } | null;
          }>(query, { id: issueId });

          // Cache outgoing relations
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

          // Cache incoming relations (inverse)
          if (result.issue?.inverseRelations?.nodes) {
            for (const rel of result.issue.inverseRelations.nodes) {
              cacheDependency({
                issue_id: rel.issue.identifier,
                depends_on_id: result.issue.identifier,
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

    // Clear old deps before caching fresh ones (prevents stale data)
    clearIssueDependencies(result.issue.identifier);

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

    // Cache other relations (outgoing: this issue blocks/relates to others)
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

    // Cache inverse relations (incoming: this issue is blocked by others)
    if (result.issue.inverseRelations?.nodes) {
      for (const rel of result.issue.inverseRelations.nodes) {
        // Inverse "blocks" means: rel.issue blocks result.issue
        // So we cache: rel.issue -> blocks -> result.issue
        cacheDependency({
          issue_id: rel.issue.identifier,
          depends_on_id: result.issue.identifier,
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
  issueType?: IssueType; // Optional - only used when use_types is enabled
  teamId: string;
  parentId?: string;
  assigneeId?: string;
  status?: IssueStatus;
}): Promise<Issue> {
  const client = getGraphQLClient();

  // Get required labels
  const repoLabelId = await ensureRepoLabel(params.teamId);
  const labelIds: string[] = [repoLabelId];

  // Only add type label if types are enabled and type is provided
  if (useTypes() && params.issueType) {
    const typeLabelId = await ensureTypeLabel(params.teamId, params.issueType);
    labelIds.push(typeLabelId);
  }

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
    labelIds,
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
 * Delete a relation between two issues
 */
export async function deleteRelation(issueId: string, relatedIssueId: string): Promise<void> {
  const client = getGraphQLClient();

  // Resolve identifiers to UUIDs
  const issueUuid = (await resolveIssueId(issueId)) || issueId;
  const relatedUuid = (await resolveIssueId(relatedIssueId)) || relatedIssueId;

  // First, find the relation ID by querying the issue's relations
  const query = `
    query GetIssueRelations($id: String!) {
      issue(id: $id) {
        relations {
          nodes {
            id
            relatedIssue {
              id
            }
          }
        }
      }
    }
  `;

  const result = await client.request<{
    issue: {
      relations: {
        nodes: Array<{ id: string; relatedIssue: { id: string } }>;
      };
    } | null;
  }>(query, { id: issueUuid });

  if (!result.issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  // Find the relation that points to the related issue
  const relation = result.issue.relations.nodes.find(
    (r) => r.relatedIssue.id === relatedUuid
  );

  if (!relation) {
    // Try the inverse direction
    const inverseResult = await client.request<{
      issue: {
        relations: {
          nodes: Array<{ id: string; relatedIssue: { id: string } }>;
        };
      } | null;
    }>(query, { id: relatedUuid });

    const inverseRelation = inverseResult.issue?.relations.nodes.find(
      (r) => r.relatedIssue.id === issueUuid
    );

    if (!inverseRelation) {
      throw new Error(`No relation found between ${issueId} and ${relatedIssueId}`);
    }

    // Delete the inverse relation
    const deleteMutation = `
      mutation DeleteRelation($id: String!) {
        issueRelationDelete(id: $id) {
          success
        }
      }
    `;

    const deleteResult = await client.request<{
      issueRelationDelete: { success: boolean };
    }>(deleteMutation, { id: inverseRelation.id });

    if (!deleteResult.issueRelationDelete.success) {
      throw new Error("Failed to delete relation");
    }
  } else {
    // Delete the direct relation
    const deleteMutation = `
      mutation DeleteRelation($id: String!) {
        issueRelationDelete(id: $id) {
          success
        }
      }
    `;

    const deleteResult = await client.request<{
      issueRelationDelete: { success: boolean };
    }>(deleteMutation, { id: relation.id });

    if (!deleteResult.issueRelationDelete.success) {
      throw new Error("Failed to delete relation");
    }
  }

  // Remove from local cache (both directions)
  const { deleteDependency } = await import("./database.js");
  deleteDependency(issueId, relatedIssueId);
}

/**
 * Delete an issue from Linear
 */
export async function deleteIssue(issueId: string): Promise<void> {
  const client = getGraphQLClient();

  // Resolve identifier to UUID if needed
  const issueUuid = (await resolveIssueId(issueId)) || issueId;

  const mutation = `
    mutation DeleteIssue($id: String!) {
      issueDelete(id: $id) {
        success
      }
    }
  `;

  const result = await client.request<{
    issueDelete: { success: boolean };
  }>(mutation, { id: issueUuid });

  if (!result.issueDelete.success) {
    throw new Error("Failed to delete issue");
  }
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
