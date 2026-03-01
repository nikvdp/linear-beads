/**
 * lb migrate - Migration utilities
 */

import { Command } from "commander";
import { getGraphQLClient } from "../utils/graphql.js";
import { getTeamId, fetchIssues } from "../utils/issue-backend.js";
import { getRepoLabel, getRepoName, getRepoScope } from "../utils/config.js";
import { output } from "../utils/output.js";
import { ensureRepoProject } from "../utils/issue-backend.js";

/**
 * Remove type labels from all issues in this repo
 */
async function removeTypeLabels(teamId: string, dryRun: boolean): Promise<void> {
  const client = getGraphQLClient();
  const scope = getRepoScope();

  // First, fetch all issues for this repo (respects repo_scope config)
  output(`Fetching issues (scope: ${scope})...`);
  const issues = await fetchIssues(teamId);
  output(`Found ${issues.length} issues`);

  // Get all labels for this team
  const labelsQuery = `
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

  const labelsResult = await client.request<{
    team: { labels: { nodes: Array<{ id: string; name: string }> } };
  }>(labelsQuery, { teamId });

  // Find type labels (old format "type:X" or new format matching type names)
  const typeLabels = labelsResult.team.labels.nodes.filter(
    (l) =>
      l.name.startsWith("type:") || ["Bug", "Feature", "Task", "Epic", "Chore"].includes(l.name)
  );

  if (typeLabels.length === 0) {
    output("No type labels found to remove.");
    return;
  }

  output(`Found ${typeLabels.length} type labels: ${typeLabels.map((l) => l.name).join(", ")}`);

  // For each issue, check if it has type labels and remove them
  const issueQuery = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id
        identifier
        labels {
          nodes {
            id
            name
          }
        }
      }
    }
  `;

  const updateMutation = `
    mutation UpdateIssueLabels($id: String!, $labelIds: [String!]!) {
      issueUpdate(id: $id, input: { labelIds: $labelIds }) {
        success
      }
    }
  `;

  let updated = 0;
  const typeLabelIds = new Set(typeLabels.map((l) => l.id));

  for (const issue of issues) {
    // Fetch current labels for this issue
    const issueResult = await client.request<{
      issue: {
        id: string;
        identifier: string;
        labels: { nodes: Array<{ id: string; name: string }> };
      } | null;
    }>(issueQuery, { id: issue.id });

    if (!issueResult.issue) continue;

    const currentLabels = issueResult.issue.labels.nodes;
    const typeLabelsOnIssue = currentLabels.filter((l) => typeLabelIds.has(l.id));

    if (typeLabelsOnIssue.length === 0) continue;

    // Filter out type labels
    const newLabelIds = currentLabels.filter((l) => !typeLabelIds.has(l.id)).map((l) => l.id);

    if (dryRun) {
      output(`Would remove from ${issue.id}: ${typeLabelsOnIssue.map((l) => l.name).join(", ")}`);
    } else {
      await client.request(updateMutation, {
        id: issueResult.issue.id,
        labelIds: newLabelIds,
      });
      output(`Removed from ${issue.id}: ${typeLabelsOnIssue.map((l) => l.name).join(", ")}`);
    }
    updated++;
  }

  if (dryRun) {
    output(`\nDry run: Would update ${updated} issues. Run without --dry-run to proceed.`);
  } else {
    output(`\nUpdated ${updated} issues.`);
  }
}

/**
 * Migrate label-scoped issues to project scoping
 */
async function migrateToProject(
  teamId: string,
  dryRun: boolean,
  keepLabel: boolean
): Promise<void> {
  const client = getGraphQLClient();
  const repoLabel = getRepoLabel();
  const projectName = getRepoName() || "unknown";

  // Ensure project exists
  output(`Ensuring project '${projectName}' exists...`);
  const projectId = await ensureRepoProject(teamId);
  output(`✓ Project ID: ${projectId}`);

  // Fetch all issues with the repo label (strict source, independent of repo_scope config).
  output(`\nFetching issues with label '${repoLabel}'...`);
  const issues = await fetchIssuesByRepoLabel(teamId, repoLabel);
  output(`Found ${issues.length} issues`);

  if (issues.length === 0) {
    output("No issues to migrate.");
    return;
  }

  // Mutation to update issue
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
    const hasRepoLabel = issue.labels.nodes.some((l) => l.name === repoLabel);
    const alreadyInTargetProject = issue.project?.id === projectId;

    // Build update input
    const input: Record<string, unknown> = {};

    if (!alreadyInTargetProject) {
      input.projectId = projectId;
    }

    // Default is migrate-not-copy: remove repo label unless explicitly kept.
    if (!keepLabel && hasRepoLabel) {
      const newLabelIds = issue.labels.nodes.filter((l) => l.name !== repoLabel).map((l) => l.id);
      input.labelIds = newLabelIds;
    }

    if (Object.keys(input).length === 0) {
      skipped++;
      continue;
    }

    if (dryRun) {
      const actions: string[] = [];
      if (!alreadyInTargetProject) actions.push(`assign to project '${projectName}'`);
      if (!keepLabel && hasRepoLabel) actions.push(`remove label '${repoLabel}'`);
      output(`Would update ${issue.id}: ${actions.join(", ")}`);
    } else {
      await client.request(updateMutation, {
        id: issue.id,
        input,
      });
      const actions: string[] = [];
      if (!alreadyInTargetProject) actions.push(`assigned to project`);
      if (!keepLabel && hasRepoLabel) actions.push(`removed label`);
      output(`${issue.id}: ${actions.join(", ")}`);
    }
    migrated++;
  }

  output("");
  if (dryRun) {
    output(`Dry run: Would migrate ${migrated} issues (${skipped} already migrated)`);
    output("Run without --dry-run to proceed.");
  } else {
    output(`Migrated ${migrated} issues (${skipped} already migrated)`);
  }
}

type RepoLabelIssue = {
  id: string;
  identifier: string;
  project: { id: string; name: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
};

type RepoLabelIssuesPage = {
  team: {
    issues: {
      nodes: RepoLabelIssue[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
};

/**
 * Fetch all issues that currently have the repo label.
 * Uses pagination to avoid implicit result caps.
 */
async function fetchIssuesByRepoLabel(
  teamId: string,
  repoLabel: string
): Promise<RepoLabelIssue[]> {
  const client = getGraphQLClient();
  const issues: RepoLabelIssue[] = [];
  let hasNextPage = true;
  let after: string | null = null;

  const query = `
    query GetIssuesByRepoLabel($teamId: String!, $labelName: String!, $after: String) {
      team(id: $teamId) {
        issues(filter: { labels: { name: { eq: $labelName } } }, first: 100, after: $after) {
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
    const page: RepoLabelIssuesPage = await client.request(query, {
      teamId,
      labelName: repoLabel,
      after,
    });

    issues.push(...page.team.issues.nodes);
    hasNextPage = page.team.issues.pageInfo.hasNextPage;
    after = page.team.issues.pageInfo.endCursor;
  }

  return issues;
}

export const migrateCommand = new Command("migrate")
  .description("Migration utilities")
  .addCommand(
    new Command("remove-type-labels")
      .description("Remove type labels (type:X or Type group) from all issues in this repo")
      .option("--dry-run", "Show what would be changed without making changes")
      .option("--team <team>", "Team key (overrides config)")
      .action(async (options) => {
        try {
          const teamId = await getTeamId(options.team);
          await removeTypeLabels(teamId, options.dryRun);
        } catch (error) {
          console.error("Error:", error instanceof Error ? error.message : error);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("to-project")
      .description(
        "Migrate label-scoped issues to project scoping (move by default, removes old repo label)"
      )
      .option("--dry-run", "Show what would be changed without making changes")
      .option("--keep-label", "Keep the repo:name label after adding to project")
      .option("--remove-label", "Deprecated alias for default behavior (remove the label)")
      .option("--team <team>", "Team key (overrides config)")
      .action(async (options) => {
        try {
          if (options.keepLabel && options.removeLabel) {
            output("Error: --keep-label and --remove-label cannot be used together.");
            process.exit(1);
          }

          if (options.removeLabel) {
            output("Note: --remove-label is now the default behavior and can be omitted.");
          }

          const teamId = await getTeamId(options.team);
          await migrateToProject(teamId, options.dryRun, options.keepLabel === true);
        } catch (error) {
          console.error("Error:", error instanceof Error ? error.message : error);
          process.exit(1);
        }
      })
  );
