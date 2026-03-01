/**
 * lb init - Initialize lb in current repository
 */

import { Command } from "commander";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { Database } from "bun:sqlite";
import {
  getDbPath,
  getApiKey,
  getRepoLabel,
  getRepoName,
  getRepoBindingVersion,
  getRepoScope,
  hasRepoConfig,
  type RepoBindingVersion,
  useLabelScope,
  useProjectScope,
  writeRepoConfig,
} from "../utils/config.js";
import { getTeamId, ensureRepoLabel, ensureRepoProject } from "../utils/issue-backend.js";
import { fullSync } from "../utils/sync.js";
import { output } from "../utils/output.js";

export const initCommand = new Command("init")
  .description("Initialize lb in current repository")
  .option("--force", "Re-initialize even if .lb/ already exists")
  .action(async (options) => {
    try {
      output("Initializing lb in current directory...\n");

      // Check if already initialized
      const dbPath = getDbPath();
      const lbDir = dirname(dbPath);
      const hasLbDir = existsSync(lbDir);
      const repoConfigExists = hasRepoConfig();
      const needsConfigBootstrap = !repoConfigExists;

      if (hasLbDir && !options.force && !needsConfigBootstrap) {
        output("✓ Already initialized (.lb/ exists)");
        output("\nUse --force to re-initialize");
        return;
      }

      // Verify API key
      try {
        getApiKey();
        output("✓ Linear API key found");
      } catch (error) {
        output("✗ No Linear API key configured");
        output("\nRun 'lb auth' first to configure your API key");
        output("Or set LINEAR_API_KEY environment variable");
        process.exit(1);
      }

      // Get/detect team
      const teamId = await getTeamId();
      const team = await getTeamInfo(teamId);
      output(`✓ Team: ${team.name} (${team.key})`);

      // Create .lb/ directory
      if (!existsSync(lbDir)) {
        mkdirSync(lbDir, { recursive: true });
      }

      // Bootstrap missing config independent of whether .lb exists.
      // We detect legacy repos to preserve label defaults and use v2/project
      // defaults only for truly new repos.
      if (!hasRepoConfig()) {
        const repoName = getRepoName() || "unknown";
        const bindingVersion = await inferRepoBindingVersion({
          dbPath,
          teamId,
          repoName,
        });
        const configPath = writeRepoConfig({
          repo_name: repoName,
          repo_binding_version: bindingVersion,
        });
        output(`✓ Created repo config: ${configPath}`);
        output(
          `✓ Repo binding policy: v${bindingVersion} (${bindingVersion === 1 ? "legacy label default" : "project default"})`
        );
      }

      // Ensure repo scoping (label/project/both) based on config
      const scope = getRepoScope();
      output(`✓ Repo scoping: ${scope} (binding v${getRepoBindingVersion()})`);

      if (useLabelScope()) {
        const repoLabel = getRepoLabel();
        await ensureRepoLabel(teamId);
        output(`✓ Repo label: ${repoLabel}`);
      }

      if (useProjectScope()) {
        const projectName = getRepoName() || "unknown";
        await ensureRepoProject(teamId);
        output(`✓ Repo project: ${projectName}`);
      }

      // Initial sync
      const result = await fullSync();
      output(`✓ Synced ${result.pulled} issues`);
      output("✓ Exported to .lb/issues.jsonl");

      // Success!
      output("\nlb initialized!");
      output("\nAdd this to your AGENTS.md or CLAUDE.md:");
      output("");
      output("  This project uses lb for issue tracking.");
      output("  Run `lb onboard` and follow the instructions.");
      output("");
      output("Then your agent will set up the rest.");
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Get team info for display
 */
async function getTeamInfo(teamId: string): Promise<{ name: string; key: string }> {
  const { getGraphQLClient } = await import("../utils/graphql.js");
  const client = getGraphQLClient();

  const query = `
    query GetTeam($id: String!) {
      team(id: $id) {
        id
        key
        name
      }
    }
  `;

  const result = await client.request<{
    team: { id: string; key: string; name: string };
  }>(query, { id: teamId });

  return result.team;
}

function repoLabelForName(repoName: string): string {
  return `repo:${repoName}`;
}

function hasTable(db: Database, tableName: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | null;
  return Boolean(row?.name);
}

function tableHasRows(db: Database, tableName: string): boolean {
  const row = db.query(`SELECT 1 AS present FROM ${tableName} LIMIT 1`).get() as {
    present?: number;
  } | null;
  return row?.present === 1;
}

function hasLegacyLocalState(dbPath: string): boolean {
  if (!existsSync(dbPath)) {
    return false;
  }

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const legacySignalTables = ["issues", "outbox", "dependencies", "metadata"];

    for (const tableName of legacySignalTables) {
      if (hasTable(db, tableName) && tableHasRows(db, tableName)) {
        return true;
      }
    }

    return false;
  } catch {
    // Preserve old behavior when local state is unreadable.
    return true;
  } finally {
    db?.close();
  }
}

async function hasLegacyRemoteLabelState(teamId: string, repoName: string): Promise<boolean> {
  const { getGraphQLClient } = await import("../utils/graphql.js");
  const client = getGraphQLClient();

  const query = `
    query HasRepoLabelIssues($teamId: String!, $labelName: String!) {
      team(id: $teamId) {
        issues(filter: { labels: { name: { eq: $labelName } } }, first: 1) {
          nodes {
            id
          }
        }
      }
    }
  `;

  try {
    const result = await client.request<{
      team: {
        issues: {
          nodes: Array<{ id: string }>;
        };
      };
    }>(query, { teamId, labelName: repoLabelForName(repoName) });

    return result.team.issues.nodes.length > 0;
  } catch {
    // Preserve old behavior on detection failures.
    return true;
  }
}

async function inferRepoBindingVersion(params: {
  dbPath: string;
  teamId: string;
  repoName: string;
}): Promise<RepoBindingVersion> {
  if (hasLegacyLocalState(params.dbPath)) {
    return 1;
  }

  if (await hasLegacyRemoteLabelState(params.teamId, params.repoName)) {
    return 1;
  }

  return 2;
}
