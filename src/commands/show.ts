/**
 * lb show - Show issue details
 */

import { Command } from "commander";
import { ensureFresh } from "../utils/sync.js";
import { getCachedIssue, getDependencies } from "../utils/database.js";
import { fetchIssue } from "../utils/linear.js";
import { formatShowJson, formatIssueHuman, output, outputError } from "../utils/output.js";

export const showCommand = new Command("show")
  .description("Show issue details")
  .argument("<id>", "Issue ID (e.g., TEAM-123 or 123)")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Force sync before showing")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      // Ensure cache is fresh
      await ensureFresh(options.team, options.sync);

      let issue;

      // With --sync, always fetch fresh from Linear to get relations
      if (options.sync) {
        issue = await fetchIssue(id);
      }

      // Try cache if not synced or fetch failed
      if (!issue) {
        issue = getCachedIssue(id);
      }

      // If still not found, try fetching directly
      if (!issue) {
        issue = await fetchIssue(id);
      }

      if (!issue) {
        outputError(`Issue not found: ${id}`);
        process.exit(1);
      }

      // Get dependencies
      const dependencies = getDependencies(issue.id);

      // Output
      if (options.json) {
        output(formatShowJson(issue, dependencies));
      } else {
        output(formatIssueHuman(issue));
        if (dependencies.length > 0) {
          output("\nDependencies:");
          for (const dep of dependencies) {
            output(`  ${dep.type}: ${dep.depends_on_id}`);
          }
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
