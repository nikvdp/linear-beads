/**
 * lb update - Update an issue
 */

import { Command } from "commander";
import { queueOutboxItem, getCachedIssue } from "../utils/database.js";
import { updateIssue, getTeamId, fetchIssue, getViewer, getUserByEmail } from "../utils/linear.js";
import { formatIssueJson, formatIssueHuman, output, outputError } from "../utils/output.js";
import { spawnWorkerIfNeeded } from "../utils/spawn-worker.js";
import type { Priority, IssueStatus } from "../types.js";

export const updateCommand = new Command("update")
  .description("Update an issue")
  .argument("<id>", "Issue ID")
  .option("--title <title>", "New title")
  .option("-d, --description <desc>", "New description")
  .option("-s, --status <status>", "New status (open, in_progress, closed)")
  .option("-p, --priority <priority>", "New priority (0-4)")
  .option("--assign <email>", "Assign to user (email or 'me')")
  .option("--unassign", "Remove assignee")
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
        assigneeId?: string | null;
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

      // Handle assignee
      if (options.unassign) {
        updates.assigneeId = null;
      } else if (options.assign) {
        if (options.assign === "me") {
          const viewer = await getViewer();
          updates.assigneeId = viewer.id;
        } else {
          const user = await getUserByEmail(options.assign);
          if (!user) {
            outputError(`User not found: ${options.assign}`);
            process.exit(1);
          }
          updates.assigneeId = user.id;
        }
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
        // Queue mode: add to outbox and spawn background worker
        // For queue mode, pass flags for worker to resolve
        const payload: Record<string, unknown> = {
          issueId: id,
          ...updates,
        };
        // Pass assign/unassign flags for worker to resolve
        if (options.assign) payload.assign = options.assign;
        if (options.unassign) payload.unassign = true;
        // Remove assigneeId from payload - worker will resolve it
        delete payload.assigneeId;

        queueOutboxItem("update", payload);

        // Spawn background worker if not already running
        spawnWorkerIfNeeded();

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
          }
        } else {
          output(`Updated: ${id}`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
