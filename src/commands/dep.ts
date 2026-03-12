/**
 * lb dep - Manage dependencies between issues
 */

import { Command } from "commander";
import { createRelation, deleteRelation, updateIssueParent } from "../utils/issue-backend.js";
import {
  getDependencies,
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
import type { Dependency } from "../types.js";

/**
 * Get all dependencies involving an issue (both directions)
 */
function getAllDependencies(issueId: string): { outgoing: Dependency[]; incoming: Dependency[] } {
  const db = getDatabase();
  const resolvedId = resolveIssueId(issueId);

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

/**
 * Print dependency tree recursively
 */
function printTree(
  issueId: string,
  style: "classic" | "beads",
  blockedIds: Set<string>,
  prefix: string = "",
  isLast: boolean = true,
  visited: Set<string> = new Set()
): void {
  if (visited.has(issueId)) {
    output(`${prefix}${isLast ? "└── " : "├── "}${issueId} (circular)`);
    return;
  }
  visited.add(issueId);

  const issue = getCachedIssue(issueId);
  const title = issue?.title || "Unknown";
  const priority = issue?.priority ?? "?";
  const status = issue?.status || "unknown";

  // Check if this issue is ready (no open blockers)
  const { incoming } = getAllDependencies(issueId);
  const blockers = incoming.filter((d) => d.type === "blocks");
  const openBlockers = blockers.filter((d) => {
    const blockerIssue = getCachedIssue(d.issue_id);
    return blockerIssue && blockerIssue.status !== "closed";
  });
  const isReady = openBlockers.length === 0 && status !== "closed";
  const readyTag = isReady ? " [READY]" : "";

  if (style === "beads") {
    const displayId = getDisplayId(issueId);
    const connectorPrefix = prefix === "" ? "" : `${prefix}${isLast ? "└── " : "├── "}`;
    output(
      formatIssueSummaryBeads(
        {
          id: issueId,
          display_id: displayId,
          title: `${title}${readyTag}`,
          status: status === "closed" ? "closed" : issue?.status || "open",
          priority: typeof priority === "number" ? priority : 2,
          is_blocked: blockedIds.has(issueId),
          sync_status: issue?.sync_status,
        },
        connectorPrefix
      )
    );
  } else {
    if (prefix === "") {
      // Root node
      output(`${getDisplayId(issueId)}: ${title} [P${priority}] (${status})${readyTag}`);
    } else {
      output(
        `${prefix}${isLast ? "└── " : "├── "}${getDisplayId(issueId)}: ${title} [P${priority}] (${status})${readyTag}`
      );
    }
  }

  // Get outgoing dependencies (things this issue depends on)
  const deps = getDependencies(issueId);
  const childPrefix = prefix + (isLast ? "    " : "│   ");

  deps.forEach((dep, index) => {
    const isLastDep = index === deps.length - 1;
    printTree(dep.depends_on_id, style, blockedIds, childPrefix, isLastDep, visited);
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
      const resolvedIssueId = resolveIssueId(issueId);
      const hasOption = options.blocks || options.blockedBy || options.related || options.parent;
      if (!hasOption) {
        outputError("Must specify --blocks, --blocked-by, --related, or --parent");
        process.exit(1);
      }

      const localOnly = isLocalOnly();
      const now = new Date().toISOString();

      if (options.blocks) {
        const targetId = resolveIssueId(options.blocks);
        const dep: Dependency = {
          issue_id: resolvedIssueId,
          depends_on_id: targetId,
          type: "blocks",
          created_at: now,
          created_by: "local",
        };
        if (localOnly) {
          cacheDependency(dep);
        } else if (options.sync) {
          if (isLocalId(resolvedIssueId) || isLocalId(targetId)) {
            outputError("Dependency target not synced yet.");
            process.exit(1);
          }
          await createRelation(resolvedIssueId, targetId, "blocks");
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
        const targetId = resolveIssueId(options.blockedBy);
        const dep: Dependency = {
          issue_id: targetId,
          depends_on_id: resolvedIssueId,
          type: "blocks",
          created_at: now,
          created_by: "local",
        };
        if (localOnly) {
          cacheDependency(dep);
        } else if (options.sync) {
          if (isLocalId(resolvedIssueId) || isLocalId(targetId)) {
            outputError("Dependency target not synced yet.");
            process.exit(1);
          }
          await createRelation(targetId, resolvedIssueId, "blocks");
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
        const targetId = resolveIssueId(options.related);
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
        } else if (options.sync) {
          if (isLocalId(resolvedIssueId) || isLocalId(targetId)) {
            outputError("Dependency target not synced yet.");
            process.exit(1);
          }
          await createRelation(resolvedIssueId, targetId, "related");
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
        const parentId = resolveIssueId(options.parent);
        const dep: Dependency = {
          issue_id: resolvedIssueId,
          depends_on_id: parentId,
          type: "parent-child",
          created_at: now,
          created_by: "local",
        };
        if (localOnly) {
          cacheDependency(dep);
        } else if (options.sync) {
          if (isLocalId(resolvedIssueId) || isLocalId(parentId)) {
            outputError("Parent issue not synced yet.");
            process.exit(1);
          }
          await updateIssueParent(resolvedIssueId, parentId);
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
      const localOnly = isLocalOnly();

      // Legacy mode: two positional arguments (backward compatibility)
      if (target && !options.blocks && !options.blockedBy && !options.related && !options.parent) {
        const resolvedTarget = resolveIssueId(target);

        if (localOnly) {
          deleteDependency(resolvedIssue, resolvedTarget);
        } else if (options.sync) {
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
        } else if (options.sync) {
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
        const resolvedTarget = resolveIssueId(target);

        if (options.blocks || options.blockedBy) {
          // For blocks/blocked-by, determine the direction
          const issueA = options.blockedBy ? resolvedTarget : resolvedIssue;
          const issueB = options.blockedBy ? resolvedIssue : resolvedTarget;

          if (localOnly) {
            deleteDependencyByType(issueA, issueB, "blocks");
          } else if (options.sync) {
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
          } else if (options.sync) {
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

      const { outgoing, incoming } = getAllDependencies(resolvedId);

      // Group dependencies by type
      const parent = outgoing.find((d) => d.type === "parent-child");
      const children = incoming.filter((d) => d.type === "parent-child");
      const blocks = outgoing.filter((d) => d.type === "blocks");
      const blockedBy = incoming.filter((d) => d.type === "blocks");
      const related = outgoing.filter((d) => d.type === "related");
      const relatedIncoming = incoming.filter((d) => d.type === "related");
      const relatedUnique = uniqueRelatedDependencies([...related, ...relatedIncoming], resolvedId);

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
              children: children.map(formatDep),
              blocks: blocks.map(formatDep),
              blockedBy: blockedBy.map(formatDep),
              related: relatedUnique.map(formatDep),
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
              children.map((child) => toEntry(child.issue_id))
            )
          );
        }
        if (blockedBy.length > 0) {
          if (parent || children.length > 0) output("");
          output(
            formatIssueRelationSectionBeads(
              "Blocked by",
              blockedBy.map((dep) => toEntry(dep.issue_id))
            )
          );
        }
        if (blocks.length > 0) {
          if (parent || children.length > 0 || blockedBy.length > 0) output("");
          output(
            formatIssueRelationSectionBeads(
              "Blocks",
              blocks.map((dep) => toEntry(dep.depends_on_id))
            )
          );
        }
        const allRelated = relatedUnique;
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

        if (children.length > 0) {
          output(`Children (${children.length}):`);
          children.forEach((child) => {
            const childIssue = getCachedIssue(child.issue_id);
            output(
              `  ${getDisplayId(child.issue_id)} - ${childIssue?.title || "Unknown"} (${childIssue?.status || "unknown"})`
            );
          });
        } else {
          output("Children: (none)");
        }

        output("");

        if (blockedBy.length > 0) {
          output(`Blocked By (${blockedBy.length}):`);
          blockedBy.forEach((dep) => {
            const blockerIssue = getCachedIssue(dep.issue_id);
            const status = blockerIssue?.status || "unknown";
            const isOpen = status !== "closed";
            const icon = isOpen ? "🔴" : "✅";
            output(
              `  ${icon} ${getDisplayId(dep.issue_id)} - ${blockerIssue?.title || "Unknown"} (${status})`
            );
          });
        } else {
          output("Blocked By: (none)");
        }

        output("");

        if (blocks.length > 0) {
          output(`Blocks (${blocks.length}):`);
          blocks.forEach((dep) => {
            const blockedIssue = getCachedIssue(dep.depends_on_id);
            output(
              `  ${getDisplayId(dep.depends_on_id)} - ${blockedIssue?.title || "Unknown"} (${blockedIssue?.status || "unknown"})`
            );
          });
        } else {
          output("Blocks: (none)");
        }

        output("");

        const allRelated = relatedUnique;
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
      if (style === "classic") {
        output(`\n🌲 Dependency tree for ${getDisplayId(resolvedId)}:\n`);
      }
      printTree(resolvedId, style, blockedIds);
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
