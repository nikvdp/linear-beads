/**
 * lb close - Close an issue
 */

import { Command } from "commander";
import { queueOutboxItem, getCachedIssue } from "../utils/database.js";
import { closeIssue, getTeamId, fetchIssue } from "../utils/linear.js";
import { formatIssueJson, formatIssueHuman, output } from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";

export const closeCommand = new Command("close")
  .description("Close an issue")
  .argument("<id>", "Issue ID")
  .option("-r, --reason <reason>", "Close reason (added as comment)")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Sync immediately (block on network)")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      if (options.sync) {
        // Sync mode: close directly in Linear
        const teamId = await getTeamId(options.team);
        const issue = await closeIssue(id, teamId, options.reason);

        if (options.json) {
          output(formatIssueJson(issue));
        } else {
          output(formatIssueHuman(issue));
        }
      } else {
        // Queue mode: add to outbox and spawn background worker
        queueOutboxItem("close", {
          issueId: id,
          reason: options.reason,
        });

        // Ensure worker processes the outbox
        ensureOutboxProcessed();

        // Return cached issue with status updated
        let issue = getCachedIssue(id);
        if (!issue) {
          issue = await fetchIssue(id);
        }

        if (issue) {
          const closed = {
            ...issue,
            status: "closed" as const,
            closed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          if (options.json) {
            output(formatIssueJson(closed));
          } else {
            output(formatIssueHuman(closed));
          }
        } else {
          output(`Closed: ${id}`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
