/**
 * lb list - List issues
 */

import { Command } from "commander";
import { ensureFresh, ensureFreshBestEffort } from "../utils/sync.js";
import {
  getCachedIssues,
  getDependencies,
  getDependents,
  getCacheInfo,
  getDisplayId,
} from "../utils/database.js";
import { formatIssuesListJson, formatIssuesListHuman, output } from "../utils/output.js";
import { getViewer } from "../utils/issue-backend.js";
import type { IssueStatus } from "../types.js";
import { parsePriority, VALID_ISSUE_TYPES } from "../types.js";
import { useTypes, isLocalOnly, getRepoName, getRepoScope } from "../utils/config.js";

const VALID_STATUSES: IssueStatus[] = ["open", "in_progress", "closed"];

export const listCommand = new Command("list")
  .description("List issues")
  .option("-j, --json", "Output as JSON")
  .option("-a, --all", "Show all issues (not just mine)")
  .option("-s, --status <status>", "Filter by status: open, in_progress, closed")
  .option(
    "-p, --priority <priority>",
    "Filter by priority: urgent, high, medium, low, backlog (or 0-4)"
  )
  .option("-t, --type <type>", "Filter by type: bug, feature, task, epic, chore")
  .option("--sync", "Force sync before listing")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (options) => {
    try {
      // Try to ensure cache is fresh, but don't fail if offline
      let syncFailed = false;
      const localOnly = isLocalOnly();

      if (!localOnly) {
        if (options.sync) {
          await ensureFresh(options.team, true);
        } else {
          const freshness = await ensureFreshBestEffort(options.team);
          syncFailed = freshness.timedOut || Boolean(freshness.error);
        }
      }

      // Get issues from cache
      let issues = getCachedIssues();

      // Filter by assignee unless --all (skip in local-only mode)
      if (!options.all && !localOnly) {
        const viewer = await getViewer();
        issues = issues.filter((i) => !i.assignee || i.assignee === viewer.email);
      }

      // Apply filters with validation
      if (options.status) {
        if (!VALID_STATUSES.includes(options.status)) {
          console.error(
            `Invalid status '${options.status}'. Must be one of: ${VALID_STATUSES.join(", ")}`
          );
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
          console.warn(`Warning: -t ignored (issue types disabled in config)`);
        } else {
          if (!VALID_ISSUE_TYPES.includes(options.type)) {
            console.error(
              `Invalid type '${options.type}'. Must be one of: ${VALID_ISSUE_TYPES.join(", ")}`
            );
            process.exit(1);
          }
          issues = issues.filter((i) => i.issue_type === options.type);
        }
      }

      // Sort by priority, then updated_at
      issues.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });

      // Output
      if (options.json) {
        // Add parent info to JSON output
        const issuesWithParent = issues.map((issue) => {
          const deps = getDependencies(issue.id);
          const parentDep = deps.find((d) => d.type === "parent-child");
          return {
            ...issue,
            parent: parentDep?.depends_on_id || null,
            dependency_count: deps.length,
            dependent_count: getDependents(issue.id).length,
          };
        });
        output(JSON.stringify(issuesWithParent, null, 2));
      } else {
        if (issues.length === 0) {
          output("No issues found.");
          if (!options.all && !localOnly) {
            output("Hint: list defaults to issues assigned to you (or unassigned). Try --all.");
            output(`Scope checked: ${getRepoScope()}:${getRepoName() || "unknown"}`);
          }
          return;
        }

        // Build output with parent context
        for (const issue of issues) {
          const deps = getDependencies(issue.id);
          const parentDep = deps.find((d) => d.type === "parent-child");
          const parentSuffix = parentDep ? ` (↳ ${getDisplayId(parentDep.depends_on_id)})` : "";
          const syncSuffix = issue.sync_status === "pending" ? " (syncing...)" : "";
          const displayId = getDisplayId(issue.id);
          const priorityName = ["crit", "high", "medi", "low", "back"][issue.priority] || "medi";
          const status = issue.status.padEnd(12);

          output(
            `${displayId}  ${status}  ${priorityName}  ${issue.title}${parentSuffix}${syncSuffix}`
          );
        }

        // Show stale cache warning if sync failed or cache is old (skip in local-only mode)
        if (!localOnly) {
          const cacheInfo = getCacheInfo();
          if (syncFailed || cacheInfo.ageSeconds > 300) {
            const ageMinutes = Math.floor(cacheInfo.ageSeconds / 60);
            output(
              `\n(cache ${ageMinutes}m old${syncFailed ? ", offline" : ""} - run lb sync to refresh)`
            );
          }
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
