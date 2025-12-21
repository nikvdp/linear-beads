/**
 * lb dep - Manage dependencies between issues
 */

import { Command } from "commander";
import { createRelation, deleteRelation } from "../utils/linear.js";
import { getDependencies, getCachedIssue, getDatabase, cacheDependency, deleteDependency } from "../utils/database.js";
import { output, outputError } from "../utils/output.js";
import { queueOperation } from "../utils/spawn-worker.js";
import { isLocalOnly } from "../utils/config.js";
import type { Dependency } from "../types.js";

/**
 * Get all dependencies involving an issue (both directions)
 */
function getAllDependencies(issueId: string): { outgoing: Dependency[]; incoming: Dependency[] } {
  const db = getDatabase();
  
  const outgoing = db.query("SELECT * FROM dependencies WHERE issue_id = ?").all(issueId) as Dependency[];
  const incoming = db.query("SELECT * FROM dependencies WHERE depends_on_id = ?").all(issueId) as Dependency[];
  
  return { outgoing, incoming };
}

/**
 * Print dependency tree recursively
 */
function printTree(
  issueId: string, 
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
  const blockers = incoming.filter(d => d.type === "blocks");
  const openBlockers = blockers.filter(d => {
    const blockerIssue = getCachedIssue(d.issue_id);
    return blockerIssue && blockerIssue.status !== "closed";
  });
  const isReady = openBlockers.length === 0 && status !== "closed";
  const readyTag = isReady ? " [READY]" : "";

  if (prefix === "") {
    // Root node
    output(`${issueId}: ${title} [P${priority}] (${status})${readyTag}`);
  } else {
    output(`${prefix}${isLast ? "└── " : "├── "}${issueId}: ${title} [P${priority}] (${status})${readyTag}`);
  }

  // Get outgoing dependencies (things this issue depends on)
  const deps = getDependencies(issueId);
  const childPrefix = prefix + (isLast ? "    " : "│   ");
  
  deps.forEach((dep, index) => {
    const isLastDep = index === deps.length - 1;
    printTree(dep.depends_on_id, childPrefix, isLastDep, visited);
  });
}

// Main dep command
export const depCommand = new Command("dep")
  .description("Manage dependencies between issues");

// lb dep add
const addCommand = new Command("add")
  .description("Add a dependency between issues")
  .argument("<issue>", "Issue ID")
  .option("--blocks <id>", "This issue blocks the specified issue")
  .option("--blocked-by <id>", "This issue is blocked by the specified issue")
  .option("--related <id>", "This issue is related to the specified issue")
  .option("--sync", "Sync immediately (block on network)")
  .action(async (issueId: string, options) => {
    try {
      const hasOption = options.blocks || options.blockedBy || options.related;
      if (!hasOption) {
        outputError("Must specify --blocks, --blocked-by, or --related");
        process.exit(1);
      }

      const localOnly = isLocalOnly();
      const now = new Date().toISOString();

      if (options.blocks) {
        const dep: Dependency = {
          issue_id: issueId,
          depends_on_id: options.blocks,
          type: "blocks",
          created_at: now,
          created_by: "local",
        };
        if (localOnly) {
          cacheDependency(dep);
        } else if (options.sync) {
          await createRelation(issueId, options.blocks, "blocks");
        } else {
          cacheDependency(dep);
          queueOperation("create_relation", {
            issueId,
            relatedIssueId: options.blocks,
            type: "blocks",
          });
        }
        output(`Added: ${issueId} blocks ${options.blocks}`);
      }

      if (options.blockedBy) {
        // blocked-by is inverse: target blocks this issue
        const dep: Dependency = {
          issue_id: options.blockedBy,
          depends_on_id: issueId,
          type: "blocks",
          created_at: now,
          created_by: "local",
        };
        if (localOnly) {
          cacheDependency(dep);
        } else if (options.sync) {
          await createRelation(options.blockedBy, issueId, "blocks");
        } else {
          cacheDependency(dep);
          queueOperation("create_relation", {
            issueId: options.blockedBy,
            relatedIssueId: issueId,
            type: "blocks",
          });
        }
        output(`Added: ${issueId} is blocked by ${options.blockedBy}`);
      }

      if (options.related) {
        const dep: Dependency = {
          issue_id: issueId,
          depends_on_id: options.related,
          type: "related",
          created_at: now,
          created_by: "local",
        };
        if (localOnly) {
          cacheDependency(dep);
        } else if (options.sync) {
          await createRelation(issueId, options.related, "related");
        } else {
          cacheDependency(dep);
          queueOperation("create_relation", {
            issueId,
            relatedIssueId: options.related,
            type: "related",
          });
        }
        output(`Added: ${issueId} related to ${options.related}`);
      }
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// lb dep remove
const removeCommand = new Command("remove")
  .description("Remove a dependency between issues")
  .argument("<issue-a>", "First issue ID")
  .argument("<issue-b>", "Second issue ID")
  .option("--sync", "Sync immediately (block on network)")
  .action(async (issueA: string, issueB: string, options) => {
    try {
      const localOnly = isLocalOnly();
      
      if (localOnly) {
        deleteDependency(issueA, issueB);
      } else if (options.sync) {
        await deleteRelation(issueA, issueB);
      } else {
        deleteDependency(issueA, issueB);
        queueOperation("delete_relation", {
          issueA,
          issueB,
        });
      }
      output(`Removed dependency between ${issueA} and ${issueB}`);
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// lb dep tree
const treeCommand = new Command("tree")
  .description("Show dependency tree for an issue")
  .argument("<issue>", "Issue ID")
  .action(async (issueId: string) => {
    try {
      const issue = getCachedIssue(issueId);
      if (!issue) {
        outputError(`Issue not found: ${issueId}`);
        process.exit(1);
      }

      output(`\n🌲 Dependency tree for ${issueId}:\n`);
      printTree(issueId);
      output("");
    } catch (error) {
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

depCommand.addCommand(addCommand);
depCommand.addCommand(removeCommand);
depCommand.addCommand(treeCommand);
