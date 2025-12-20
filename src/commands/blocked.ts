/**
 * lb blocked - List blocked issues (inverse of ready)
 */

import { Command } from "commander";
import { ensureFresh } from "../utils/sync.js";
import { getCachedIssues, getCachedIssue, getBlockedIssueIds, getDatabase } from "../utils/database.js";
import { output } from "../utils/output.js";


/**
 * Get the blockers for a specific issue
 */
function getBlockersForIssue(issueId: string): string[] {
  const db = getDatabase();
  // Find all issues that block this one (they have a 'blocks' relation pointing to this issue)
  const rows = db.query(
    "SELECT issue_id FROM dependencies WHERE depends_on_id = ? AND type = 'blocks'"
  ).all(issueId) as Array<{ issue_id: string }>;
  
  // Filter to only open blockers
  return rows
    .map(r => r.issue_id)
    .filter(id => {
      const blocker = getCachedIssue(id);
      return blocker && blocker.status !== "closed";
    });
}

export const blockedCommand = new Command("blocked")
  .description("List blocked issues (waiting on blockers)")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Force sync before listing")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (options) => {
    try {
      // Ensure cache is fresh
      await ensureFresh(options.team, options.sync);

      // Get all blocked issue IDs
      const blockedIds = getBlockedIssueIds();
      
      if (blockedIds.size === 0) {
        output("No blocked issues.");
        return;
      }

      // Get the actual issues
      const allIssues = getCachedIssues();
      const blockedIssues = allIssues.filter(
        i => blockedIds.has(i.id) && i.status !== "closed"
      );

      if (blockedIssues.length === 0) {
        output("No blocked issues.");
        return;
      }

      // Sort by priority, then updated_at
      blockedIssues.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });

      if (options.json) {
        // JSON output with blocker info
        const result = blockedIssues.map(issue => ({
          ...issue,
          blocked_by: getBlockersForIssue(issue.id),
        }));
        output(JSON.stringify(result, null, 2));
      } else {
        // Human output
        output(`\n🚫 Blocked issues (${blockedIssues.length}):\n`);
        
        for (const issue of blockedIssues) {
          const blockers = getBlockersForIssue(issue.id);
          output(`[P${issue.priority}] ${issue.id}: ${issue.title}`);
          if (blockers.length > 0) {
            output(`  Blocked by ${blockers.length} open issue${blockers.length > 1 ? 's' : ''}: [${blockers.join(', ')}]`);
          }
        }
        output("");
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
