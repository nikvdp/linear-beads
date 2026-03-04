/**
 * Linear API operations
 */

import { getGraphQLClient, ISSUE_FRAGMENT, ISSUE_WITH_RELATIONS_FRAGMENT } from "./graphql.js";
import {
  getRepoLabel,
  getRepoName,
  getRepoScope,
  getTeamKey,
  useLabelScope,
  useProjectScope,
  useTypes,
} from "./config.js";
import {
  cacheIssue,
  cacheIssues,
  cacheDependency,
  clearIssueDependencies,
  clearIssuesCache,
  deleteDependencyByType,
  deleteRelatedDependency,
  cacheLabel,
  getLabelIdByName,
  cacheProject,
  getProjectIdByName,
  updateLastSync,
  updateLastFullSync,
  pruneStaleIssues,
  cacheViewer,
  getCachedViewer,
} from "./database.js";
import type { Issue, IssueType, Priority, LinearIssue, IssueStatus } from "../types.js";
import {
  linearStateToStatus,
  linearToPriority,
  labelToIssueType,
  priorityToLinear,
  statusToLinearState,
} from "../types.js";

type RelationType = "blocks" | "related";
type LinearRelationNode = {
  id: string;
  type: string;
  relatedIssue: { id: string };
};
type GraphqlRequestClient = {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
};
const SYNC_KEY_MARKER_RE = /<!--\s*lb:sync_key=([a-f0-9-]{8,})\s*-->/i;

function splitDescriptionAndSyncKey(description?: string | null): {
  description?: string;
  syncKey?: string;
} {
  if (!description) {
    return {};
  }

  const match = description.match(SYNC_KEY_MARKER_RE);
  if (!match) {
    return { description };
  }

  const syncKey = match[1];
  const withoutMarker = description.replace(SYNC_KEY_MARKER_RE, "").trimEnd();
  return {
    description: withoutMarker || undefined,
    syncKey,
  };
}

function appendSyncKeyMarker(
  description: string | undefined,
  syncKey?: string
): string | undefined {
  if (!syncKey) {
    return description;
  }

  const cleaned = splitDescriptionAndSyncKey(description).description;
  const marker = `<!-- lb:sync_key=${syncKey} -->`;
  if (!cleaned) {
    return marker;
  }
  return `${cleaned}\n\n${marker}`;
}

/**
 * Convert Linear issue to bd-compatible issue
 */
function linearToBdIssue(
  linear: LinearIssue
): Issue & { linear_state_id: string; sync_key?: string } {
  const labels = linear.labels.nodes.map((l) => l.name);
  const issueType = useTypes() ? labelToIssueType(labels) : undefined;
  const parsedDescription = splitDescriptionAndSyncKey(linear.description);

  const issue: Issue & { linear_state_id: string; sync_key?: string } = {
    id: linear.identifier,
    linear_id: linear.id,
    linear_identifier: linear.identifier,
    title: linear.title,
    description: parsedDescription.description,
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
  if (parsedDescription.syncKey) {
    issue.sync_key = parsedDescription.syncKey;
  }

  return issue;
}

/**
 * Get or create repo label
 */
async function fetchTeamLabels(
  client: GraphqlRequestClient,
  teamId: string
): Promise<Array<{ id: string; name: string }>> {
  const labels: Array<{ id: string; name: string }> = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query GetLabelsPage($teamId: String!, $cursor: String) {
        team(id: $teamId) {
          labels(first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              name
            }
          }
        }
      }
    `;

    const result: {
      team: {
        labels: {
          nodes: Array<{ id: string; name: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    } = await client.request(query, { teamId, cursor });

    labels.push(...result.team.labels.nodes);
    hasNextPage = result.team.labels.pageInfo.hasNextPage;
    cursor = result.team.labels.pageInfo.endCursor;
  }

  return labels;
}

function isDuplicateLabelNameError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("duplicate label name") || msg.includes("already exists");
}

export async function ensureRepoLabel(
  teamId: string,
  options: { client?: GraphqlRequestClient; repoLabel?: string } = {}
): Promise<string> {
  const client: GraphqlRequestClient =
    options.client || (getGraphQLClient() as unknown as GraphqlRequestClient);
  const repoLabel = options.repoLabel || getRepoLabel();

  // Check cache first
  const cachedId = getLabelIdByName(repoLabel);
  if (cachedId) return cachedId;

  const existingLabels = await fetchTeamLabels(client, teamId);
  const existing = existingLabels.find((l) => l.name === repoLabel);
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

  let createResult:
    | {
        issueLabelCreate: {
          success: boolean;
          issueLabel: { id: string; name: string };
        };
      }
    | undefined;

  try {
    createResult = await client.request<{
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
  } catch (error) {
    if (!isDuplicateLabelNameError(error)) {
      throw error;
    }
  }

  if (!createResult || !createResult.issueLabelCreate.success) {
    const labelsAfterCreate = await fetchTeamLabels(client, teamId);
    const existingAfterCreate = labelsAfterCreate.find((label) => label.name === repoLabel);
    if (existingAfterCreate) {
      cacheLabel(existingAfterCreate.id, existingAfterCreate.name, teamId);
      return existingAfterCreate.id;
    }
  }

  if (!createResult || !createResult.issueLabelCreate.success) {
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
 * Get or create repo project (for project-based scoping)
 */
export async function ensureRepoProject(teamId: string): Promise<string> {
  const client = getGraphQLClient();
  const projectName = getRepoName() || "unknown";

  // Check cache first
  const cachedId = getProjectIdByName(projectName);
  if (cachedId) return cachedId;

  // Query existing projects by name
  const query = `
    query GetProjects($name: String!) {
      projects(filter: { name: { eq: $name } }, first: 10) {
        nodes {
          id
          name
        }
      }
    }
  `;

  const result = await client.request<{
    projects: { nodes: Array<{ id: string; name: string }> };
  }>(query, { name: projectName });

  const existing = result.projects.nodes.find((p) => p.name === projectName);
  if (existing) {
    cacheProject(existing.id, existing.name, teamId);
    return existing.id;
  }

  // Create project
  const createMutation = `
    mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        success
        project {
          id
          name
        }
      }
    }
  `;

  const createResult = await client.request<{
    projectCreate: {
      success: boolean;
      project: { id: string; name: string };
    };
  }>(createMutation, {
    input: {
      name: projectName,
      teamIds: [teamId],
    },
  });

  if (!createResult.projectCreate.success) {
    throw new Error(`Failed to create repo project: ${projectName}`);
  }

  cacheProject(
    createResult.projectCreate.project.id,
    createResult.projectCreate.project.name,
    teamId
  );

  return createResult.projectCreate.project.id;
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
  const existingGroup = result.team.labels.nodes.find((l) => l.parent?.name === groupName)?.parent;

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
 * Supports label, project, or both scoping modes
 */
export async function fetchIssues(teamId: string): Promise<Issue[]> {
  const client = getGraphQLClient();
  const scope = getRepoScope();

  // Build filter based on scoping mode
  let filter: string;
  let variables: Record<string, string> = { teamId };

  if (scope === "project") {
    // Project-only mode: filter by project name
    const projectName = getRepoName() || "unknown";
    filter = `filter: { project: { name: { eq: $projectName } } }`;
    variables.projectName = projectName;
  } else if (scope === "both") {
    // Both mode: filter by label OR project (use 'or' combinator)
    const repoLabel = getRepoLabel();
    const projectName = getRepoName() || "unknown";
    filter = `filter: { or: [{ labels: { name: { eq: $labelName } } }, { project: { name: { eq: $projectName } } }] }`;
    variables.labelName = repoLabel;
    variables.projectName = projectName;
  } else {
    // Label mode (default): filter by label
    const repoLabel = getRepoLabel();
    filter = `filter: { labels: { name: { eq: $labelName } } }`;
    variables.labelName = repoLabel;
  }

  // Build variable declarations for GraphQL
  const varDecls = Object.keys(variables)
    .map((k) => `$${k}: String!`)
    .join(", ");

  // Use simpler query without nested children/relations to avoid complexity limits
  const query = `
    query GetIssues(${varDecls}) {
      team(id: $teamId) {
        issues(${filter}, first: 100) {
          nodes {
            ${ISSUE_FRAGMENT}
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: { issues: { nodes: LinearIssue[] } };
  }>(query, variables);

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
 * Fetch all issues with pagination (full sync).
 * Clears stale issues after fetching all pages.
 * @returns Object with issues array and pruned count
 */
export async function fetchAllIssuesPaginated(
  teamId: string
): Promise<{ issues: Issue[]; pruned: number }> {
  const client = getGraphQLClient();
  const scope = getRepoScope();

  // Build scope filter based on mode
  let scopeFilter: string;
  let baseVariables: Record<string, string | undefined> = { teamId };

  if (scope === "project") {
    const projectName = getRepoName() || "unknown";
    scopeFilter = `filter: { project: { name: { eq: $projectName } } }`;
    baseVariables.projectName = projectName;
  } else if (scope === "both") {
    const repoLabel = getRepoLabel();
    const projectName = getRepoName() || "unknown";
    scopeFilter = `filter: { or: [{ labels: { name: { eq: $labelName } } }, { project: { name: { eq: $projectName } } }] }`;
    baseVariables.labelName = repoLabel;
    baseVariables.projectName = projectName;
  } else {
    const repoLabel = getRepoLabel();
    scopeFilter = `filter: { labels: { name: { eq: $labelName } } }`;
    baseVariables.labelName = repoLabel;
  }

  const allIssues: Issue[] = [];
  const allIssueIds = new Set<string>();
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    // Always include cursor in variables (null for first page)
    const variables = { ...baseVariables, cursor: cursor || null };

    // Build variable declarations - cursor is always included (optional String)
    const varDecls = Object.entries(baseVariables)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `$${k}: String!`)
      .concat(["$cursor: String"])
      .join(", ");

    const query = `
      query GetAllIssues(${varDecls}) {
        team(id: $teamId) {
          issues(${scopeFilter}, first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ${ISSUE_FRAGMENT}
            }
          }
        }
      }
    `;

    const result = await client.request<{
      team: {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor?: string };
          nodes: LinearIssue[];
        };
      };
    }>(query, variables);

    const issues = result.team.issues.nodes.map(linearToBdIssue);

    // Track all issue IDs for stale pruning
    for (const issue of issues) {
      allIssueIds.add(issue.id);
    }

    // Upsert issues
    if (issues.length > 0) {
      cacheIssues(issues);
    }

    // Cache parent-child relations
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

    allIssues.push(...issues);
    hasMore = result.team.issues.pageInfo.hasNextPage;
    cursor = result.team.issues.pageInfo.endCursor;
  }

  // Prune stale issues that are no longer in remote
  const pruned = pruneStaleIssues(allIssueIds);

  updateLastSync();
  updateLastFullSync();

  return { issues: allIssues, pruned };
}

/**
 * Fetch issues updated since a given timestamp (incremental sync).
 * Does NOT clear cache - only upserts updated issues.
 * Supports pagination via cursor.
 */
export async function fetchUpdatedIssues(
  teamId: string,
  since: string,
  cursor?: string
): Promise<{ issues: Issue[]; hasMore: boolean; endCursor?: string }> {
  const client = getGraphQLClient();
  const scope = getRepoScope();

  // Build scope filter based on mode
  let scopeFilter: string;
  let baseVariables: Record<string, string> = { teamId, since };

  if (scope === "project") {
    const projectName = getRepoName() || "unknown";
    scopeFilter = `project: { name: { eq: $projectName } }`;
    baseVariables.projectName = projectName;
  } else if (scope === "both") {
    const repoLabel = getRepoLabel();
    const projectName = getRepoName() || "unknown";
    scopeFilter = `or: [{ labels: { name: { eq: $labelName } } }, { project: { name: { eq: $projectName } } }]`;
    baseVariables.labelName = repoLabel;
    baseVariables.projectName = projectName;
  } else {
    const repoLabel = getRepoLabel();
    scopeFilter = `labels: { name: { eq: $labelName } }`;
    baseVariables.labelName = repoLabel;
  }

  // Build variable declarations
  // Note: since is DateTimeOrDuration type (Linear's custom scalar), cursor is optional String
  const varDecls = Object.keys(baseVariables)
    .map((k) => (k === "since" ? `$${k}: DateTimeOrDuration!` : `$${k}: String!`))
    .concat(["$cursor: String"])
    .join(", ");

  // Variables to send - include cursor as null if undefined
  const variables = { ...baseVariables, cursor: cursor || null };

  // Combined filter: scope + updatedAt
  const filter = `filter: { ${scopeFilter}, updatedAt: { gt: $since } }`;

  const query = `
    query GetUpdatedIssues(${varDecls}) {
      team(id: $teamId) {
        issues(${filter}, first: 50, after: $cursor, orderBy: updatedAt) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            ${ISSUE_FRAGMENT}
          }
        }
      }
    }
  `;

  const result = await client.request<{
    team: {
      issues: {
        pageInfo: { hasNextPage: boolean; endCursor?: string };
        nodes: LinearIssue[];
      };
    };
  }>(query, variables);

  const issues = result.team.issues.nodes.map(linearToBdIssue);

  // Upsert issues (don't clear cache)
  if (issues.length > 0) {
    cacheIssues(issues);
  }

  // Cache parent-child relations from the query
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

  return {
    issues,
    hasMore: result.team.issues.pageInfo.hasNextPage,
    endCursor: result.team.issues.pageInfo.endCursor,
  };
}

/**
 * Fetch all updated issues since timestamp with automatic pagination.
 * Convenience wrapper around fetchUpdatedIssues.
 */
export async function fetchAllUpdatedIssues(teamId: string, since: string): Promise<Issue[]> {
  const allIssues: Issue[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const result = await fetchUpdatedIssues(teamId, since, cursor);
    allIssues.push(...result.issues);
    hasMore = result.hasMore;
    cursor = result.endCursor;
  }

  return allIssues;
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
 * Find a scoped Linear issue by lb sync key marker in description.
 */
export async function findIssueBySyncKey(teamId: string, syncKey: string): Promise<Issue | null> {
  const client = getGraphQLClient();
  const scope = getRepoScope();

  let scopeFilter: string;
  const baseVariables: Record<string, string | undefined> = { teamId };

  if (scope === "project") {
    const projectName = getRepoName() || "unknown";
    scopeFilter = `filter: { project: { name: { eq: $projectName } } }`;
    baseVariables.projectName = projectName;
  } else if (scope === "both") {
    const repoLabel = getRepoLabel();
    const projectName = getRepoName() || "unknown";
    scopeFilter = `filter: { or: [{ labels: { name: { eq: $labelName } } }, { project: { name: { eq: $projectName } } }] }`;
    baseVariables.labelName = repoLabel;
    baseVariables.projectName = projectName;
  } else {
    const repoLabel = getRepoLabel();
    scopeFilter = `filter: { labels: { name: { eq: $labelName } } }`;
    baseVariables.labelName = repoLabel;
  }

  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const variables = { ...baseVariables, cursor: cursor || null };
    const varDecls = Object.entries(baseVariables)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `$${k}: String!`)
      .concat(["$cursor: String"])
      .join(", ");
    const query = `
      query FindIssueBySyncKey(${varDecls}) {
        team(id: $teamId) {
          issues(${scopeFilter}, first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ${ISSUE_FRAGMENT}
            }
          }
        }
      }
    `;

    const result = await client.request<{
      team: {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor?: string };
          nodes: LinearIssue[];
        };
      };
    }>(query, variables);

    for (const node of result.team.issues.nodes) {
      const parsed = splitDescriptionAndSyncKey(node.description);
      if (parsed.syncKey === syncKey) {
        return linearToBdIssue(node);
      }
    }

    hasMore = result.team.issues.pageInfo.hasNextPage;
    cursor = result.team.issues.pageInfo.endCursor;
  }

  return null;
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
  syncKey?: string;
  skipCache?: boolean;
}): Promise<Issue> {
  const client = getGraphQLClient();

  // Build label IDs based on scoping mode
  const labelIds: string[] = [];

  // Add repo label if using label or both scoping
  if (useLabelScope()) {
    const repoLabelId = await ensureRepoLabel(params.teamId);
    labelIds.push(repoLabelId);
  }

  // Add type label if types are enabled and type is provided
  if (useTypes() && params.issueType) {
    const typeLabelId = await ensureTypeLabel(params.teamId, params.issueType);
    labelIds.push(typeLabelId);
  }

  // Get project ID if using project or both scoping
  let projectId: string | undefined;
  if (useProjectScope()) {
    projectId = await ensureRepoProject(params.teamId);
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
    description: appendSyncKeyMarker(params.description, params.syncKey),
    priority: priorityToLinear(params.priority),
    teamId: params.teamId,
    stateId,
    parentId: parentUuid,
  };

  // Only include labelIds if we have labels
  if (labelIds.length > 0) {
    input.labelIds = labelIds;
  }

  // Add projectId if using project scoping
  if (projectId) {
    input.projectId = projectId;
  }

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
  if (!params.skipCache) {
    cacheIssue(issue);
  }
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
 * Pass null to remove the parent
 */
export async function updateIssueParent(issueId: string, parentId: string | null): Promise<void> {
  const client = getGraphQLClient();

  // Resolve parentId if it's an identifier (only if not null)
  const parentUuid = parentId ? (await resolveIssueId(parentId)) || parentId : null;

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
function normalizeRelationType(value: string): RelationType | null {
  const normalized = value.toLowerCase();
  if (normalized === "blocks" || normalized === "related") {
    return normalized;
  }
  return null;
}

function relationTypeMatches(value: string, expected?: RelationType): boolean {
  const normalized = normalizeRelationType(value);
  if (!normalized) {
    return false;
  }
  if (!expected) {
    return true;
  }
  return normalized === expected;
}

async function fetchIssueRelationNodes(
  client: ReturnType<typeof getGraphQLClient>,
  issueId: string
): Promise<LinearRelationNode[]> {
  const query = `
    query GetIssueRelations($id: String!) {
      issue(id: $id) {
        relations {
          nodes {
            id
            type
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
        nodes: LinearRelationNode[];
      };
    } | null;
  }>(query, { id: issueId });

  if (!result.issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  return result.issue.relations.nodes;
}

export function collectRelationIdsForPair(
  sourceIssueRelations: LinearRelationNode[],
  targetIssueRelations: LinearRelationNode[],
  sourceIssueId: string,
  targetIssueId: string,
  relationType?: RelationType
): string[] {
  const ids = new Set<string>();

  for (const relation of sourceIssueRelations) {
    if (
      relation.relatedIssue.id === targetIssueId &&
      relationTypeMatches(relation.type, relationType)
    ) {
      ids.add(relation.id);
    }
  }

  for (const relation of targetIssueRelations) {
    if (
      relation.relatedIssue.id === sourceIssueId &&
      relationTypeMatches(relation.type, relationType)
    ) {
      ids.add(relation.id);
    }
  }

  return [...ids];
}

async function deleteRelationById(
  client: ReturnType<typeof getGraphQLClient>,
  relationId: string
): Promise<void> {
  const deleteMutation = `
    mutation DeleteRelation($id: String!) {
      issueRelationDelete(id: $id) {
        success
      }
    }
  `;

  const deleteResult = await client.request<{
    issueRelationDelete: { success: boolean };
  }>(deleteMutation, { id: relationId });

  if (!deleteResult.issueRelationDelete.success) {
    throw new Error("Failed to delete relation");
  }
}

export async function createRelation(
  issueId: string,
  relatedIssueId: string,
  type: RelationType
): Promise<void> {
  const client = getGraphQLClient();

  // Resolve identifiers to UUIDs
  const issueUuid = (await resolveIssueId(issueId)) || issueId;
  const relatedUuid = (await resolveIssueId(relatedIssueId)) || relatedIssueId;

  const [issueRelations, relatedIssueRelations] = await Promise.all([
    fetchIssueRelationNodes(client, issueUuid),
    fetchIssueRelationNodes(client, relatedUuid),
  ]);

  const existing = collectRelationIdsForPair(
    issueRelations,
    relatedIssueRelations,
    issueUuid,
    relatedUuid,
    type
  );
  if (existing.length > 0) {
    cacheDependency({
      issue_id: issueId,
      depends_on_id: relatedIssueId,
      type,
      created_at: new Date().toISOString(),
      created_by: "user",
    });
    return;
  }

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
export async function deleteRelation(
  issueId: string,
  relatedIssueId: string,
  relationType?: RelationType
): Promise<void> {
  const client = getGraphQLClient();

  // Resolve identifiers to UUIDs
  const issueUuid = (await resolveIssueId(issueId)) || issueId;
  const relatedUuid = (await resolveIssueId(relatedIssueId)) || relatedIssueId;
  const [issueRelations, relatedIssueRelations] = await Promise.all([
    fetchIssueRelationNodes(client, issueUuid),
    fetchIssueRelationNodes(client, relatedUuid),
  ]);

  let relationIds: string[] = [];
  let removedInverseOnly = false;
  if (relationType === "blocks") {
    const direct = issueRelations
      .filter(
        (relation) =>
          relation.relatedIssue.id === relatedUuid && relationTypeMatches(relation.type, "blocks")
      )
      .map((relation) => relation.id);

    if (direct.length > 0) {
      relationIds = direct;
    } else {
      relationIds = relatedIssueRelations
        .filter(
          (relation) =>
            relation.relatedIssue.id === issueUuid && relationTypeMatches(relation.type, "blocks")
        )
        .map((relation) => relation.id);
      removedInverseOnly = relationIds.length > 0;
    }
  } else {
    relationIds = collectRelationIdsForPair(
      issueRelations,
      relatedIssueRelations,
      issueUuid,
      relatedUuid,
      relationType
    );
  }

  if (relationIds.length === 0) {
    const descriptor = relationType ? `${relationType} relation` : "relation";
    throw new Error(`No ${descriptor} found between ${issueId} and ${relatedIssueId}`);
  }

  for (const relationId of relationIds) {
    await deleteRelationById(client, relationId);
  }

  if (relationType === "related") {
    deleteRelatedDependency(issueId, relatedIssueId);
    return;
  }

  if (relationType === "blocks") {
    if (removedInverseOnly) {
      deleteDependencyByType(relatedIssueId, issueId, "blocks");
    } else {
      deleteDependencyByType(issueId, relatedIssueId, "blocks");
    }
    return;
  }

  // Legacy mode: remove cached relation regardless of direction/type.
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
 * Uses cache first, falls back to API call and caches result.
 */
export async function getViewer(): Promise<{ id: string; email: string; name: string }> {
  // Try cache first
  const cached = getCachedViewer();
  if (cached) return cached;

  // Fetch from API
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

  // Cache for future calls
  cacheViewer(result.viewer);

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
