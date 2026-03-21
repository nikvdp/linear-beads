/**
 * lb cancel - Cancel an issue without treating it as completed work
 */

import { Command } from "commander";
import {
  queueOutboxItem,
  getCachedIssue,
  getChildIds,
  cacheIssue,
  getDisplayId,
  resolveIssueId,
  isLocalId,
} from "../utils/database.js";
import { updateIssue, getTeamId, fetchIssue } from "../utils/issue-backend.js";
import {
  formatIssueJson,
  formatIssueHuman,
  formatIssueHumanBeads,
  output,
  outputError,
} from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import {
  getHumanOutputStyle,
  HUMAN_OUTPUT_STYLE_CHOICES,
  isLocalOnly,
  parseHumanOutputStyle,
} from "../utils/config.js";
import { isTerminalStatus } from "../types.js";
import {
  formatRemoteSyncPauseNotice,
  getCommandRemoteSyncPause,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";

export const cancelCommand = new Command("cancel")
  .description("Cancel an issue without marking it done")
  .argument("<id>", "Issue ID")
  .option("-f, --force", "Cancel even if open children remain")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Sync immediately (block on network)")
  .option("--style <style>", `Human output style: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`)
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      const requestedStyle = options.style ? parseHumanOutputStyle(options.style) : undefined;
      if (options.style && !requestedStyle) {
        console.error(
          `Invalid style '${options.style}'. Must be one of: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`
        );
        process.exit(1);
      }
      const style = getHumanOutputStyle(requestedStyle);

      const resolvedId = resolveIssueId(id);
      const childIds = getChildIds(resolvedId);
      const openChildren = childIds
        .map((childId) => {
          const child = getCachedIssue(childId);
          const status = child?.status || "unknown";
          return {
            id: childId,
            title: child?.title || "Unknown",
            status,
            priority: child?.priority ?? 2,
            created_at: child?.created_at || new Date().toISOString(),
            updated_at: child?.updated_at || new Date().toISOString(),
          };
        })
        .filter((child) => !isTerminalStatus(child.status));

      if (!options.force && openChildren.length > 0) {
        if (options.json) {
          outputError(
            JSON.stringify(
              {
                error: "open_children",
                message:
                  "Cannot cancel parent issue while child issues remain open. Re-run with --force to override.",
                parent: getDisplayId(resolvedId),
                children: openChildren.map((child) => ({
                  id: getDisplayId(child.id),
                  title: child.title,
                  status: child.status,
                })),
              },
              null,
              2
            )
          );
        } else {
          outputError(`Cannot cancel ${getDisplayId(resolvedId)}: open child issues remain.`);
          for (const child of openChildren) {
            outputError(
              style === "beads"
                ? formatIssueHumanBeads(
                    {
                      id: child.id,
                      title: child.title,
                      status:
                        child.status === "closed"
                          ? "closed"
                          : child.status === "cancelled"
                            ? "cancelled"
                            : child.status === "in_progress"
                              ? "in_progress"
                              : "open",
                      priority: child.priority,
                      created_at: child.created_at,
                      updated_at: child.updated_at,
                    },
                    getDisplayId(child.id)
                  )
                : `- ${getDisplayId(child.id)} [${child.status}] ${child.title}`
            );
          }
          outputError("Use --force to cancel the parent anyway.");
        }
        process.exit(1);
      }

      if (isLocalOnly()) {
        const issue = getCachedIssue(resolvedId);
        if (!issue) {
          outputError(`Issue not found: ${id}`);
          process.exit(1);
        }

        const now = new Date().toISOString();
        const cancelled = {
          ...issue,
          status: "cancelled" as const,
          closed_at: now,
          updated_at: now,
        };
        cacheIssue(cancelled);

        if (options.json) {
          output(formatIssueJson(cancelled));
        } else {
          output(
            style === "beads"
              ? formatIssueHumanBeads(cancelled, getDisplayId(cancelled.id))
              : formatIssueHuman(cancelled, getDisplayId(cancelled.id))
          );
        }
        return;
      }

      let useImmediateSync = Boolean(options.sync);
      const remotePause = await getCommandRemoteSyncPause();
      if (useImmediateSync && remotePause) {
        outputError(formatRemoteSyncPauseNotice(remotePause));
        useImmediateSync = false;
      }

      if (useImmediateSync) {
        if (isLocalId(resolvedId)) {
          outputError(`Issue not synced yet: ${id}`);
          process.exit(1);
        }
        try {
          const teamId = await getTeamId(options.team);
          const issue = await updateIssue(resolvedId, { status: "cancelled" }, teamId);

          if (options.json) {
            output(formatIssueJson(issue));
          } else {
            output(
              style === "beads"
                ? formatIssueHumanBeads(issue, getDisplayId(issue.id))
                : formatIssueHuman(issue, getDisplayId(issue.id))
            );
          }
          return;
        } catch (error) {
          const pause = recordRemoteSyncPause(error);
          if (!pause) {
            throw error;
          }
          outputError(formatRemoteSyncPauseNotice(pause));
        }
      }

      queueOutboxItem(
        "update",
        {
          issueId: resolvedId,
          status: "cancelled",
        },
        resolvedId
      );
      ensureOutboxProcessed();

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
        const cancelled = {
          ...issue,
          status: "cancelled" as const,
          closed_at: now,
          updated_at: now,
        };
        cacheIssue(cancelled);
        if (options.json) {
          output(formatIssueJson(cancelled));
        } else {
          output(
            style === "beads"
              ? formatIssueHumanBeads(cancelled, getDisplayId(cancelled.id))
              : formatIssueHuman(cancelled, getDisplayId(cancelled.id))
          );
        }
      } else {
        output(`Cancelled: ${getDisplayId(resolvedId)}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
