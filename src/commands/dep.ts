/**
 * lb dep - Manage dependencies between issues
 */

import { Command } from "commander";
import { createRelation, deleteRelation, updateIssueParent } from "../utils/issue-backend.js";
import {
  getBacklogDescendantIssueIds,
  getCachedIssue,
  getBlockedIssueIds,
  getDatabase,
  cacheDependency,
  deleteDependency,
  deleteDependencyByType,
  deleteRelatedDependency,
  getDisplayId,
  resolveIssueId,
  isLocalId,
  isPlaceholderIssueInput,
  isSameCanonicalIssue,
  resolveIssueLocalId,
} from "../utils/database.js";
import {
  formatIssueHumanBeads,
  formatIssueRelationSectionBeads,
  formatIssueSummaryBeads,
  output,
  outputError,
} from "../utils/output.js";
import { queueOperation } from "../utils/spawn-worker.js";
import {
  getHumanOutputStyle,
  HUMAN_OUTPUT_STYLE_CHOICES,
  isLocalOnly,
  parseHumanOutputStyle,
} from "../utils/config.js";
import { isReadyStatus, isTerminalStatus, type Dependency } from "../types.js";
import {
  formatRemoteSyncPauseNotice,
  getCommandRemoteSyncPause,
} from "../utils/remote-sync-state.js";

/**
 * Get all dependencies involving an issue (both directions)
 */
function getAllDependencies(issueId: string): { outgoing: Dependency[]; incoming: Dependency[] } {
  const db = getDatabase();
  const resolvedId = resolveIssueLocalId(issueId);

  const outgoing = db
    .query("SELECT * FROM dependencies WHERE issue_id = ?")
    .all(resolvedId) as Dependency[];
  const incoming = db
    .query("SELECT * FROM dependencies WHERE depends_on_id = ?")
    .all(resolvedId) as Dependency[];

  return { outgoing, incoming };
}

function getRelatedCounterpartId(dep: Dependency, issueId: string): string {
  return dep.issue_id === issueId ? dep.depends_on_id : dep.issue_id;
}

function uniqueRelatedDependencies(deps: Dependency[], issueId: string): Dependency[] {
  const seen = new Set<string>();
  const result: Dependency[] = [];

  for (const dep of deps) {
    const counterpart = resolveIssueLocalId(getRelatedCounterpartId(dep, issueId));
    if (seen.has(counterpart)) {
      continue;
    }
    seen.add(counterpart);
    result.push(dep);
  }

  return result;
}

function hasRelatedDependencyBetween(issueA: string, issueB: string): boolean {
  const resolvedA = resolveIssueLocalId(issueA);
  const resolvedB = resolveIssueLocalId(issueB);
  const { outgoing, incoming } = getAllDependencies(resolvedA);
  const related = [...outgoing, ...incoming].filter((d) => d.type === "related");
  return related.some(
    (dep) => resolveIssueLocalId(getRelatedCounterpartId(dep, resolvedA)) === resolvedB
  );
}

function requireConcreteIssueInput(value: string, flagName: string): string {
  if (isPlaceholderIssueInput(value)) {
    throw new Error(`${flagName} requires a real issue ID, not '${value}'.`);
  }
  return value;
}

function assertNotSelfReferentialRelation(
  issueId: string,
  targetId: string,
  relationDescription: string
): void {
  if (!isSameCanonicalIssue(issueId, targetId)) {
    return;
  }
  throw new Error(
    `Skipped invalid relation: ${getDisplayId(issueId)} cannot ${relationDescription} itself.`
  );
}

function parseLimitOption(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid limit '${value}'. Must be a positive integer.`);
  }
  return parsed;
}

interface TreeRelationSection {
  title: string;
  issueIds: string[];
  recursive: boolean;
}

function treeConnector(prefix: string, isLast: boolean): string {
  return prefix === "" ? "" : `${prefix}${isLast ? "└── " : "├── "}`;
}

function treeChildPrefix(prefix: string, isLast: boolean): string {
  return prefix + (isLast ? "    " : "│   ");
}

function formatTreeIssueLine(
  issueId: string,
  style: "classic" | "beads",
  blockedIds: Set<string>,
  backlogDescendantIds: Set<string>,
  prefix: string,
  isLast: boolean,
  suffix: string = ""
): string {
  const issue = getCachedIssue(issueId);
  const title = issue?.title || "Unknown";
  const priority = issue?.priority ?? "?";
  const status = issue?.status || "unknown";
  const readyTag = getReadyTag(issueId, status, backlogDescendantIds);

  if (style === "beads") {
    const displayId = getDisplayId(issueId);
    return formatIssueSummaryBeads(
      {
        id: issueId,
        display_id: displayId,
        title: `${title}${readyTag}${suffix}`,
        status: issue?.status || "open",
        priority: typeof priority === "number" ? priority : 2,
        is_blocked: blockedIds.has(issueId),
        sync_status: issue?.sync_status,
      },
      treeConnector(prefix, isLast)
    );
  }

  const displayTitle = `${title}${readyTag}${suffix}`;
  if (prefix === "") {
    return `${getDisplayId(issueId)}: ${displayTitle} [P${priority}] (${status})`;
  }
  return `${treeConnector(prefix, isLast)}${getDisplayId(issueId)}: ${displayTitle} [P${priority}] (${status})`;
}

function getReadyTag(issueId: string, status: string, backlogDescendantIds: Set<string>): string {
  const { incoming } = getAllDependencies(issueId);
  const openBlockers = incoming.filter((dep) => {
    if (dep.type !== "blocks") {
      return false;
    }
    const blockerIssue = getCachedIssue(dep.issue_id);
    return blockerIssue && !isTerminalStatus(blockerIssue.status);
  });
  const isReady =
    openBlockers.length === 0 && isReadyStatus(status) && !backlogDescendantIds.has(issueId);
  return isReady ? " [READY]" : "";
}

function compareTreeIssueIds(a: string, b: string, backlogDescendantIds: Set<string>): number {
  const issueA = getCachedIssue(a);
  const issueB = getCachedIssue(b);
  const statusA = issueA?.status || "unknown";
  const statusB = issueB?.status || "unknown";
  const readyA = getReadyTag(a, statusA, backlogDescendantIds) ? 0 : 1;
  const readyB = getReadyTag(b, statusB, backlogDescendantIds) ? 0 : 1;

  if (readyA !== readyB) {
    return readyA - readyB;
  }
  if ((issueA?.priority ?? 2) !== (issueB?.priority ?? 2)) {
    return (issueA?.priority ?? 2) - (issueB?.priority ?? 2);
  }
  return (issueA?.title || "").localeCompare(issueB?.title || "");
}

function sortIssueIdsForExecution(issueIds: string[], backlogDescendantIds: Set<string>): string[] {
  const uniqueIds = [...new Set(issueIds.map((id) => resolveIssueLocalId(id)))];
  const issueSet = new Set(uniqueIds);
  const outgoingByIssue = new Map<string, Set<string>>();
  const incomingCount = new Map<string, number>();

  for (const issueId of uniqueIds) {
    outgoingByIssue.set(issueId, new Set());
    incomingCount.set(issueId, 0);
  }

  for (const issueId of uniqueIds) {
    const { outgoing } = getAllDependencies(issueId);
    for (const dep of outgoing) {
      if (dep.type !== "blocks" || !issueSet.has(dep.depends_on_id)) {
        continue;
      }
      const blockerIssue = getCachedIssue(dep.issue_id);
      if (blockerIssue && isTerminalStatus(blockerIssue.status)) {
        continue;
      }
      const outgoingForIssue = outgoingByIssue.get(dep.issue_id);
      if (!outgoingForIssue || outgoingForIssue.has(dep.depends_on_id)) {
        continue;
      }
      outgoingForIssue.add(dep.depends_on_id);
      incomingCount.set(dep.depends_on_id, (incomingCount.get(dep.depends_on_id) || 0) + 1);
    }
  }

  const result: string[] = [];
  const queue = uniqueIds
    .filter((issueId) => (incomingCount.get(issueId) || 0) === 0)
    .sort((a, b) => compareTreeIssueIds(a, b, backlogDescendantIds));

  while (queue.length > 0) {
    const issueId = queue.shift()!;
    result.push(issueId);

    const blockedIssueIds = [...(outgoingByIssue.get(issueId) || [])].sort((a, b) =>
      compareTreeIssueIds(a, b, backlogDescendantIds)
    );
    for (const blockedIssueId of blockedIssueIds) {
      incomingCount.set(blockedIssueId, (incomingCount.get(blockedIssueId) || 0) - 1);
      if (incomingCount.get(blockedIssueId) === 0) {
        queue.push(blockedIssueId);
        queue.sort((a, b) => compareTreeIssueIds(a, b, backlogDescendantIds));
      }
    }
  }

  const unresolvedIds = uniqueIds
    .filter((issueId) => !result.includes(issueId))
    .sort((a, b) => compareTreeIssueIds(a, b, backlogDescendantIds));

  return [...result, ...unresolvedIds];
}

function uniqueIssueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => resolveIssueLocalId(id)))];
}

function getTreeRelationSections(
  issueId: string,
  backlogDescendantIds: Set<string>,
  includeParent: boolean
): TreeRelationSection[] {
  const { outgoing, incoming } = getAllDependencies(issueId);
  const parent = includeParent
    ? uniqueIssueIds(
        outgoing.filter((dep) => dep.type === "parent-child").map((dep) => dep.depends_on_id)
      )
    : [];
  const children = sortIssueIdsForExecution(
    incoming.filter((dep) => dep.type === "parent-child").map((dep) => dep.issue_id),
    backlogDescendantIds
  );
  const blockedBy = sortIssueIdsForExecution(
    incoming.filter((dep) => dep.type === "blocks").map((dep) => dep.issue_id),
    backlogDescendantIds
  );
  const blocks = sortIssueIdsForExecution(
    outgoing.filter((dep) => dep.type === "blocks").map((dep) => dep.depends_on_id),
    backlogDescendantIds
  );
  const related = uniqueIssueIds(
    [...outgoing, ...incoming]
      .filter((dep) => dep.type === "related")
      .map((dep) => getRelatedCounterpartId(dep, issueId))
  ).sort((a, b) => compareTreeIssueIds(a, b, backlogDescendantIds));

  return [
    {
      title: "Parent",
      issueIds: parent,
      recursive: false,
    },
    {
      title: "Children (execution order)",
      issueIds: children,
      recursive: true,
    },
    {
      title: "Blocked by",
      issueIds: blockedBy,
      recursive: true,
    },
    {
      title: "Blocks",
      issueIds: blocks,
      recursive: true,
    },
    {
      title: "Related",
      issueIds: related,
      recursive: false,
    },
  ].filter((section) => section.issueIds.length > 0);
}

/**
 * Print dependency tree recursively
 */
function printTree(
  issueId: string,
  style: "classic" | "beads",
  blockedIds: Set<string>,
  backlogDescendantIds: Set<string>,
  prefix: string = "",
  isLast: boolean = true,
  visited: Set<string> = new Set()
): void {
  if (visited.has(issueId)) {
    output(
      formatTreeIssueLine(
        issueId,
        style,
        blockedIds,
        backlogDescendantIds,
        prefix,
        isLast,
        " (circular)"
      )
    );
    return;
  }
  visited.add(issueId);

  output(formatTreeIssueLine(issueId, style, blockedIds, backlogDescendantIds, prefix, isLast));

  const sections = getTreeRelationSections(issueId, backlogDescendantIds, prefix === "");
  const sectionPrefix = treeChildPrefix(prefix, isLast);

  sections.forEach((section, sectionIndex) => {
    const isLastSection = sectionIndex === sections.length - 1;
    output(
      `${treeConnector(sectionPrefix, isLastSection)}${section.title} (${section.issueIds.length})`
    );
    const relationPrefix = treeChildPrefix(sectionPrefix, isLastSection);

    section.issueIds.forEach((relatedIssueId, issueIndex) => {
      const isLastIssue = issueIndex === section.issueIds.length - 1;
      if (section.recursive) {
        printTree(
          relatedIssueId,
          style,
          blockedIds,
          backlogDescendantIds,
          relationPrefix,
          isLastIssue,
          new Set(visited)
        );
      } else {
        output(
          formatTreeIssueLine(
            relatedIssueId,
            style,
            blockedIds,
            backlogDescendantIds,
            relationPrefix,
            isLastIssue
          )
        );
      }
    });
  });
}

// Main dep command
export const depCommand = new Command("dep").description("Manage dependencies between issues");

// lb dep add
const addCommand = new Command("add")
  .description("Add a dependency between issues")
  .argument("<issue>", "Issue ID")
  .option("--blocks <id>", "This issue blocks the specified issue")
  .option("--blocked-by <id>", "This issue is blocked by the specified issue")
  .option("--related <id>", "This issue is related to the specified issue")
  .option("--parent <id>", "Set parent issue (makes this a subtask)")
  .option("--sync", "Sync immediately (block on network)")
  .action(async (issueId: string, options) => {
    try {
      const resolvedIssueId = resolveIssueLocalId(issueId);
      const hasOption = options.blocks || options.blockedBy || options.related || options.parent;
      if (!hasOption) {
        outputError("Must specify --blocks, --blocked-by, --related, or --parent");
        process.exit(1);
      }

      const remotePause = await getCommandRemoteSyncPause();
      const localOnly = isLocalOnly();
      const useImmediateSync = Boolean(options.sync) && !remotePause;
      if (options.sync && remotePause) {
        outputError(formatRemoteSyncPauseNotice(remotePause));
      }
      const now = new Date().toISOString();

      if (options.blocks) {
        const targetId = resolveIssueLocalId(requireConcreteIssueInput(options.blocks, "--blocks"));
        assertNotSelfReferentialRelation(resolvedIssueId, targetId, "block");
        const dep: Dependency = {
          issue_id: resolvedIssueId,
          depends_on_id: targetId,
          type: "blocks",
          created_at: now,
          created_by: "local",
        };
        if (localOnly) {
          cacheDependency(dep);
        } else if (useImmediateSync) {
          const remoteIssueId = resolveIssueId(resolvedIssueId);
          const remoteTargetId = resolveIssueId(targetId);
          if (isLocalId(remoteIssueId) || isLocalId(remoteTargetId)) {
            outputError("Dependency target not synced yet.");
            process.exit(1);
          }
          await createRelation(remoteIssueId, remoteTargetId, "blocks");
        } else {
          cacheDependency(dep);
          queueOperation(
            "create_relation",
            {
              issueId: resolvedIssueId,
              relatedIssueId: targetId,
              type: "blocks",
            },
            resolvedIssueId
          );
        }
        output(`Added: ${getDisplayId(resolvedIssueId)} blocks ${getDisplayId(targetId)}`);
      }

      if (options.blockedBy) {
        // blocked-by is inverse: target blocks this issue
        const targetId = resolveIssueLocalId(
          requireConcreteIssueInput(options.blockedBy, "--blocked-by")
        );
        assertNotSelfReferentialRelation(resolvedIssueId, targetId, "be blocked by");
        const dep: Dependency = {
          issue_id: targetId,
          depends_on_id: resolvedIssueId,
          type: "blocks",
          created_at: now,
          created_by: "local",
        };
        if (localOnly) {
          cacheDependency(dep);
        } else if (useImmediateSync) {
          const remoteIssueId = resolveIssueId(resolvedIssueId);
          const remoteTargetId = resolveIssueId(targetId);
          if (isLocalId(remoteIssueId) || isLocalId(remoteTargetId)) {
            outputError("Dependency target not synced yet.");
            process.exit(1);
          }
          await createRelation(remoteTargetId, remoteIssueId, "blocks");
        } else {
          cacheDependency(dep);
          queueOperation(
            "create_relation",
            {
              issueId: targetId,
              relatedIssueId: resolvedIssueId,
              type: "blocks",
            },
            targetId
          );
        }
        output(`Added: ${getDisplayId(resolvedIssueId)} is blocked by ${getDisplayId(targetId)}`);
      }

      if (options.related) {
        const targetId = resolveIssueLocalId(
          requireConcreteIssueInput(options.related, "--related")
        );
        assertNotSelfReferentialRelation(resolvedIssueId, targetId, "be related to");
        if (hasRelatedDependencyBetween(resolvedIssueId, targetId)) {
          output(`Already related: ${getDisplayId(resolvedIssueId)} and ${getDisplayId(targetId)}`);
          return;
        }
        const dep: Dependency = {
          issue_id: resolvedIssueId,
          depends_on_id: targetId,
          type: "related",
          created_at: now,
          created_by: "local",
        };
        if (localOnly) {
          cacheDependency(dep);
        } else if (useImmediateSync) {
          const remoteIssueId = resolveIssueId(resolvedIssueId);
          const remoteTargetId = resolveIssueId(targetId);
          if (isLocalId(remoteIssueId) || isLocalId(remoteTargetId)) {
            outputError("Dependency target not synced yet.");
            process.exit(1);
          }
          await createRelation(remoteIssueId, remoteTargetId, "related");
        } else {
          cacheDependency(dep);
          queueOperation(
            "create_relation",
            {
              issueId: resolvedIssueId,
              relatedIssueId: targetId,
              type: "related",
            },
            resolvedIssueId
          );
        }
        output(`Added: ${getDisplayId(resolvedIssueId)} related to ${getDisplayId(targetId)}`);
      }

      if (options.parent) {
        const parentId = resolveIssueLocalId(requireConcreteIssueInput(options.parent, "--parent"));
        assertNotSelfReferentialRelation(resolvedIssueId, parentId, "be its own parent");
        const dep: Dependency = {
          issue_id: resolvedIssueId,
          depends_on_id: parentId,
          type: "parent-child",
          created_at: now,
          created_by: "local",
        };
        if (localOnly) {
          cacheDependency(dep);
        } else if (useImmediateSync) {
          const remoteIssueId = resolveIssueId(resolvedIssueId);
          const remoteParentId = resolveIssueId(parentId);
          if (isLocalId(remoteIssueId) || isLocalId(remoteParentId)) {
            outputError("Parent issue not synced yet.");
            process.exit(1);
          }
          await updateIssueParent(remoteIssueId, remoteParentId);
        } else {
          cacheDependency(dep);
          queueOperation(
            "update",
            {
              issueId: resolvedIssueId,
              parentId: parentId,
            },
            resolvedIssueId
          );
        }
        output(`Added: ${getDisplayId(resolvedIssueId)} parent is ${getDisplayId(parentId)}`);
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// lb dep remove
const removeCommand = new Command("remove")
  .description("Remove a dependency between issues")
  .argument("<issue>", "Issue ID")
  .argument("[target]", "Target issue ID (for blocks/related removal)")
  .option("--blocks", "Remove blocks relationship")
  .option("--blocked-by", "Remove blocked-by relationship")
  .option("--related", "Remove related relationship")
  .option("--parent", "Remove parent relationship")
  .option("--sync", "Sync immediately (block on network)")
  .action(async (issue: string, target: string | undefined, options) => {
    try {
      const resolvedIssue = resolveIssueId(issue);
      const remotePause = await getCommandRemoteSyncPause();
      const localOnly = isLocalOnly();
      const useImmediateSync = Boolean(options.sync) && !remotePause;
      if (options.sync && remotePause) {
        outputError(formatRemoteSyncPauseNotice(remotePause));
      }

      // Legacy mode: two positional arguments (backward compatibility)
      if (target && !options.blocks && !options.blockedBy && !options.related && !options.parent) {
        const resolvedTarget = resolveIssueId(requireConcreteIssueInput(target, "target issue"));

        if (localOnly) {
          deleteDependency(resolvedIssue, resolvedTarget);
        } else if (useImmediateSync) {
          if (isLocalId(resolvedIssue) || isLocalId(resolvedTarget)) {
            outputError("Dependency target not synced yet.");
            process.exit(1);
          }
          await deleteRelation(resolvedIssue, resolvedTarget);
        } else {
          deleteDependency(resolvedIssue, resolvedTarget);
          queueOperation(
            "delete_relation",
            {
              issueA: resolvedIssue,
              issueB: resolvedTarget,
            },
            resolvedIssue
          );
        }
        output(
          `Removed dependency between ${getDisplayId(resolvedIssue)} and ${getDisplayId(resolvedTarget)}`
        );
        return;
      }

      // New flag-based mode
      const hasFlag = options.blocks || options.blockedBy || options.related || options.parent;
      if (!hasFlag) {
        outputError(
          "Must specify a relationship type to remove (--blocks, --blocked-by, --related, or --parent), or provide two issue IDs"
        );
        process.exit(1);
      }

      if (options.parent) {
        // Remove parent relationship - find the parent first
        const { outgoing } = getAllDependencies(resolvedIssue);
        const parentDep = outgoing.find((d) => d.type === "parent-child");

        if (!parentDep) {
          outputError(`No parent relationship found for ${getDisplayId(resolvedIssue)}`);
          process.exit(1);
        }

        const parentId = parentDep.depends_on_id;

        if (localOnly) {
          deleteDependencyByType(resolvedIssue, parentId, "parent-child");
        } else if (useImmediateSync) {
          if (isLocalId(resolvedIssue)) {
            outputError("Issue not synced yet.");
            process.exit(1);
          }
          // Remove parent by setting parentId to null
          await updateIssueParent(resolvedIssue, null);
          deleteDependencyByType(resolvedIssue, parentId, "parent-child");
        } else {
          deleteDependencyByType(resolvedIssue, parentId, "parent-child");
          queueOperation(
            "update",
            {
              issueId: resolvedIssue,
              parentId: null,
            },
            resolvedIssue
          );
        }
        output(
          `Removed: ${getDisplayId(resolvedIssue)} is no longer a subtask of ${getDisplayId(parentId)}`
        );
      } else if (target) {
        // For blocks/blocked-by/related, we need a target
        const resolvedTarget = resolveIssueId(requireConcreteIssueInput(target, "target issue"));

        if (options.blocks || options.blockedBy) {
          // For blocks/blocked-by, determine the direction
          const issueA = options.blockedBy ? resolvedTarget : resolvedIssue;
          const issueB = options.blockedBy ? resolvedIssue : resolvedTarget;

          if (localOnly) {
            deleteDependencyByType(issueA, issueB, "blocks");
          } else if (useImmediateSync) {
            if (isLocalId(issueA) || isLocalId(issueB)) {
              outputError("Dependency target not synced yet.");
              process.exit(1);
            }
            await deleteRelation(issueA, issueB, "blocks");
          } else {
            deleteDependencyByType(issueA, issueB, "blocks");
            queueOperation(
              "delete_relation",
              {
                issueA: issueA,
                issueB: issueB,
                relationType: "blocks",
              },
              issueA
            );
          }
          const relationText = options.blockedBy ? "is no longer blocked by" : "no longer blocks";
          output(
            `Removed: ${getDisplayId(resolvedIssue)} ${relationText} ${getDisplayId(resolvedTarget)}`
          );
        } else if (options.related) {
          if (localOnly) {
            deleteRelatedDependency(resolvedIssue, resolvedTarget);
          } else if (useImmediateSync) {
            if (isLocalId(resolvedIssue) || isLocalId(resolvedTarget)) {
              outputError("Dependency target not synced yet.");
              process.exit(1);
            }
            await deleteRelation(resolvedIssue, resolvedTarget, "related");
          } else {
            deleteRelatedDependency(resolvedIssue, resolvedTarget);
            queueOperation(
              "delete_relation",
              {
                issueA: resolvedIssue,
                issueB: resolvedTarget,
                relationType: "related",
              },
              resolvedIssue
            );
          }
          output(
            `Removed: ${getDisplayId(resolvedIssue)} is no longer related to ${getDisplayId(resolvedTarget)}`
          );
        }
      } else {
        outputError("Target issue required for --blocks, --blocked-by, or --related");
        process.exit(1);
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// lb dep list
const listCommand = new Command("list")
  .description("List all dependencies for an issue")
  .argument("<issue>", "Issue ID")
  .option("-j, --json", "Output as JSON")
  .option("-l, --limit <count>", "Show at most this many dependencies per section")
  .option("--style <style>", `Human output style: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`)
  .action(async (issueId: string, options) => {
    try {
      const requestedStyle = options.style ? parseHumanOutputStyle(options.style) : undefined;
      const limit = parseLimitOption(options.limit);
      if (options.style && !requestedStyle) {
        console.error(
          `Invalid style '${options.style}'. Must be one of: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`
        );
        process.exit(1);
      }

      const resolvedId = resolveIssueId(issueId);
      const issue = getCachedIssue(resolvedId);
      if (!issue) {
        outputError(`Issue not found: ${issueId}`);
        process.exit(1);
      }

      const { outgoing, incoming } = getAllDependencies(resolvedId);

      // Group dependencies by type
      const parent = outgoing.find((d) => d.type === "parent-child");
      const children = incoming.filter((d) => d.type === "parent-child");
      const blocks = outgoing.filter((d) => d.type === "blocks");
      const blockedBy = incoming.filter((d) => d.type === "blocks");
      const related = outgoing.filter((d) => d.type === "related");
      const relatedIncoming = incoming.filter((d) => d.type === "related");
      const relatedUnique = uniqueRelatedDependencies([...related, ...relatedIncoming], resolvedId);
      const visibleChildren = limit ? children.slice(0, limit) : children;
      const visibleBlocks = limit ? blocks.slice(0, limit) : blocks;
      const visibleBlockedBy = limit ? blockedBy.slice(0, limit) : blockedBy;
      const visibleRelated = limit ? relatedUnique.slice(0, limit) : relatedUnique;

      if (options.json) {
        const formatDep = (d: Dependency) => {
          const depIssue = getCachedIssue(d.issue_id === resolvedId ? d.depends_on_id : d.issue_id);
          return {
            id: getDisplayId(d.issue_id === resolvedId ? d.depends_on_id : d.issue_id),
            title: depIssue?.title || "Unknown",
            status: depIssue?.status || "unknown",
            priority: depIssue?.priority ?? null,
          };
        };

        output(
          JSON.stringify(
            {
              issue: {
                id: getDisplayId(resolvedId),
                title: issue.title,
                status: issue.status,
                priority: issue.priority,
              },
              parent: parent ? formatDep(parent) : null,
              children: visibleChildren.map(formatDep),
              blocks: visibleBlocks.map(formatDep),
              blockedBy: visibleBlockedBy.map(formatDep),
              related: visibleRelated.map(formatDep),
            },
            null,
            2
          )
        );
        return;
      }

      const style = getHumanOutputStyle(requestedStyle);
      if (style === "beads") {
        const blockedIds = getBlockedIssueIds();
        const toEntry = (relatedId: string) => {
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
          formatIssueHumanBeads(issue, getDisplayId(resolvedId), {
            isBlocked: blockedIds.has(resolvedId),
          })
        );
        output("");

        if (parent) {
          output(
            formatIssueRelationSectionBeads("Parent", [toEntry(parent.depends_on_id)], {
              showCount: false,
            })
          );
        }
        if (children.length > 0) {
          if (parent) output("");
          output(
            formatIssueRelationSectionBeads(
              "Children",
              visibleChildren.map((child) => toEntry(child.issue_id))
            )
          );
        }
        if (blockedBy.length > 0) {
          if (parent || children.length > 0) output("");
          output(
            formatIssueRelationSectionBeads(
              "Blocked by",
              visibleBlockedBy.map((dep) => toEntry(dep.issue_id))
            )
          );
        }
        if (blocks.length > 0) {
          if (parent || children.length > 0 || blockedBy.length > 0) output("");
          output(
            formatIssueRelationSectionBeads(
              "Blocks",
              visibleBlocks.map((dep) => toEntry(dep.depends_on_id))
            )
          );
        }
        const allRelated = visibleRelated;
        if (allRelated.length > 0) {
          if (parent || children.length > 0 || blockedBy.length > 0 || blocks.length > 0)
            output("");
          output(
            formatIssueRelationSectionBeads(
              "Related",
              allRelated.map((dep) =>
                toEntry(dep.issue_id === resolvedId ? dep.depends_on_id : dep.issue_id)
              )
            )
          );
        }

        if (
          !parent &&
          children.length === 0 &&
          blockedBy.length === 0 &&
          blocks.length === 0 &&
          relatedUnique.length === 0
        ) {
          output("No dependency relationships.");
        }
        output("");
        if (
          visibleChildren.length < children.length ||
          visibleBlockedBy.length < blockedBy.length ||
          visibleBlocks.length < blocks.length ||
          visibleRelated.length < relatedUnique.length
        ) {
          output("(some dependency sections were truncated; use --limit to adjust)");
          output("");
        }
      } else {
        // Human-readable output
        output(`\n📋 Dependencies for ${getDisplayId(resolvedId)}: ${issue.title}\n`);

        if (parent) {
          const parentIssue = getCachedIssue(parent.depends_on_id);
          output(
            `Parent: ${getDisplayId(parent.depends_on_id)} - ${parentIssue?.title || "Unknown"} (${parentIssue?.status || "unknown"})`
          );
        } else {
          output("Parent: (none)");
        }

        output("");

        if (visibleChildren.length > 0) {
          output(`Children (${children.length}):`);
          visibleChildren.forEach((child) => {
            const childIssue = getCachedIssue(child.issue_id);
            output(
              `  ${getDisplayId(child.issue_id)} - ${childIssue?.title || "Unknown"} (${childIssue?.status || "unknown"})`
            );
          });
        } else {
          output("Children: (none)");
        }

        output("");

        if (visibleBlockedBy.length > 0) {
          output(`Blocked By (${blockedBy.length}):`);
          visibleBlockedBy.forEach((dep) => {
            const blockerIssue = getCachedIssue(dep.issue_id);
            const status = blockerIssue?.status || "unknown";
            const isOpen = !isTerminalStatus(status);
            const icon = isOpen ? "🔴" : "✅";
            output(
              `  ${icon} ${getDisplayId(dep.issue_id)} - ${blockerIssue?.title || "Unknown"} (${status})`
            );
          });
        } else {
          output("Blocked By: (none)");
        }

        output("");

        if (visibleBlocks.length > 0) {
          output(`Blocks (${blocks.length}):`);
          visibleBlocks.forEach((dep) => {
            const blockedIssue = getCachedIssue(dep.depends_on_id);
            output(
              `  ${getDisplayId(dep.depends_on_id)} - ${blockedIssue?.title || "Unknown"} (${blockedIssue?.status || "unknown"})`
            );
          });
        } else {
          output("Blocks: (none)");
        }

        output("");

        const allRelated = visibleRelated;
        if (allRelated.length > 0) {
          output(`Related (${allRelated.length}):`);
          allRelated.forEach((dep) => {
            const relatedId = dep.issue_id === resolvedId ? dep.depends_on_id : dep.issue_id;
            const relatedIssue = getCachedIssue(relatedId);
            output(
              `  ${getDisplayId(relatedId)} - ${relatedIssue?.title || "Unknown"} (${relatedIssue?.status || "unknown"})`
            );
          });
        } else {
          output("Related: (none)");
        }

        output("");
        if (
          visibleChildren.length < children.length ||
          visibleBlockedBy.length < blockedBy.length ||
          visibleBlocks.length < blocks.length ||
          visibleRelated.length < relatedUnique.length
        ) {
          output("(some dependency sections were truncated; use --limit to adjust)");
          output("");
        }
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// lb dep tree
const treeCommand = new Command("tree")
  .description("Show dependency tree for an issue")
  .argument("<issue>", "Issue ID")
  .option("--style <style>", `Human output style: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`)
  .action(async (issueId: string, options) => {
    try {
      const requestedStyle = options.style ? parseHumanOutputStyle(options.style) : undefined;
      if (options.style && !requestedStyle) {
        console.error(
          `Invalid style '${options.style}'. Must be one of: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`
        );
        process.exit(1);
      }

      const resolvedId = resolveIssueId(issueId);
      const issue = getCachedIssue(resolvedId);
      if (!issue) {
        outputError(`Issue not found: ${issueId}`);
        process.exit(1);
      }

      const style = getHumanOutputStyle(requestedStyle);
      const blockedIds = getBlockedIssueIds();
      const backlogDescendantIds = getBacklogDescendantIssueIds();
      if (style === "classic") {
        output(`\n🌲 Dependency tree for ${getDisplayId(resolvedId)}:\n`);
      }
      printTree(resolvedId, style, blockedIds, backlogDescendantIds);
      output("");
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

depCommand.addCommand(addCommand);
depCommand.addCommand(removeCommand);
depCommand.addCommand(listCommand);
depCommand.addCommand(treeCommand);
