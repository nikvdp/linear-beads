/**
 * lb create - Create a new issue
 */

import { Command } from "commander";
import { queueOutboxItem } from "../utils/database.js";
import {
  createIssue,
  getTeamId,
  getViewer,
  getUserByEmail,
  createRelation,
} from "../utils/linear.js";
import { formatIssueJson, formatIssueHuman, output } from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import type { Issue, IssueType } from "../types.js";
import { parsePriority, VALID_ISSUE_TYPES } from "../types.js";
import { useTypes } from "../utils/config.js";

const VALID_DEP_TYPES = ["blocks", "related", "discovered-from"];

/**
 * Parse deps string into array of {type, targetId}
 * Format: "type:id,type:id" e.g. "discovered-from:LIN-123,blocks:LIN-456"
 */
function parseDeps(deps: string): Array<{ type: string; targetId: string }> {
  if (!deps) return [];
  return deps.split(",").map((dep) => {
    const trimmed = dep.trim();
    if (!trimmed.includes(":")) {
      console.error(
        `Invalid dep format '${trimmed}'. Expected 'type:ID' (e.g. 'blocks:LIN-123'). Valid types: ${VALID_DEP_TYPES.join(", ")}`
      );
      process.exit(1);
    }
    const [type, targetId] = trimmed.split(":");
    if (!VALID_DEP_TYPES.includes(type)) {
      console.error(
        `Invalid dep type '${type}'. Valid types: ${VALID_DEP_TYPES.join(", ")}. For subtasks use --parent instead.`
      );
      process.exit(1);
    }
    if (!targetId) {
      console.error(
        `Missing issue ID in dep '${trimmed}'. Expected 'type:ID' (e.g. 'blocks:LIN-123')`
      );
      process.exit(1);
    }
    return { type, targetId };
  });
}

/**
 * Collect repeatable option values into an array
 */
function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

export const createCommand = new Command("create")
  .description("Create a new issue")
  .argument("<title>", "Issue title")
  .option("-d, --description <desc>", "Issue description")
  .option("-t, --type <type>", "Type: bug, feature, task, epic, chore (requires use_types config)")
  .option("-p, --priority <priority>", "Priority: urgent, high, medium, low, backlog (or 0-4)", "2")
  .option("--parent <id>", "Parent issue ID (makes this a subtask)")
  .option("--blocks <id>", "This issue blocks ID (repeatable)", collect)
  .option("--blocked-by <id>", "This issue is blocked by ID (repeatable)", collect)
  .option("--related <id>", "Related issue ID (repeatable)", collect)
  .option("--discovered-from <id>", "Found while working on ID (repeatable)", collect)
  .option("--assign <email>", "Assign to user (email or 'me')")
  .option("--unassign", "Leave unassigned (skip auto-assign)")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Sync immediately (block on network)")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (title: string, options) => {
    try {
      const { priority, error: priorityError } = parsePriority(options.priority);
      if (priorityError || priority === undefined) {
        console.error(priorityError);
        process.exit(1);
      }

      // Handle issue type - only if types are enabled or explicitly provided
      let issueType: IssueType | undefined;
      if (options.type) {
        if (!VALID_ISSUE_TYPES.includes(options.type)) {
          console.error(`Invalid type '${options.type}'. Must be one of: ${VALID_ISSUE_TYPES.join(", ")}`);
          process.exit(1);
        }
        if (!useTypes()) {
          console.warn(`Warning: -t ignored (issue types disabled in config)`);
        } else {
          issueType = options.type as IssueType;
        }
      }

      // Build deps array from explicit flags + legacy --deps
      const allDeps: Array<{ type: string; targetId: string }> = [];
      
      // Add explicit flag deps
      for (const id of options.blocks || []) {
        allDeps.push({ type: "blocks", targetId: id });
      }
      for (const id of options.blockedBy || []) {
        // blocked-by is the inverse: if A is blocked-by B, then B blocks A
        // We store this as: B blocks A, so we create relation from the target
        allDeps.push({ type: "blocked-by", targetId: id });
      }
      for (const id of options.related || []) {
        allDeps.push({ type: "related", targetId: id });
      }
      for (const id of options.discoveredFrom || []) {
        allDeps.push({ type: "discovered-from", targetId: id });
      }
      
      // Add legacy --deps format
      if (options.deps) {
        allDeps.push(...parseDeps(options.deps));
      }

      if (options.sync) {
        // Sync mode: create directly in Linear
        const teamId = await getTeamId(options.team);

        // Resolve assignee
        let assigneeId: string | undefined;
        if (options.unassign) {
          // Explicitly unassigned
          assigneeId = undefined;
        } else if (options.assign) {
          // Explicit assignment
          if (options.assign === "me") {
            const viewer = await getViewer();
            assigneeId = viewer.id;
          } else {
            const user = await getUserByEmail(options.assign);
            if (!user) {
              console.error(`User not found: ${options.assign}`);
              process.exit(1);
            }
            assigneeId = user.id;
          }
        } else {
          // Default: auto-assign to current user
          const viewer = await getViewer();
          assigneeId = viewer.id;
        }

        const issue = await createIssue({
          title,
          description: options.description,
          priority,
          issueType, // undefined if types disabled
          teamId,
          parentId: options.parent,
          assigneeId,
        });

        // Handle deps after issue creation
        if (allDeps.length > 0) {
          for (const dep of allDeps) {
            try {
              if (dep.type === "blocked-by") {
                // blocked-by is inverse: target blocks this issue
                await createRelation(dep.targetId, issue.id, "blocks");
              } else {
                // Map dep types to Linear relation types
                const relationType = dep.type === "blocks" ? "blocks" : "related";
                await createRelation(issue.id, dep.targetId, relationType);
              }
            } catch (error) {
              console.error(
                `Warning: Failed to create ${dep.type} relation to ${dep.targetId}:`,
                error instanceof Error ? error.message : error
              );
            }
          }
        }

        if (options.json) {
          output(formatIssueJson(issue));
        } else {
          output(formatIssueHuman(issue));
        }
      } else {
        // Queue mode: add to outbox and spawn background worker
        // For queue mode, we pass the assign/unassign flags
        // The worker will resolve them when processing
        
        // Convert allDeps to string format for queue
        const depsString = allDeps.map(d => `${d.type}:${d.targetId}`).join(",");
        
        const payload: Record<string, unknown> = {
          title,
          description: options.description,
          priority,
          parentId: options.parent,
          assign: options.assign,
          unassign: options.unassign || false,
          deps: depsString || undefined,
        };
        if (issueType) {
          payload.issueType = issueType;
        }
        queueOutboxItem("create", payload);

        // Spawn background worker if not already running
        ensureOutboxProcessed();

        // Return a placeholder response immediately
        const placeholder: Issue = {
          id: "pending",
          title,
          description: options.description,
          status: "open" as const,
          priority,
          issue_type: issueType,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        if (options.json) {
          output(formatIssueJson(placeholder));
        } else {
          output(`Created: ${title}`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
