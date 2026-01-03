/**
 * lb migrate - Migration utilities
 */

import { Command } from "commander";
import { getGraphQLClient } from "../utils/graphql.js";
import { getTeamId, fetchIssues } from "../utils/linear.js";
import { getRepoLabel, getRepoName, getRepoScope } from "../utils/config.js";
import { output } from "../utils/output.js";
import { ensureRepoProject } from "../utils/linear.js";

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
  removeLabel: boolean
): Promise<void> {
  const client = getGraphQLClient();
  const repoLabel = getRepoLabel();
  const projectName = getRepoName() || "unknown";

  // Ensure project exists
  output(`Ensuring project '${projectName}' exists...`);
  const projectId = await ensureRepoProject(teamId);
  output(`✓ Project ID: ${projectId}`);

  // Fetch all issues with the repo label
  output(`\nFetching issues with label '${repoLabel}'...`);
  const issues = await fetchIssues(teamId);
  output(`Found ${issues.length} issues`);

  if (issues.length === 0) {
    output("No issues to migrate.");
    return;
  }

  // Get repo label ID
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

  const repoLabelObj = labelsResult.team.labels.nodes.find((l) => l.name === repoLabel);
  if (!repoLabelObj) {
    output(`Warning: Repo label '${repoLabel}' not found`);
    return;
  }

  // Query to get issue details including current project and labels
  const issueQuery = `
    query GetIssue($id: String!) {
      issue(id: $id) {
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
    }
  `;

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
    const issueResult = await client.request<{
      issue: {
        id: string;
        identifier: string;
        project: { id: string; name: string } | null;
        labels: { nodes: Array<{ id: string; name: string }> };
      } | null;
    }>(issueQuery, { id: issue.id });

    if (!issueResult.issue) continue;

    // Skip if already in the project
    if (issueResult.issue.project?.id === projectId) {
      skipped++;
      continue;
    }

    // Build update input
    const input: Record<string, unknown> = {
      projectId,
    };

    // Optionally remove repo label
    if (removeLabel) {
      const newLabelIds = issueResult.issue.labels.nodes
        .filter((l) => l.id !== repoLabelObj.id)
        .map((l) => l.id);
      input.labelIds = newLabelIds;
    }

    if (dryRun) {
      const actions = [`assign to project '${projectName}'`];
      if (removeLabel) actions.push(`remove label '${repoLabel}'`);
      output(`Would update ${issue.id}: ${actions.join(", ")}`);
    } else {
      await client.request(updateMutation, {
        id: issueResult.issue.id,
        input,
      });
      const actions = [`assigned to project`];
      if (removeLabel) actions.push(`removed label`);
      output(`${issue.id}: ${actions.join(", ")}`);
    }
    migrated++;
  }

  output("");
  if (dryRun) {
    output(`Dry run: Would migrate ${migrated} issues (${skipped} already in project)`);
    output("Run without --dry-run to proceed.");
  } else {
    output(`Migrated ${migrated} issues (${skipped} already in project)`);
  }
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
      .description("Migrate label-scoped issues to project scoping")
      .option("--dry-run", "Show what would be changed without making changes")
      .option("--remove-label", "Remove the repo:name label after adding to project")
      .option("--team <team>", "Team key (overrides config)")
      .action(async (options) => {
        try {
          const teamId = await getTeamId(options.team);
          await migrateToProject(teamId, options.dryRun, options.removeLabel);
        } catch (error) {
          console.error("Error:", error instanceof Error ? error.message : error);
          process.exit(1);
        }
      })
  );
