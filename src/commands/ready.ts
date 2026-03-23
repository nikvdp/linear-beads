/**
 * lb ready - List unblocked issues ready to work on
 */

import { Command } from "commander";
import { ensureFresh, ensureFreshBestEffort } from "../utils/sync.js";
import {
  getCachedIssues,
  getDependencies,
  getBacklogDescendantIssueIds,
  getBlockedIssueIds,
  getCacheInfo,
  getDisplayId,
} from "../utils/database.js";
import { isReadyStatus } from "../types.js";
import {
  formatReadyHuman,
  formatReadyHumanBeads,
  formatReadyJson,
  output,
  outputError,
} from "../utils/output.js";
import { getViewer } from "../utils/issue-backend.js";
import {
  getHumanOutputStyle,
  getRepoName,
  getRepoScope,
  HUMAN_OUTPUT_STYLE_CHOICES,
  isLocalOnly,
  parseHumanOutputStyle,
} from "../utils/config.js";
import {
  formatRemoteSyncPauseNotice,
  getActiveRemoteSyncPause,
  getCommandRemoteSyncPause,
  recordRemoteSyncPause,
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

export const readyCommand = new Command("ready")
  .description("List unblocked issues ready to work on")
  .option("-j, --json", "Output as JSON")
  .option("-a, --all", "Show all ready issues (not just mine)")
  .option("-l, --limit <count>", "Show at most this many issues")
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
      const allIssues = getCachedIssues();

      // Filter to open issues that are not blocked
      const blockedIds = getBlockedIssueIds();
      const backlogDescendantIds = getBacklogDescendantIssueIds();
      let scopedIssues = allIssues;

      // Filter by assignee unless --all (skip in local-only mode)
      if (!options.all && !localOnly && !remoteDisabled) {
        try {
          const viewer = await getViewer();
          scopedIssues = scopedIssues.filter((i) => !i.assignee || i.assignee === viewer.email);
        } catch (error) {
          const pause = recordRemoteSyncPause(error);
          if (pause && !options.json) {
            outputError(formatRemoteSyncPauseNotice(pause));
          }
        }
      }

      let readyIssues = scopedIssues.filter(
        (i) => isReadyStatus(i.status) && !blockedIds.has(i.id) && !backlogDescendantIds.has(i.id)
      );

      // Sort by priority, then updated_at
      readyIssues.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
      const totalReadyIssues = readyIssues.length;

      // Output
      if (options.json) {
        const visibleReadyIssues = limit ? readyIssues.slice(0, limit) : readyIssues;
        output(formatReadyJson(visibleReadyIssues, getDependencies));
      } else {
        const style = getHumanOutputStyle(requestedStyle);
        const readyDisplayIssues = readyIssues.map((issue) => {
          const deps = getDependencies(issue.id);
          const parentDep = deps.find((d) => d.type === "parent-child");
          return {
            ...issue,
            display_id: getDisplayId(issue.id),
            parent_display_id: parentDep ? getDisplayId(parentDep.depends_on_id) : null,
          };
        });

        const beadsReadyIssues =
          style === "beads"
            ? [
                ...scopedIssues.filter(
                  (issue) => issue.status === "in_progress" && !backlogDescendantIds.has(issue.id)
                ),
                ...readyIssues,
              ]
            : [];
        const dedupedBeadsIssues =
          style === "beads"
            ? Array.from(
                new Map(
                  beadsReadyIssues.map((issue) => {
                    const deps = getDependencies(issue.id);
                    const parentDep = deps.find((d) => d.type === "parent-child");
                    return [
                      issue.id,
                      {
                        ...issue,
                        display_id: getDisplayId(issue.id),
                        parent_display_id: parentDep ? getDisplayId(parentDep.depends_on_id) : null,
                      },
                    ];
                  })
                ).values()
              )
            : [];
        const totalRenderedIssues =
          style === "beads" ? dedupedBeadsIssues.length : readyDisplayIssues.length;
        const visibleReadyDisplayIssues =
          style === "beads"
            ? readyDisplayIssues
            : limit
              ? readyDisplayIssues.slice(0, limit)
              : readyDisplayIssues;

        if (
          (style === "beads" ? dedupedBeadsIssues.length : visibleReadyDisplayIssues.length) === 0
        ) {
          output("No ready issues.");
          if (!options.all && !localOnly && !remoteDisabled) {
            output("Hint: ready defaults to issues assigned to you (or unassigned). Try --all.");
            output(`Scope checked: ${getRepoScope()}:${getRepoName() || "unknown"}`);
          }
          return;
        }

        if (style === "beads") {
          dedupedBeadsIssues.sort((a, b) => {
            const aInProgress = a.status === "in_progress" ? 0 : 1;
            const bInProgress = b.status === "in_progress" ? 0 : 1;
            if (aInProgress !== bInProgress) return aInProgress - bInProgress;
            if (a.priority !== b.priority) return a.priority - b.priority;
            return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
          });
          const visibleBeadsIssues = limit
            ? dedupedBeadsIssues.slice(0, limit)
            : dedupedBeadsIssues;
          output(formatReadyHumanBeads(visibleBeadsIssues));
          if (visibleBeadsIssues.length < totalRenderedIssues) {
            output(
              `(showing ${visibleBeadsIssues.length} of ${totalRenderedIssues} issues in ready view; use --limit to adjust)`
            );
          }
        } else {
          output(formatReadyHuman(visibleReadyDisplayIssues));
          if (visibleReadyDisplayIssues.length < totalReadyIssues) {
            output(
              `(showing ${visibleReadyDisplayIssues.length} of ${totalReadyIssues} ready issues; use --limit to adjust)`
            );
          }
        }

        // Show stale cache warning if sync failed or cache is old (skip in local-only mode)
        if (!localOnly) {
          const cacheInfo = getCacheInfo();
          if (remoteDisabled || syncFailed || cacheInfo.ageSeconds > 300) {
            const ageMinutes = Math.floor(cacheInfo.ageSeconds / 60);
            output(
              `(cache ${ageMinutes}m old${
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
