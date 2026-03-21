/**
 * lb blocked - List blocked issues (inverse of ready)
 */

import { Command } from "commander";
import { ensureFresh, ensureFreshBestEffort } from "../utils/sync.js";
import {
  getCachedIssues,
  getCachedIssue,
  getBlockedIssueIds,
  getDatabase,
  getDisplayId,
} from "../utils/database.js";
import {
  formatIssueRelationSectionBeads,
  formatIssueSummaryBeads,
  output,
  outputError,
} from "../utils/output.js";
import { isActionableStatus, isTerminalStatus } from "../types.js";
import {
  getHumanOutputStyle,
  HUMAN_OUTPUT_STYLE_CHOICES,
  isLocalOnly,
  parseHumanOutputStyle,
} from "../utils/config.js";
import {
  formatRemoteSyncPauseNotice,
  getCommandRemoteSyncPause,
} from "../utils/remote-sync-state.js";

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

/**
 * Get the blockers for a specific issue
 */
function getBlockersForIssue(issueId: string): string[] {
  const db = getDatabase();
  // Find all issues that block this one (they have a 'blocks' relation pointing to this issue)
  const rows = db
    .query("SELECT issue_id FROM dependencies WHERE depends_on_id = ? AND type = 'blocks'")
    .all(issueId) as Array<{ issue_id: string }>;

  // Filter to only open blockers
  return rows
    .map((r) => r.issue_id)
    .filter((id) => {
      const blocker = getCachedIssue(id);
      return blocker && !isTerminalStatus(blocker.status);
    });
}

export const blockedCommand = new Command("blocked")
  .description("List blocked issues (waiting on blockers)")
  .option("-j, --json", "Output as JSON")
  .option("-l, --limit <count>", "Show at most this many blocked issues")
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

      const remotePause = await getCommandRemoteSyncPause();
      const remoteDisabled = Boolean(remotePause);

      // Ensure cache is fresh (skip in local-only mode)
      if (!isLocalOnly() && !remoteDisabled) {
        if (options.sync) {
          await ensureFresh(options.team, true);
        } else {
          await ensureFreshBestEffort(options.team);
        }
      } else if (remoteDisabled && !options.json) {
        outputError(formatRemoteSyncPauseNotice(remotePause as NonNullable<typeof remotePause>));
      }

      // Get all blocked issue IDs
      const blockedIds = getBlockedIssueIds();

      if (blockedIds.size === 0) {
        output("No blocked issues.");
        return;
      }

      // Get the actual issues
      const allIssues = getCachedIssues();
      const blockedIssues = allIssues.filter(
        (i) => blockedIds.has(i.id) && isActionableStatus(i.status)
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
      const totalBlockedIssues = blockedIssues.length;
      const visibleBlockedIssues = limit ? blockedIssues.slice(0, limit) : blockedIssues;

      if (options.json) {
        // JSON output with blocker info
        const result = visibleBlockedIssues.map((issue) => ({
          ...issue,
          blocked_by: getBlockersForIssue(issue.id),
        }));
        output(JSON.stringify(result, null, 2));
      } else {
        const style = getHumanOutputStyle(requestedStyle);
        if (style === "beads") {
          for (const issue of visibleBlockedIssues) {
            output(
              formatIssueSummaryBeads({
                ...issue,
                display_id: getDisplayId(issue.id),
                is_blocked: true,
              })
            );
            const blockers = getBlockersForIssue(issue.id);
            if (blockers.length > 0) {
              output(
                formatIssueRelationSectionBeads(
                  "Blocked by",
                  blockers.map((blockerId) => {
                    const blocker = getCachedIssue(blockerId);
                    return {
                      id: blockerId,
                      display_id: getDisplayId(blockerId),
                      title: blocker?.title || "(details unavailable)",
                      status: blocker?.status || "open",
                      priority: blocker?.priority ?? 2,
                      sync_status: blocker?.sync_status,
                    };
                  }),
                  { indent: "  " }
                )
              );
            }
          }
          output("");
        } else {
          // Human output
          output(`\n🚫 Blocked issues (${visibleBlockedIssues.length}):\n`);

          for (const issue of visibleBlockedIssues) {
            const blockers = getBlockersForIssue(issue.id);
            output(`[P${issue.priority}] ${getDisplayId(issue.id)}: ${issue.title}`);
            if (blockers.length > 0) {
              const displayBlockers = blockers.map((id) => getDisplayId(id));
              output(
                `  Blocked by ${blockers.length} open issue${blockers.length > 1 ? "s" : ""}: [${displayBlockers.join(", ")}]`
              );
            }
          }
          output("");
        }
        if (visibleBlockedIssues.length < totalBlockedIssues) {
          output(
            `(showing ${visibleBlockedIssues.length} of ${totalBlockedIssues} blocked issues; use --limit to adjust)`
          );
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
