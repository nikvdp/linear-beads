/**
 * lb list - List issues
 */

import { Command } from "commander";
import { ensureFresh, ensureFreshBestEffort } from "../utils/sync.js";
import {
  getCachedIssues,
  getBlockedIssueIds,
  getDependencies,
  getDependents,
  getCacheInfo,
  getDisplayId,
} from "../utils/database.js";
import {
  formatIssuesListHuman,
  formatIssuesListHumanBeads,
  output,
  outputError,
} from "../utils/output.js";
import { getViewer } from "../utils/issue-backend.js";
import type { IssueStatus } from "../types.js";
import { parsePriority, VALID_ISSUE_TYPES } from "../types.js";
import {
  getHumanOutputStyle,
  getRepoName,
  getRepoScope,
  HUMAN_OUTPUT_STYLE_CHOICES,
  isLocalOnly,
  parseHumanOutputStyle,
  useTypes,
} from "../utils/config.js";
import {
  formatRemoteSyncPauseNotice,
  getActiveRemoteSyncPause,
  getCommandRemoteSyncPause,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";

const VALID_STATUSES: IssueStatus[] = ["open", "in_progress", "closed"];

function parseLimitOption(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid limit '${value}'. Must be a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

export const listCommand = new Command("list")
  .description("List issues")
  .option("-j, --json", "Output as JSON")
  .option("-a, --all", "Show all issues (not just mine)")
  .option("-l, --limit <count>", "Show at most this many issues")
  .option("-s, --status <status>", "Filter by status: open, in_progress, closed")
  .option(
    "-p, --priority <priority>",
    "Filter by priority: urgent, high, medium, low, backlog (or 0-4)"
  )
  .option("-t, --type <type>", "Filter by type: bug, feature, task, epic, chore")
  .option("--sync", "Force sync before listing")
  .option("--style <style>", `Human output style: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`)
  .option("--team <team>", "Team key (overrides config)")
  .action(async (options) => {
    try {
      const requestedStyle = options.style ? parseHumanOutputStyle(options.style) : undefined;
      const limit = parseLimitOption(options.limit);
      if (options.style && !requestedStyle) {
        console.error(
          `Invalid style '${options.style}'. Must be one of: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`
        );
        process.exit(1);
      }

      // Try to ensure cache is fresh, but don't fail if offline
      let syncFailed = false;
      const localOnly = isLocalOnly();
      let remotePause = await getCommandRemoteSyncPause();
      let remoteDisabled = Boolean(remotePause);

      if (!localOnly && !remoteDisabled) {
        if (options.sync) {
          await ensureFresh(options.team, true);
        } else {
          const freshness = await ensureFreshBestEffort(options.team);
          syncFailed = freshness.timedOut || Boolean(freshness.error);
        }
        remotePause = getActiveRemoteSyncPause();
        remoteDisabled = Boolean(remotePause);
      } else if (remoteDisabled && !options.json) {
        outputError(formatRemoteSyncPauseNotice(remotePause as NonNullable<typeof remotePause>));
      }

      // Get issues from cache
      let issues = getCachedIssues();

      // Filter by assignee unless --all (skip in local-only mode)
      if (!options.all && !localOnly && !remoteDisabled) {
        try {
          const viewer = await getViewer();
          issues = issues.filter((i) => !i.assignee || i.assignee === viewer.email);
        } catch (error) {
          const pause = recordRemoteSyncPause(error);
          if (pause && !options.json) {
            outputError(formatRemoteSyncPauseNotice(pause));
          }
        }
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
      const totalIssues = issues.length;
      const visibleIssues = limit ? issues.slice(0, limit) : issues;

      // Output
      if (options.json) {
        // Add parent info to JSON output
        const issuesWithParent = visibleIssues.map((issue) => {
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
        if (visibleIssues.length === 0) {
          output("No issues found.");
          if (!options.all && !localOnly && !remoteDisabled) {
            output("Hint: list defaults to issues assigned to you (or unassigned). Try --all.");
            output(`Scope checked: ${getRepoScope()}:${getRepoName() || "unknown"}`);
          }
          return;
        }

        const style = getHumanOutputStyle(requestedStyle);
        const blockedIds = style === "beads" ? getBlockedIssueIds() : undefined;
        const renderedIssues = visibleIssues.map((issue) => {
          const deps = getDependencies(issue.id);
          const parentDep = deps.find((d) => d.type === "parent-child");
          return {
            ...issue,
            display_id: getDisplayId(issue.id),
            parent_display_id: parentDep ? getDisplayId(parentDep.depends_on_id) : null,
            is_blocked: blockedIds?.has(issue.id) || false,
          };
        });

        output(
          style === "beads"
            ? formatIssuesListHumanBeads(renderedIssues)
            : formatIssuesListHuman(renderedIssues)
        );
        if (visibleIssues.length < totalIssues) {
          output(
            `\n(showing ${visibleIssues.length} of ${totalIssues} issues; use --limit to adjust)`
          );
        }

        // Show stale cache warning if sync failed or cache is old (skip in local-only mode)
        if (!localOnly) {
          const cacheInfo = getCacheInfo();
          if (remoteDisabled || syncFailed || cacheInfo.ageSeconds > 300) {
            const ageMinutes = Math.floor(cacheInfo.ageSeconds / 60);
            output(
              `\n(cache ${ageMinutes}m old${
                remoteDisabled ? ", degraded" : syncFailed ? ", offline" : ""
              } - run lb sync to refresh)`
            );
          }
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
