/**
 * lb update - Update an issue
 */

import { Command } from "commander";
import { queueOutboxItem, getCachedIssue } from "../utils/database.js";
import { updateIssue, getTeamId, fetchIssue } from "../utils/linear.js";
import { formatIssueJson, formatIssueHuman, output, outputError } from "../utils/output.js";
import type { Priority, IssueStatus } from "../types.js";

export const updateCommand = new Command("update")
  .description("Update an issue")
  .argument("<id>", "Issue ID")
  .option("--title <title>", "New title")
  .option("-d, --description <desc>", "New description")
  .option("-s, --status <status>", "New status (open, in_progress, closed)")
  .option("-p, --priority <priority>", "New priority (0-4)")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Sync immediately (block on network)")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      // Validate inputs
      const updates: {
        title?: string;
        description?: string;
        status?: IssueStatus;
        priority?: Priority;
      } = {};

      if (options.title) updates.title = options.title;
      if (options.description !== undefined) updates.description = options.description;
      
      if (options.status) {
        const validStatuses = ["open", "in_progress", "closed"];
        if (!validStatuses.includes(options.status)) {
          outputError(`Status must be one of: ${validStatuses.join(", ")}`);
          process.exit(1);
        }
        updates.status = options.status as IssueStatus;
      }

      if (options.priority !== undefined) {
        const priority = parseInt(options.priority) as Priority;
        if (priority < 0 || priority > 4) {
          outputError("Priority must be 0-4");
          process.exit(1);
        }
        updates.priority = priority;
      }

      if (Object.keys(updates).length === 0) {
        outputError("No updates specified");
        process.exit(1);
      }

      if (options.sync) {
        // Sync mode: update directly in Linear
        const teamId = await getTeamId(options.team);
        const issue = await updateIssue(id, updates, teamId);

        if (options.json) {
          output(formatIssueJson(issue));
        } else {
          output(formatIssueHuman(issue));
        }
      } else {
        // Queue mode: add to outbox for later sync
        queueOutboxItem("update", {
          issueId: id,
          ...updates,
        });

        // Return cached issue with updates applied
        let issue = getCachedIssue(id);
        if (!issue) {
          issue = await fetchIssue(id);
        }

        if (issue) {
          const updated = { ...issue, ...updates, updated_at: new Date().toISOString() };
          if (options.json) {
            output(formatIssueJson(updated));
          } else {
            output(formatIssueHuman(updated));
            output("(queued - run 'lb sync' to push to Linear)");
          }
        } else {
          output(`Queued update for: ${id}`);
          output("Run 'lb sync' to push to Linear");
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
