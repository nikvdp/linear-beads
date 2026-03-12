/**
 * lb ready - List unblocked issues ready to work on
 */

import { Command } from "commander";
import { ensureFresh, ensureFreshBestEffort } from "../utils/sync.js";
import {
  getCachedIssues,
  getDependencies,
  getBlockedIssueIds,
  getCacheInfo,
  getDisplayId,
} from "../utils/database.js";
import {
  formatReadyHuman,
  formatReadyHumanBeads,
  formatReadyJson,
  output,
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

export const readyCommand = new Command("ready")
  .description("List unblocked issues ready to work on")
  .option("-j, --json", "Output as JSON")
  .option("-a, --all", "Show all ready issues (not just mine)")
  .option("--sync", "Force sync before listing")
  .option("--style <style>", `Human output style: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`)
  .option("--team <team>", "Team key (overrides config)")
  .action(async (options) => {
    try {
      const requestedStyle = options.style ? parseHumanOutputStyle(options.style) : undefined;
      if (options.style && !requestedStyle) {
        console.error(
          `Invalid style '${options.style}'. Must be one of: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`
        );
        process.exit(1);
      }

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
      const allIssues = getCachedIssues();

      // Filter to open issues that are not blocked
      const blockedIds = getBlockedIssueIds();
      let scopedIssues = allIssues;

      // Filter by assignee unless --all (skip in local-only mode)
      if (!options.all && !localOnly) {
        const viewer = await getViewer();
        scopedIssues = scopedIssues.filter((i) => !i.assignee || i.assignee === viewer.email);
      }

      let readyIssues = scopedIssues.filter((i) => i.status === "open" && !blockedIds.has(i.id));

      // Sort by priority, then updated_at
      readyIssues.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });

      // Output
      if (options.json) {
        output(formatReadyJson(readyIssues, getDependencies));
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
            ? [...scopedIssues.filter((issue) => issue.status === "in_progress"), ...readyIssues]
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

        if ((style === "beads" ? dedupedBeadsIssues.length : readyDisplayIssues.length) === 0) {
          output("No ready issues.");
          if (!options.all && !localOnly) {
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
          output(formatReadyHumanBeads(dedupedBeadsIssues));
        } else {
          output(formatReadyHuman(readyDisplayIssues));
        }

        // Show stale cache warning if sync failed or cache is old (skip in local-only mode)
        if (!localOnly) {
          const cacheInfo = getCacheInfo();
          if (syncFailed || cacheInfo.ageSeconds > 300) {
            const ageMinutes = Math.floor(cacheInfo.ageSeconds / 60);
            output(
              `(cache ${ageMinutes}m old${syncFailed ? ", offline" : ""} - run lb sync to refresh)`
            );
          }
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
