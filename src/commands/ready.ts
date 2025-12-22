/**
 * lb ready - List unblocked issues ready to work on
 */

import { Command } from "commander";
import { ensureFresh } from "../utils/sync.js";
import { getCachedIssues, getCachedIssue, getDependencies, getBlockedIssueIds } from "../utils/database.js";
import { formatReadyJson, output } from "../utils/output.js";
import { getViewer } from "../utils/linear.js";

export const readyCommand = new Command("ready")
  .description("List unblocked issues ready to work on")
  .option("-j, --json", "Output as JSON")
  .option("-a, --all", "Show all ready issues (not just mine)")
  .option("--sync", "Force sync before listing")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (options) => {
    try {
      // Ensure cache is fresh
      await ensureFresh(options.team, options.sync);

      // Get issues from cache
      const allIssues = getCachedIssues();

      // Filter to open issues that are not blocked
      const blockedIds = getBlockedIssueIds();
      let readyIssues = allIssues.filter((i) => i.status === "open" && !blockedIds.has(i.id));

      // Filter by assignee unless --all
      if (!options.all) {
        const viewer = await getViewer();
        readyIssues = readyIssues.filter((i) => !i.assignee || i.assignee === viewer.email);
      }

      // Sort by priority, then updated_at
      readyIssues.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });

      // Output
      if (options.json) {
        output(formatReadyJson(readyIssues, getDependencies));
      } else {
        if (readyIssues.length === 0) {
          output("No ready issues.");
          return;
        }
        
        output(`\n📋 Ready work (${readyIssues.length} issue${readyIssues.length === 1 ? '' : 's'} with no blockers):\n`);
        
        readyIssues.forEach((issue, index) => {
          // Check if this is a subtask
          const deps = getDependencies(issue.id);
          const parentDep = deps.find(d => d.type === "parent-child");
          const parentInfo = parentDep ? ` (↳ ${parentDep.depends_on_id})` : "";
          
          output(`${index + 1}. [P${issue.priority}] ${issue.id}: ${issue.title}${parentInfo}`);
        });
        
        output("");
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
