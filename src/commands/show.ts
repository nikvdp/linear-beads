/**
 * lb show - Show issue details
 */

import { Command } from "commander";
import { ensureFresh, ensureFreshBestEffort } from "../utils/sync.js";
import {
  getCachedIssue,
  getDependencies,
  getBlockedIssueIds,
  getInverseDependencies,
  getDisplayId,
  resolveIssueId,
  isLocalId,
  resolveIssueLocalId,
} from "../utils/database.js";
import { fetchIssue } from "../utils/issue-backend.js";
import {
  formatShowJson,
  formatIssueHuman,
  formatIssueHumanBeads,
  formatIssueRelationSectionBeads,
  normalizeIssueDescriptionForOutput,
  output,
  outputError,
} from "../utils/output.js";
import {
  getHumanOutputStyle,
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

export function shouldPreferRemoteIssueForShow(options: {
  forceSync: boolean;
  skipRemote: boolean;
  resolvedId: string;
  hasCachedIssue: boolean;
}): boolean {
  if (options.skipRemote || isLocalId(options.resolvedId)) {
    return false;
  }

  if (options.forceSync) {
    return true;
  }

  return !options.hasCachedIssue;
}

export function shouldUseCachedIssueImmediatelyForShow(options: {
  forceSync: boolean;
  resolvedId: string;
  hasCachedIssue: boolean;
}): boolean {
  return !options.forceSync && options.hasCachedIssue && !isLocalId(options.resolvedId);
}

export const showCommand = new Command("show")
  .description("Show issue details")
  .argument("<id>", "Issue ID (e.g., TEAM-123 or 123)")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Force sync before showing")
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

      const resolvedId = resolveIssueId(id);
      let issue = getCachedIssue(resolvedId);
      const useCachedImmediately = shouldUseCachedIssueImmediatelyForShow({
        forceSync: Boolean(options.sync),
        resolvedId,
        hasCachedIssue: Boolean(issue),
      });
      const localOnly = isLocalOnly();
      let remotePause = null;
      let remoteDisabled = false;
      let skipRemote = localOnly || useCachedImmediately;

      if (!skipRemote) {
        remotePause = await getCommandRemoteSyncPause();
        remoteDisabled = Boolean(remotePause);
        skipRemote = localOnly || remoteDisabled;

        // Ensure cache is fresh (skip in local-only mode)
        if (!skipRemote) {
          if (options.sync) {
            await ensureFresh(options.team, true);
          } else {
            await ensureFreshBestEffort(options.team);
          }
          remotePause = getActiveRemoteSyncPause();
          remoteDisabled = Boolean(remotePause);
          skipRemote = localOnly || remoteDisabled;
        } else if (remoteDisabled && !options.json) {
          outputError(formatRemoteSyncPauseNotice(remotePause as NonNullable<typeof remotePause>));
        }

        // Re-read cache after the best-effort sync path in case it refreshed the issue.
        issue = getCachedIssue(resolvedId);
      } else if (remoteDisabled && !options.json) {
        outputError(formatRemoteSyncPauseNotice(remotePause as NonNullable<typeof remotePause>));
      }

      if (
        shouldPreferRemoteIssueForShow({
          forceSync: Boolean(options.sync),
          skipRemote,
          resolvedId,
          hasCachedIssue: Boolean(issue),
        })
      ) {
        try {
          issue = await fetchIssue(resolvedId);
        } catch (error) {
          const pause = recordRemoteSyncPause(error);
          if (pause && !options.json) {
            outputError(formatRemoteSyncPauseNotice(pause));
            remotePause = pause;
            remoteDisabled = true;
            skipRemote = true;
          }
          issue = undefined;
        }
      }

      // Try cache if fetch failed or this is a local-only issue.
      if (!issue) {
        issue = getCachedIssue(resolvedId);
      }

      // If still not found, try fetching directly (skip in local-only mode)
      if (!issue && !skipRemote && !isLocalId(resolvedId)) {
        try {
          issue = await fetchIssue(resolvedId);
        } catch (error) {
          const pause = recordRemoteSyncPause(error);
          if (pause && !options.json) {
            outputError(formatRemoteSyncPauseNotice(pause));
          }
        }
      }

      if (!issue) {
        outputError(`Issue not found: ${id}`);
        process.exit(1);
      }

      // Get dependencies (both directions)
      const outgoing = getDependencies(issue.id);
      const incoming = getInverseDependencies(issue.id);

      const uniqueLocal = (ids: string[]): string[] => [
        ...new Set(ids.map((v) => resolveIssueLocalId(v))),
      ];

      // Organize by relationship type
      const parent = outgoing.find((d) => d.type === "parent-child")?.depends_on_id;
      const children = uniqueLocal(
        incoming.filter((d) => d.type === "parent-child").map((d) => d.issue_id)
      );
      const blocks = uniqueLocal(
        outgoing.filter((d) => d.type === "blocks").map((d) => d.depends_on_id)
      );
      const blockedBy = uniqueLocal(
        incoming.filter((d) => d.type === "blocks").map((d) => d.issue_id)
      );
      const relatedOut = outgoing
        .filter((d) => d.type === "related" || d.type === "discovered-from")
        .map((d) => resolveIssueLocalId(d.depends_on_id));
      const relatedIn = incoming
        .filter((d) => d.type === "related" || d.type === "discovered-from")
        .map((d) => resolveIssueLocalId(d.issue_id));
      const related = [...new Set([...relatedOut, ...relatedIn])];

      // Output
      if (options.json) {
        const jsonOutput = {
          ...issue,
          description: normalizeIssueDescriptionForOutput(
            issue.description,
            issue.local_id || issue.id
          ),
          parent: parent || null,
          children: children.length > 0 ? children : undefined,
          blocks: blocks.length > 0 ? blocks : undefined,
          blocked_by: blockedBy.length > 0 ? blockedBy : undefined,
          related: related.length > 0 ? related : undefined,
        };
        output(JSON.stringify([jsonOutput], null, 2));
      } else {
        const style = getHumanOutputStyle(requestedStyle);
        const blockedIds = getBlockedIssueIds();
        const issueDisplayId = getDisplayId(issue.id);
        const relationEntry = (relatedId: string) => {
          const relatedIssue = getCachedIssue(relatedId);
          return {
            id: relatedId,
            display_id: getDisplayId(relatedId),
            title: relatedIssue?.title || "(details unavailable)",
            status: relatedIssue?.status || "open",
            priority: relatedIssue?.priority ?? 2,
            sync_status: relatedIssue?.sync_status,
            is_blocked: blockedIds.has(relatedId),
          };
        };

        output(
          style === "beads"
            ? formatIssueHumanBeads(issue, issueDisplayId, {
                isBlocked: blockedIds.has(issue.id),
                includeMetadata: true,
              })
            : formatIssueHuman(issue, issueDisplayId)
        );

        // Show relationships
        let hasRelations = false;

        if (parent) {
          if (!hasRelations) {
            output("");
            hasRelations = true;
          }
          if (style === "beads") {
            output(
              formatIssueRelationSectionBeads("Parent", [relationEntry(parent)], {
                showCount: false,
              })
            );
          } else {
            const parentIssue = getCachedIssue(parent);
            output(`Parent: ${getDisplayId(parent)}${parentIssue ? `: ${parentIssue.title}` : ""}`);
          }
        }

        if (children.length > 0) {
          if (!hasRelations) {
            output("");
            hasRelations = true;
          }
          if (style === "beads") {
            output(formatIssueRelationSectionBeads("Children", children.map(relationEntry)));
          } else {
            output(`Children (${children.length}):`);
            for (const childId of children) {
              const child = getCachedIssue(childId);
              output(
                `  ↳ ${getDisplayId(childId)}${child ? `: ${child.title} [P${child.priority}]` : ""}`
              );
            }
          }
        }

        if (blocks.length > 0) {
          if (!hasRelations) {
            output("");
            hasRelations = true;
          }
          if (style === "beads") {
            output(formatIssueRelationSectionBeads("Blocks", blocks.map(relationEntry)));
          } else {
            output(`Blocks (${blocks.length}):`);
            for (const blockedId of blocks) {
              const blocked = getCachedIssue(blockedId);
              output(
                `  ← ${getDisplayId(blockedId)}${blocked ? `: ${blocked.title} [P${blocked.priority}]` : ""}`
              );
            }
          }
        }

        if (blockedBy.length > 0) {
          if (!hasRelations) {
            output("");
            hasRelations = true;
          }
          if (style === "beads") {
            output(formatIssueRelationSectionBeads("Blocked by", blockedBy.map(relationEntry)));
          } else {
            output(`Blocked by (${blockedBy.length}):`);
            for (const blockerId of blockedBy) {
              const blocker = getCachedIssue(blockerId);
              output(
                `  → ${getDisplayId(blockerId)}${blocker ? `: ${blocker.title} [P${blocker.priority}]` : ""}`
              );
            }
          }
        }

        if (related.length > 0) {
          if (!hasRelations) {
            output("");
            hasRelations = true;
          }
          if (style === "beads") {
            output(formatIssueRelationSectionBeads("Related", related.map(relationEntry)));
          } else {
            output(`Related (${related.length}):`);
            for (const relId of related) {
              const rel = getCachedIssue(relId);
              output(`  ↔ ${getDisplayId(relId)}${rel ? `: ${rel.title} [P${rel.priority}]` : ""}`);
            }
          }
        }
      }

    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
