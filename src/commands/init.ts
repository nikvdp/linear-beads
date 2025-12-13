/**
 * lb init - Initialize lb in current repository
 */

import { Command } from "commander";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { getDbPath, getApiKey, getRepoLabel } from "../utils/config.js";
import { getTeamId, ensureRepoLabel } from "../utils/linear.js";
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

      if (existsSync(lbDir) && !options.force) {
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

      // Ensure repo label exists
      const repoLabel = getRepoLabel();
      await ensureRepoLabel(teamId);
      output(`✓ Repo label: ${repoLabel}`);

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
