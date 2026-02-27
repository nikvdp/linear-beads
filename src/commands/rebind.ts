/**
 * lb rebind - Rebind this repo to a different scope/name tuple
 */

import { Command, InvalidArgumentError } from "commander";
import { getGraphQLClient } from "../utils/graphql.js";
import { getTeamId } from "../utils/issue-backend.js";
import {
  getRepoName,
  getRepoScope,
  type RepoScopeMode,
  writeRepoConfig,
} from "../utils/config.js";
import { output } from "../utils/output.js";

type RebindIssue = {
  id: string;
  identifier: string;
  project: { id: string; name: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
};

type EnsureResult = {
  id?: string;
  created: boolean;
};

function parseRepoScope(value: string): RepoScopeMode {
  if (value === "label" || value === "project" || value === "both") {
    return value;
  }
  throw new InvalidArgumentError("scope must be one of: label, project, both");
}

function scopeUsesLabel(scope: RepoScopeMode): boolean {
  return scope === "label" || scope === "both";
}

function scopeUsesProject(scope: RepoScopeMode): boolean {
  return scope === "project" || scope === "both";
}

function repoLabelFor(repoName: string): string {
  return `repo:${repoName}`;
}

function describeBinding(repoName: string, scope: RepoScopeMode): string {
  return `${repoName} (${scope})`;
}

function arraysEqualAsSets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a);
  for (const item of b) {
    if (!setA.has(item)) {
      return false;
    }
  }
  return true;
}

function buildSourceFilter(scope: RepoScopeMode): {
  filter: string;
  variableDecls: string[];
} {
  if (scope === "project") {
    return {
      filter: `filter: { project: { name: { eq: $projectName } } }`,
      variableDecls: ["$projectName: String!"],
    };
  }

  if (scope === "both") {
    return {
      filter:
        "filter: { or: [{ labels: { name: { eq: $labelName } } }, { project: { name: { eq: $projectName } } }] }",
      variableDecls: ["$labelName: String!", "$projectName: String!"],
    };
  }

  return {
    filter: `filter: { labels: { name: { eq: $labelName } } }`,
    variableDecls: ["$labelName: String!"],
  };
}

async function fetchIssuesByBinding(
  teamId: string,
  sourceName: string,
  sourceScope: RepoScopeMode
): Promise<RebindIssue[]> {
  const client = getGraphQLClient();
  const issues: RebindIssue[] = [];
  let hasNextPage = true;
  let after: string | null = null;

  const sourceLabel = repoLabelFor(sourceName);
  const { filter, variableDecls } = buildSourceFilter(sourceScope);
  const query = `
    query GetIssuesByBinding($teamId: String!, $after: String, ${variableDecls.join(", ")}) {
      team(id: $teamId) {
        issues(${filter}, first: 100, after: $after) {
          nodes {
            id
            identifier
            project {
              id
              name
            }
            labels {
              nodes {
                id
                name
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const variables: Record<string, string | null> = {
      teamId,
      after,
    };

    if (scopeUsesLabel(sourceScope)) {
      variables.labelName = sourceLabel;
    }
    if (scopeUsesProject(sourceScope)) {
      variables.projectName = sourceName;
    }

    const result = await client.request<{
      team: {
        issues: {
          nodes: RebindIssue[];
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
        };
      };
    }>(query, variables);

    issues.push(...result.team.issues.nodes);
    hasNextPage = result.team.issues.pageInfo.hasNextPage;
    after = result.team.issues.pageInfo.endCursor;
  }

  return issues;
}

async function ensureLabel(teamId: string, labelName: string, dryRun: boolean): Promise<EnsureResult> {
  const client = getGraphQLClient();

  const labelQuery = `
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

  const labels = await client.request<{
    team: { labels: { nodes: Array<{ id: string; name: string }> } };
  }>(labelQuery, { teamId });

  const existing = labels.team.labels.nodes.find((label) => label.name === labelName);
  if (existing) {
    return { id: existing.id, created: false };
  }

  if (dryRun) {
    return { created: true };
  }

  const mutation = `
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

  const created = await client.request<{
    issueLabelCreate: {
      success: boolean;
      issueLabel: { id: string; name: string };
    };
  }>(mutation, {
    input: {
      teamId,
      name: labelName,
      color: "#6B7280",
    },
  });

  if (!created.issueLabelCreate.success) {
    throw new Error(`Failed to create label: ${labelName}`);
  }

  return {
    id: created.issueLabelCreate.issueLabel.id,
    created: true,
  };
}

async function ensureProject(teamId: string, projectName: string, dryRun: boolean): Promise<EnsureResult> {
  const client = getGraphQLClient();

  const projectQuery = `
    query GetProjects($name: String!) {
      projects(filter: { name: { eq: $name } }, first: 10) {
        nodes {
          id
          name
        }
      }
    }
  `;

  const existingProjects = await client.request<{
    projects: { nodes: Array<{ id: string; name: string }> };
  }>(projectQuery, { name: projectName });

  const existing = existingProjects.projects.nodes.find((project) => project.name === projectName);
  if (existing) {
    return { id: existing.id, created: false };
  }

  if (dryRun) {
    return { created: true };
  }

  const mutation = `
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

  const created = await client.request<{
    projectCreate: {
      success: boolean;
      project: { id: string; name: string };
    };
  }>(mutation, {
    input: {
      name: projectName,
      teamIds: [teamId],
    },
  });

  if (!created.projectCreate.success) {
    throw new Error(`Failed to create project: ${projectName}`);
  }

  return {
    id: created.projectCreate.project.id,
    created: true,
  };
}

function buildIssueUpdate(
  issue: RebindIssue,
  options: {
    dryRun: boolean;
    sourceName: string;
    sourceScope: RepoScopeMode;
    targetName: string;
    targetScope: RepoScopeMode;
    keepLabel: boolean;
    keepProject: boolean;
    targetLabelId?: string;
    targetProjectId?: string;
  }
): {
  actions: string[];
  input?: Record<string, unknown>;
} {
  const sourceUsesLabel = scopeUsesLabel(options.sourceScope);
  const sourceUsesProject = scopeUsesProject(options.sourceScope);
  const targetUsesLabel = scopeUsesLabel(options.targetScope);
  const targetUsesProject = scopeUsesProject(options.targetScope);

  const sourceLabel = repoLabelFor(options.sourceName);
  const targetLabel = repoLabelFor(options.targetName);

  const existingLabels = issue.labels.nodes;
  const existingLabelIds = existingLabels.map((label) => label.id);

  let finalLabelIds = [...existingLabelIds];
  const actions: string[] = [];

  const hasSourceLabel = existingLabels.some((label) => label.name === sourceLabel);
  const hasTargetLabel = existingLabels.some((label) => label.name === targetLabel);

  if (targetUsesLabel && !hasTargetLabel) {
    actions.push(`add label '${targetLabel}'`);
    if (!options.dryRun) {
      if (!options.targetLabelId) {
        throw new Error(`Target label ID missing for ${targetLabel}`);
      }
      finalLabelIds.push(options.targetLabelId);
    }
  }

  const shouldRemoveSourceLabel =
    sourceUsesLabel &&
    !options.keepLabel &&
    hasSourceLabel &&
    (sourceLabel !== targetLabel || !targetUsesLabel);

  if (shouldRemoveSourceLabel) {
    actions.push(`remove label '${sourceLabel}'`);
    if (!options.dryRun) {
      finalLabelIds = existingLabels
        .filter((label) => label.name !== sourceLabel)
        .map((label) => label.id);

      if (targetUsesLabel && !hasTargetLabel && options.targetLabelId) {
        finalLabelIds.push(options.targetLabelId);
      }
    }
  }

  // Deduplicate label IDs before sending updates.
  finalLabelIds = [...new Set(finalLabelIds)];

  let projectIdUpdate: string | null | undefined;

  if (targetUsesProject && issue.project?.name !== options.targetName) {
    actions.push(`assign project '${options.targetName}'`);
    if (!options.dryRun) {
      if (!options.targetProjectId) {
        throw new Error(`Target project ID missing for ${options.targetName}`);
      }
      projectIdUpdate = options.targetProjectId;
    }
  } else if (!targetUsesProject && sourceUsesProject && !options.keepProject) {
    if (issue.project?.name === options.sourceName) {
      actions.push(`clear project '${options.sourceName}'`);
      if (!options.dryRun) {
        projectIdUpdate = null;
      }
    }
  }

  if (actions.length === 0) {
    return { actions };
  }

  if (options.dryRun) {
    return { actions };
  }

  const input: Record<string, unknown> = {};

  if (projectIdUpdate !== undefined) {
    input.projectId = projectIdUpdate;
  }

  if (!arraysEqualAsSets(existingLabelIds, finalLabelIds)) {
    input.labelIds = finalLabelIds;
  }

  if (Object.keys(input).length === 0) {
    return { actions: [] };
  }

  return { actions, input };
}

export const rebindCommand = new Command("rebind")
  .description("Rebind this repo to a new name/scope and migrate issues by default")
  .requiredOption("--to-name <name>", "Target repo binding name")
  .option(
    "--to-scope <scope>",
    "Target repo scope: label, project, or both (default: current scope)",
    parseRepoScope
  )
  .option("--from-name <name>", "Source repo binding name (default: current repo_name)")
  .option(
    "--from-scope <scope>",
    "Source repo scope: label, project, or both (default: both)",
    parseRepoScope
  )
  .option("--dry-run", "Show what would change without making updates")
  .option("--config-only", "Only update local repo config (skip migrate-by-default issue moves)")
  .option("--keep-label", "Keep source repo label on migrated issues")
  .option("--keep-project", "Keep source project assignment on migrated issues")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (options) => {
    try {
      const currentRepoName = getRepoName() || "unknown";
      const currentScope = getRepoScope();

      const sourceName = options.fromName || currentRepoName;
      const sourceScope = (options.fromScope as RepoScopeMode | undefined) || "both";
      const targetName = options.toName as string;
      const targetScope = (options.toScope as RepoScopeMode | undefined) || currentScope;
      const keepLabel = options.keepLabel === true;
      const keepProject = options.keepProject === true;
      const dryRun = options.dryRun === true;
      const configOnly = options.configOnly === true;

      if (configOnly && (keepLabel || keepProject)) {
        output("Error: --keep-label/--keep-project cannot be used with --config-only.");
        process.exit(1);
      }

      output(`Rebinding from ${describeBinding(sourceName, sourceScope)}...`);
      output(`            to ${describeBinding(targetName, targetScope)}\n`);

      if (configOnly) {
        if (dryRun) {
          output("Dry run: Would update local repo config only (no issue migration).");
        } else {
          const path = writeRepoConfig({
            repo_name: targetName,
            repo_scope: targetScope,
          });
          output(`✓ Updated repo config: ${path}`);
          output("Skipped issue migration (--config-only).");
        }
        return;
      }

      const teamId = await getTeamId(options.team);

      let targetLabelId: string | undefined;
      let targetProjectId: string | undefined;

      if (scopeUsesLabel(targetScope)) {
        const labelName = repoLabelFor(targetName);
        const ensured = await ensureLabel(teamId, labelName, dryRun);
        if (dryRun) {
          if (ensured.created) {
            output(`Would create label '${labelName}'`);
          } else {
            output(`Using existing label '${labelName}'`);
          }
        } else {
          output(`${ensured.created ? "Created" : "Using"} label '${labelName}'`);
        }
        targetLabelId = ensured.id;
      }

      if (scopeUsesProject(targetScope)) {
        const ensured = await ensureProject(teamId, targetName, dryRun);
        if (dryRun) {
          if (ensured.created) {
            output(`Would create project '${targetName}'`);
          } else {
            output(`Using existing project '${targetName}'`);
          }
        } else {
          output(`${ensured.created ? "Created" : "Using"} project '${targetName}'`);
        }
        targetProjectId = ensured.id;
      }

      output("");

      const issues = await fetchIssuesByBinding(teamId, sourceName, sourceScope);
      output(`Found ${issues.length} source-bound issues`);

      if (issues.length === 0) {
        if (dryRun) {
          output("Dry run: No issue updates needed.");
          output("Dry run: Would still update local repo config.");
          return;
        }

        const path = writeRepoConfig({
          repo_name: targetName,
          repo_scope: targetScope,
        });
        output(`✓ Updated repo config: ${path}`);
        output("No issue updates were required.");
        return;
      }

      const updateMutation = `
        mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
          }
        }
      `;

      let migrated = 0;
      let skipped = 0;

      for (const issue of issues) {
        const plan = buildIssueUpdate(issue, {
          dryRun,
          sourceName,
          sourceScope,
          targetName,
          targetScope,
          keepLabel,
          keepProject,
          targetLabelId,
          targetProjectId,
        });

        if (plan.actions.length === 0 || (!dryRun && !plan.input)) {
          skipped++;
          continue;
        }

        if (dryRun) {
          output(`Would update ${issue.id}: ${plan.actions.join(", ")}`);
        } else {
          await getGraphQLClient().request(updateMutation, {
            id: issue.id,
            input: plan.input,
          });
          output(`${issue.id}: ${plan.actions.join(", ")}`);
        }
        migrated++;
      }

      output("");

      if (dryRun) {
        output(`Dry run: Would migrate ${migrated} issues (${skipped} already migrated)`);
        output("Dry run: Would update local repo config.");
      } else {
        const path = writeRepoConfig({
          repo_name: targetName,
          repo_scope: targetScope,
        });
        output(`Migrated ${migrated} issues (${skipped} already migrated)`);
        output(`✓ Updated repo config: ${path}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
