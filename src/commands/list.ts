/**
 * lb list - List issues
 */

import { Command } from "commander";
import { ensureFresh } from "../utils/sync.js";
import { getCachedIssues, getDependencies, getDependents } from "../utils/database.js";
import { formatIssuesListJson, formatIssuesListHuman, output } from "../utils/output.js";
import { getViewer } from "../utils/linear.js";
import type { IssueStatus } from "../types.js";
import { parsePriority, VALID_ISSUE_TYPES } from "../types.js";
import { useTypes } from "../utils/config.js";

const VALID_STATUSES: IssueStatus[] = ["open", "in_progress", "closed"];

export const listCommand = new Command("list")
  .description("List issues")
  .option("-j, --json", "Output as JSON")
  .option("-a, --all", "Show all issues (not just mine)")
  .option("-s, --status <status>", "Filter by status: open, in_progress, closed")
  .option("-p, --priority <priority>", "Filter by priority: urgent, high, medium, low, backlog (or 0-4)")
  .option("-t, --type <type>", "Filter by type: bug, feature, task, epic, chore")
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

      // Apply filters with validation
      if (options.status) {
        if (!VALID_STATUSES.includes(options.status)) {
          console.error(`Invalid status '${options.status}'. Must be one of: ${VALID_STATUSES.join(", ")}`);
          process.exit(1);
        }
        issues = issues.filter((i) => i.status === options.status);
      }
      if (options.priority !== undefined) {
        const { priority, error: priorityError } = parsePriority(options.priority);
        if (priorityError || priority === undefined) {
          console.error(priorityError);
          process.exit(1);
        }
        issues = issues.filter((i) => i.priority === priority);
      }
      if (options.type) {
        if (!useTypes()) {
          console.error(`Issue types are disabled. Enable with 'use_types: true' in config.`);
          process.exit(1);
        }
        if (!VALID_ISSUE_TYPES.includes(options.type)) {
          console.error(`Invalid type '${options.type}'. Must be one of: ${VALID_ISSUE_TYPES.join(", ")}`);
          process.exit(1);
        }
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
