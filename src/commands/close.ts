/**
 * lb close - Close an issue
 */

import { Command } from "commander";
import {
  queueOutboxItem,
  getCachedIssue,
  cacheIssue,
  getDisplayId,
  resolveIssueId,
  isLocalId,
} from "../utils/database.js";
import { closeIssue, getTeamId, fetchIssue } from "../utils/issue-backend.js";
import { formatIssueJson, formatIssueHuman, output, outputError } from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import { isLocalOnly } from "../utils/config.js";

export const closeCommand = new Command("close")
  .description("Close an issue")
  .argument("<id>", "Issue ID")
  .option("-r, --reason <reason>", "Close reason (added as comment)")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Sync immediately (block on network)")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      const resolvedId = resolveIssueId(id);
      // Local-only mode: update cache directly
      if (isLocalOnly()) {
        const issue = getCachedIssue(resolvedId);
        if (!issue) {
          outputError(`Issue not found: ${id}`);
          process.exit(1);
        }

        const now = new Date().toISOString();
        const closed = {
          ...issue,
          status: "closed" as const,
          closed_at: now,
          updated_at: now,
        };
        cacheIssue(closed);

        if (options.json) {
          output(formatIssueJson(closed));
        } else {
          output(formatIssueHuman(closed, getDisplayId(closed.id)));
        }
        return;
      }

      if (options.sync) {
        if (isLocalId(resolvedId)) {
          outputError(`Issue not synced yet: ${id}`);
          process.exit(1);
        }
        // Sync mode: close directly in Linear
        const teamId = await getTeamId(options.team);
        const issue = await closeIssue(resolvedId, teamId, options.reason);

        if (options.json) {
          output(formatIssueJson(issue));
        } else {
          output(formatIssueHuman(issue, getDisplayId(issue.id)));
        }
      } else {
        // Queue mode: add to outbox and spawn background worker
        queueOutboxItem(
          "close",
          {
            issueId: resolvedId,
            reason: options.reason,
          },
          resolvedId
        );

        // Ensure worker processes the outbox
        ensureOutboxProcessed();

        // Return cached issue with status updated
        let issue = getCachedIssue(resolvedId);
        if (!issue) {
          try {
            issue = isLocalId(resolvedId) ? null : await fetchIssue(resolvedId);
          } catch {
            issue = null;
          }
        }

        if (issue) {
          const now = new Date().toISOString();
          const closed = {
            ...issue,
            status: "closed" as const,
            closed_at: now,
            updated_at: now,
          };
          cacheIssue(closed);
          if (options.json) {
            output(formatIssueJson(closed));
          } else {
            output(formatIssueHuman(closed, getDisplayId(closed.id)));
          }
        } else {
          output(`Closed: ${getDisplayId(resolvedId)}`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
