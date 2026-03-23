/**
 * lb close - Close an issue
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
import { closeIssue, getTeamId, fetchIssue } from "../utils/issue-backend.js";
import {
  formatIssueJson,
  formatIssueHuman,
  formatIssueHumanBeads,
  output,
  outputError,
} from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import { isTerminalStatus } from "../types.js";
import {
  getHumanOutputStyle,
  HUMAN_OUTPUT_STYLE_CHOICES,
  isLocalOnly,
  parseHumanOutputStyle,
} from "../utils/config.js";
import { resolveOptionalAtFileText } from "../utils/description-input.js";
import {
  formatRemoteSyncPauseNotice,
  getCommandRemoteSyncPause,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";

export const closeCommand = new Command("close")
  .description("Close an issue")
  .argument("<id>", "Issue ID")
  .option(
    "-r, --reason <reason>",
    "Close reason (added as comment); prefix with @ to read from file"
  )
  .option("-f, --force", "Close even if open children remain")
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
      const reason = await resolveOptionalAtFileText(options.reason as string | undefined);

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
                  "Cannot close parent issue while child issues remain open. Re-run with --force to override.",
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
          if (style === "beads") {
            outputError(`Cannot close ${getDisplayId(resolvedId)}: open child issues remain.`);
            for (const child of openChildren) {
              outputError(
                formatIssueHumanBeads(
                  {
                    id: child.id,
                    title: child.title,
                    status:
                      child.status === "cancelled"
                        ? "cancelled"
                        : child.status === "closed"
                          ? "closed"
                          : child.status === "in_progress"
                            ? "in_progress"
                            : "open",
                    priority: child.priority,
                    created_at: child.created_at,
                    updated_at: child.updated_at,
                  },
                  getDisplayId(child.id)
                )
              );
            }
            outputError("Use --force to close the parent anyway.");
          } else {
            outputError(`Cannot close ${getDisplayId(resolvedId)}: open child issues remain.`);
            for (const child of openChildren) {
              outputError(`- ${getDisplayId(child.id)} [${child.status}] ${child.title}`);
            }
            outputError("Use --force to close the parent anyway.");
          }
        }
        process.exit(1);
      }

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
          output(
            style === "beads"
              ? formatIssueHumanBeads(closed, getDisplayId(closed.id))
              : formatIssueHuman(closed, getDisplayId(closed.id))
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
          // Sync mode: close directly in Linear
          const teamId = await getTeamId(options.team);
          const issue = await closeIssue(resolvedId, teamId, reason);

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

      // Queue mode: add to outbox and spawn background worker
      queueOutboxItem(
        "close",
        {
          issueId: resolvedId,
          reason,
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
          output(
            style === "beads"
              ? formatIssueHumanBeads(closed, getDisplayId(closed.id))
              : formatIssueHuman(closed, getDisplayId(closed.id))
          );
        }
      } else {
        output(`Closed: ${getDisplayId(resolvedId)}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
