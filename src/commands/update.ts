/**
 * lb update - Update an issue
 */

import { Command } from "commander";
import { queueOutboxItem, getCachedIssue } from "../utils/database.js";
import {
  updateIssue,
  updateIssueParent,
  getTeamId,
  fetchIssue,
  getViewer,
  getUserByEmail,
  createRelation,
} from "../utils/linear.js";
import { formatIssueJson, formatIssueHuman, output, outputError } from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import type { Priority, IssueStatus } from "../types.js";
import { parsePriority } from "../types.js";

const VALID_DEP_TYPES = ["blocks", "blocked-by", "related"];

/**
 * Parse deps string into array of {type, targetId}
 * Format: "type:id,type:id" e.g. "blocks:LIN-123,related:LIN-456"
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

export const updateCommand = new Command("update")
  .description("Update an issue")
  .argument("<id>", "Issue ID")
  .option("--title <title>", "New title")
  .option("-d, --description <desc>", "New description")
  .option("-s, --status <status>", "Status: open, in_progress, closed")
  .option("-p, --priority <priority>", "Priority: urgent, high, medium, low, backlog (or 0-4)")
  .option("--assign <email>", "Assign to user (email or 'me')")
  .option("--unassign", "Remove assignee")
  .option("--parent <id>", "Set parent issue (makes this a subtask)")
  .option("--blocks <id>", "This issue blocks ID (repeatable)", collect)
  .option("--blocked-by <id>", "This issue is blocked by ID (repeatable)", collect)
  .option("--related <id>", "Related issue ID (repeatable)", collect)
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Sync immediately (block on network)")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      // Validate inputs
      const updates: {
        title?: string;
        description?: string;
        status?: IssueStatus;
        priority?: Priority;
        assigneeId?: string | null;
      } = {};

      if (options.title) updates.title = options.title;
      if (options.description !== undefined) updates.description = options.description;

      if (options.status) {
        const validStatuses = ["open", "in_progress", "closed"];
        if (!validStatuses.includes(options.status)) {
          outputError(`Invalid status '${options.status}'. Must be one of: ${validStatuses.join(", ")}`);
          process.exit(1);
        }
        updates.status = options.status as IssueStatus;
      }

      if (options.priority !== undefined) {
        const { priority, error: priorityError } = parsePriority(options.priority);
        if (priorityError || priority === undefined) {
          outputError(priorityError || "Invalid priority");
          process.exit(1);
        }
        updates.priority = priority;
      }

      // Handle assignee
      if (options.unassign) {
        updates.assigneeId = null;
      } else if (options.assign) {
        if (options.assign === "me") {
          const viewer = await getViewer();
          updates.assigneeId = viewer.id;
        } else {
          const user = await getUserByEmail(options.assign);
          if (!user) {
            outputError(`User not found: ${options.assign}`);
            process.exit(1);
          }
          updates.assigneeId = user.id;
        }
      }

      // Build deps array from explicit flags + legacy --deps
      const allDeps: Array<{ type: string; targetId: string }> = [];
      
      for (const tid of options.blocks || []) {
        allDeps.push({ type: "blocks", targetId: tid });
      }
      for (const tid of options.blockedBy || []) {
        allDeps.push({ type: "blocked-by", targetId: tid });
      }
      for (const tid of options.related || []) {
        allDeps.push({ type: "related", targetId: tid });
      }
      
      if (options.deps) {
        allDeps.push(...parseDeps(options.deps));
      }

      if (Object.keys(updates).length === 0 && allDeps.length === 0 && !options.parent) {
        outputError("No updates specified");
        process.exit(1);
      }

      if (options.sync) {
        // Sync mode: update directly in Linear
        const teamId = await getTeamId(options.team);
        let issue = null;

        if (Object.keys(updates).length > 0) {
          issue = await updateIssue(id, updates, teamId);
        } else {
          issue = await fetchIssue(id);
        }

        // Handle parent
        if (options.parent) {
          try {
            await updateIssueParent(id, options.parent);
          } catch (error) {
            outputError(
              `Failed to set parent to ${options.parent}: ${error instanceof Error ? error.message : error}`
            );
          }
        }

        // Handle deps
        if (allDeps.length > 0) {
          for (const dep of allDeps) {
            try {
              if (dep.type === "blocked-by") {
                // blocked-by is inverse: target blocks this issue
                await createRelation(dep.targetId, id, "blocks");
              } else {
                const relationType = dep.type === "blocks" ? "blocks" : "related";
                await createRelation(id, dep.targetId, relationType);
              }
            } catch (error) {
              outputError(
                `Failed to create ${dep.type} relation to ${dep.targetId}: ${error instanceof Error ? error.message : error}`
              );
            }
          }
        }

        if (issue) {
          if (options.json) {
            output(formatIssueJson(issue));
          } else {
            output(formatIssueHuman(issue));
          }
        }
      } else {
        // Queue mode: add to outbox and spawn background worker
        // Convert allDeps to string format for queue
        const depsString = allDeps.map(d => `${d.type}:${d.targetId}`).join(",");
        
        // For queue mode, pass flags for worker to resolve
        const payload: Record<string, unknown> = {
          issueId: id,
          ...updates,
        };
        // Pass assign/unassign flags for worker to resolve
        if (options.assign) payload.assign = options.assign;
        if (options.unassign) payload.unassign = true;
        if (depsString) payload.deps = depsString;
        if (options.parent) payload.parentId = options.parent;
        // Remove assigneeId from payload - worker will resolve it
        delete payload.assigneeId;

        queueOutboxItem("update", payload);

        // Spawn background worker if not already running
        ensureOutboxProcessed();

        // Return cached issue with updates applied
        let issue = getCachedIssue(id);
        if (!issue) {
          issue = await fetchIssue(id);
        }

        if (issue) {
          const updated = { ...issue, ...updates, updated_at: new Date().toISOString() };
          if (options.json) {
            output(formatIssueJson(updated));
          } else {
            output(formatIssueHuman(updated));
          }
        } else {
          output(`Updated: ${id}`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
