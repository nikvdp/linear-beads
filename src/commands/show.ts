/**
 * lb show - Show issue details
 */

import { Command } from "commander";
import type { Issue } from "../types.js";
import {
  getCachedIssue,
  getChildIds,
  getIssueComments,
  getDependencies,
  getBlockedIssueIds,
  getInverseDependencies,
  getDisplayId,
  resolveIssueId,
  isLocalId,
  resolveIssueLocalId,
} from "../utils/database.js";
import { fetchIssue, fetchIssueComments } from "../utils/issue-backend.js";
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
  getCommandRemoteSyncPause,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";
import { smartSync } from "../utils/sync.js";
import { runWithSyncProgress } from "./sync.js";

function isHiddenMailCommentBody(body: string): boolean {
  return body.includes("<!-- lb-mail-envelope:v1") || body.includes("<!-- lb-mail-directory:v1");
}

function truncateCommentBody(body: string, maxLength: number = 160): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxLength - 3)}...`;
}

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

interface IssueTreeNode {
  issue: Issue;
  children: IssueTreeNode[];
}

interface IssueTreeJson extends Issue {
  children: IssueTreeJson[];
}

function compareTreeIssues(a: Issue, b: Issue): number {
  const createdOrder = a.created_at.localeCompare(b.created_at);
  if (createdOrder !== 0) {
    return createdOrder;
  }
  return getDisplayId(a.id).localeCompare(getDisplayId(b.id), undefined, { numeric: true });
}

function buildIssueTree(issueId: string, ancestors: Set<string> = new Set()): IssueTreeNode {
  const localId = resolveIssueLocalId(issueId);
  if (ancestors.has(localId)) {
    throw new Error(
      `Cannot show issue tree: circular parent-child relationship at ${getDisplayId(localId)}`
    );
  }

  const issue = getCachedIssue(localId);
  if (!issue) {
    throw new Error(
      `Issue tree is incomplete: ${getDisplayId(localId)} is referenced but not cached. Run \`lb sync\` and retry.`
    );
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(localId);
  const childIssues = [...new Set(getChildIds(localId))]
    .map((childId) => {
      const child = getCachedIssue(childId);
      if (!child) {
        throw new Error(
          `Issue tree is incomplete: ${getDisplayId(childId)} is referenced but not cached. Run \`lb sync\` and retry.`
        );
      }
      return child;
    })
    .sort(compareTreeIssues);

  return {
    issue,
    children: childIssues.map((child) => buildIssueTree(child.id, nextAncestors)),
  };
}

function issueTreeToJson(node: IssueTreeNode): IssueTreeJson {
  return {
    ...node.issue,
    description: normalizeIssueDescriptionForOutput(
      node.issue.description,
      node.issue.local_id || node.issue.id
    ),
    children: node.children.map(issueTreeToJson),
  };
}

function formatIssueTreeOutline(
  node: IssueTreeNode,
  prefix: string = "",
  isLast: boolean = true,
  isRoot: boolean = true
): string[] {
  const connector = isRoot ? "" : isLast ? "└── " : "├── ";
  const issue = node.issue;
  const lines = [
    `${prefix}${connector}${getDisplayId(issue.id)}: ${issue.title} [P${issue.priority}] (${issue.status})`,
  ];
  const childPrefix = isRoot ? "" : `${prefix}${isLast ? "    " : "│   "}`;

  node.children.forEach((child, index) => {
    lines.push(
      ...formatIssueTreeOutline(child, childPrefix, index === node.children.length - 1, false)
    );
  });
  return lines;
}

function formatIssueTreeHuman(
  root: IssueTreeNode,
  style: "classic" | "beads",
  blockedIds: Set<string>
): string {
  const separator = "─".repeat(80);
  const nodes: IssueTreeNode[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pending.push(node.children[index]);
    }
  }
  const details = nodes.map(({ issue }) =>
    style === "beads"
      ? formatIssueHumanBeads(issue, getDisplayId(issue.id), {
          isBlocked: blockedIds.has(issue.id),
          includeMetadata: true,
        })
      : formatIssueHuman(issue, getDisplayId(issue.id))
  );

  return [
    "Tree:",
    ...formatIssueTreeOutline(root),
    "",
    separator,
    "",
    "Issue bodies:",
    "",
    details.join(`\n\n${separator}\n\n`),
  ].join("\n");
}

export const showCommand = new Command("show")
  .description("Show issue details")
  .argument("<id>", "Issue ID (e.g., TEAM-123 or 123)")
  .option("-j, --json", "Output as JSON")
  .option("--body", "Output only the normalized issue description body")
  .option("--tree", "Show this issue and all recursive children, including descriptions")
  .option("--sync", "Force sync before showing")
  .option("--style <style>", `Human output style: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`)
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      if (options.json && options.body) {
        outputError("Cannot specify both --json and --body");
        process.exit(1);
      }
      if (options.tree && options.body) {
        outputError("Cannot specify both --tree and --body");
        process.exit(1);
      }

      const requestedStyle = options.style ? parseHumanOutputStyle(options.style) : undefined;
      if (options.style && !requestedStyle) {
        console.error(
          `Invalid style '${options.style}'. Must be one of: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`
        );
        process.exit(1);
      }

      let resolvedId = resolveIssueId(id);
      const localOnly = isLocalOnly();
      if (options.tree && options.sync && !localOnly) {
        const activePause = await getCommandRemoteSyncPause();
        if (activePause) {
          if (!options.json) {
            outputError(formatRemoteSyncPauseNotice(activePause));
          }
        } else {
          try {
            await runWithSyncProgress(() => smartSync(options.team), {
              json: Boolean(options.json),
            });
          } catch (error) {
            const pause = recordRemoteSyncPause(error);
            if (pause && !options.json) {
              outputError(formatRemoteSyncPauseNotice(pause));
            }
          }
        }
        resolvedId = resolveIssueId(id);
      }

      let issue: Issue | null | undefined = getCachedIssue(resolvedId);
      let remotePause = null;
      let remoteDisabled = false;
      let skipRemote = localOnly || isLocalId(resolvedId);
      let fetchedRemoteIssue = false;

      if (!skipRemote && (options.sync || !issue)) {
        remotePause = await getCommandRemoteSyncPause();
        remoteDisabled = Boolean(remotePause);
        skipRemote = localOnly || remoteDisabled;

        if (remoteDisabled && !options.json) {
          outputError(formatRemoteSyncPauseNotice(remotePause as NonNullable<typeof remotePause>));
        }
      } else if (remoteDisabled && !options.json) {
        outputError(formatRemoteSyncPauseNotice(remotePause as NonNullable<typeof remotePause>));
      }

      if (
        shouldPreferRemoteIssueForShow({
          forceSync: Boolean(options.sync && !options.tree),
          skipRemote,
          resolvedId,
          hasCachedIssue: Boolean(issue),
        })
      ) {
        try {
          issue = await fetchIssue(resolvedId);
          fetchedRemoteIssue = true;
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
          fetchedRemoteIssue = true;
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

      if (
        (options.sync || fetchedRemoteIssue) &&
        !options.tree &&
        !options.body &&
        !skipRemote &&
        !isLocalId(issue.id)
      ) {
        try {
          await fetchIssueComments(issue.linear_identifier || issue.id);
        } catch (error) {
          const pause = recordRemoteSyncPause(error);
          if (pause && !options.json) {
            outputError(formatRemoteSyncPauseNotice(pause));
          }
        }
      }

      const normalizedDescription = normalizeIssueDescriptionForOutput(
        issue.description,
        issue.local_id || issue.id
      );

      if (options.body) {
        output(normalizedDescription ?? "");
        return;
      }

      if (options.tree) {
        const tree = buildIssueTree(issue.id);
        if (options.json) {
          output(JSON.stringify([issueTreeToJson(tree)], null, 2));
        } else {
          const style = getHumanOutputStyle(requestedStyle);
          output(formatIssueTreeHuman(tree, style, getBlockedIssueIds()));
        }
        return;
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
      const comments = getIssueComments(issue.id).filter(
        (comment) => !isHiddenMailCommentBody(comment.body)
      );

      // Output
      if (options.json) {
        const jsonOutput = {
          ...issue,
          description: normalizedDescription,
          parent: parent || null,
          children: children.length > 0 ? children : undefined,
          blocks: blocks.length > 0 ? blocks : undefined,
          blocked_by: blockedBy.length > 0 ? blockedBy : undefined,
          related: related.length > 0 ? related : undefined,
          comments,
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

        if (comments.length > 0) {
          output("");
          const recentComments = comments.slice(-3);
          output(`Comments (${comments.length}, latest ${recentComments.length}):`);
          for (const comment of recentComments) {
            const author = comment.author ? `${comment.author}: ` : "";
            const status =
              comment.sync_status && comment.sync_status !== "synced"
                ? ` [${comment.sync_status}]`
                : "";
            output(
              `  - ${comment.created_at}${status} ${author}${truncateCommentBody(comment.body)}`
            );
          }
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
