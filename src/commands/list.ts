/**
 * lb list - List issues
 */

import { Command } from "commander";
import { ensureFresh } from "../utils/sync.js";
import { getCachedIssues, getDependencies, getDependents } from "../utils/database.js";
import { formatIssuesListJson, formatIssuesListHuman, output } from "../utils/output.js";
import { getViewer } from "../utils/linear.js";
import type { Issue } from "../types.js";

export const listCommand = new Command("list")
  .description("List issues")
  .option("-j, --json", "Output as JSON")
  .option("-a, --all", "Show all issues (not just mine)")
  .option("-s, --status <status>", "Filter by status (open, in_progress, closed)")
  .option("-p, --priority <priority>", "Filter by priority (0-4)")
  .option("-t, --type <type>", "Filter by type (bug, feature, task, epic, chore)")
  .option("--sync", "Force sync before listing")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (options) => {
    try {
      // Ensure cache is fresh
      await ensureFresh(options.team, options.sync);

      // Get issues from cache
      let issues = getCachedIssues();

      // Filter by assignee unless --all
      if (!options.all) {
        const viewer = await getViewer();
        issues = issues.filter((i) => !i.assignee || i.assignee === viewer.email);
      }

      // Apply filters
      if (options.status) {
        issues = issues.filter((i) => i.status === options.status);
      }
      if (options.priority !== undefined) {
        const p = parseInt(options.priority);
        issues = issues.filter((i) => i.priority === p);
      }
      if (options.type) {
        issues = issues.filter((i) => i.issue_type === options.type);
      }

      // Sort by priority, then updated_at
      issues.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });

      // Output
      if (options.json) {
        output(
          formatIssuesListJson(
            issues,
            (id) => getDependencies(id).length,
            (id) => getDependents(id).length
          )
        );
      } else {
        output(formatIssuesListHuman(issues));
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
