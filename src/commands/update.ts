/**
 * lb update - Update an issue
 */

import { Command } from "commander";
import {
  queueOutboxItem,
  getCachedIssue,
  cacheIssue,
  cacheDependency,
  deleteDependency,
  getDisplayId,
  resolveIssueId,
  isLocalId,
  getDatabase,
} from "../utils/database.js";
import {
  updateIssue,
  updateIssueParent,
  getTeamId,
  fetchIssue,
  getViewer,
  getUserByEmail,
  createRelation,
} from "../utils/issue-backend.js";
import { formatIssueJson, formatIssueHuman, output, outputError } from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import type { Priority, IssueStatus } from "../types.js";
import { parsePriority } from "../types.js";
import { isLocalOnly } from "../utils/config.js";
import {
  looksLikeEscapedNewlineMistake,
  resolveDescriptionInput,
  rewriteEscapedNewlines,
} from "../utils/description-input.js";

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

function warnOnLikelyEscapedNewlineDescription(description: string | undefined): void {
  if (!looksLikeEscapedNewlineMistake(description)) return;
  outputError("");
  outputError("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  outputError("WARNING: description includes literal '\\n' sequences.");
  outputError("This usually means newlines were escaped instead of entered as real line breaks.");
  outputError("Use a heredoc, --description-file, or --description-stdin for multiline content.");
  outputError("If this was intentional, you can ignore this warning.");
  outputError("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  outputError("");
}

export const updateCommand = new Command("update")
  .description("Update an issue")
  .argument("<id>", "Issue ID")
  .option("--title <title>", "New title")
  .option("-d, --description <desc>", "New description")
  .option("--description-file <path>", "Read new description from file")
  .option("--description-stdin", "Read new description from stdin")
  .option(
    "--auto-format-escaped-newlines",
    "Rewrite literal \\\\n sequences in description content into real line breaks"
  )
  .option("-s, --status <status>", "Status: open, in_progress, closed")
  .option("-p, --priority <priority>", "Priority: urgent, high, medium, low, backlog (or 0-4)")
  .option("--assign <email>", "Assign to user (email or 'me')")
  .option("--unassign", "Remove assignee")
  .option("--parent <id>", "Set parent issue (makes this a subtask)")
  .option("--unparent", "Remove parent issue (no longer a subtask)")
  .option("--blocks <id>", "This issue blocks ID (repeatable)", collect)
  .option("--blocked-by <id>", "This issue is blocked by ID (repeatable)", collect)
  .option("--related <id>", "Related issue ID (repeatable)", collect)
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Sync immediately (block on network)")
  .option("--team <team>", "Team key (overrides config)")
  .action(async (id: string, options) => {
    try {
      const resolvedId = resolveIssueId(id);
      // Validate inputs
      let description = await resolveDescriptionInput({
        inlineDescription: options.description as string | undefined,
        descriptionFile: options.descriptionFile as string | undefined,
        descriptionStdin: !!options.descriptionStdin,
      });
      const hadExplicitDescriptionInput = description !== undefined;
      if (options.autoFormatEscapedNewlines) {
        if (description !== undefined) {
          description = rewriteEscapedNewlines(description);
        } else {
          let currentDescription: string | undefined;
          const cached = getCachedIssue(resolvedId);
          if (cached) {
            currentDescription = cached.description;
          } else if (!isLocalId(resolvedId)) {
            try {
              const fetched = await fetchIssue(resolvedId);
              currentDescription = fetched.description;
            } catch {
              // Fall through and let existing validations handle missing issue cases later.
            }
          }
          const rewritten = rewriteEscapedNewlines(currentDescription);
          if (rewritten !== currentDescription) {
            description = rewritten;
            output("Auto-formatted existing description.");
          }
        }
      }
      warnOnLikelyEscapedNewlineDescription(description);
      const updates: {
        title?: string;
        description?: string;
        status?: IssueStatus;
        priority?: Priority;
        assigneeId?: string | null;
      } = {};

      if (options.title) updates.title = options.title;
      if (description !== undefined) updates.description = description;

      if (options.status) {
        const validStatuses = ["open", "in_progress", "closed"];
        if (!validStatuses.includes(options.status)) {
          outputError(
            `Invalid status '${options.status}'. Must be one of: ${validStatuses.join(", ")}`
          );
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

      const resolvedDeps = allDeps.map((dep) => ({
        ...dep,
        targetId: resolveIssueId(dep.targetId),
      }));

      // Validate --parent and --unparent are mutually exclusive
      if (options.parent && options.unparent) {
        outputError("Cannot specify both --parent and --unparent");
        process.exit(1);
      }

      if (
        Object.keys(updates).length === 0 &&
        allDeps.length === 0 &&
        !options.parent &&
        !options.unparent
      ) {
        if (options.autoFormatEscapedNewlines && !hadExplicitDescriptionInput) {
          output("No escaped newline sequences found in existing description; no update needed.");
          return;
        }
        outputError("No updates specified");
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
        const updated = { ...issue, ...updates, updated_at: now };
        cacheIssue(updated);

        // Handle parent
        if (options.parent) {
          cacheDependency({
            issue_id: resolvedId,
            depends_on_id: resolveIssueId(options.parent),
            type: "parent-child",
            created_at: now,
            created_by: "local",
          });
        }

        // Handle unparent
        if (options.unparent) {
          const db = getDatabase();
          const parentDep = db
            .query("SELECT * FROM dependencies WHERE issue_id = ? AND type = 'parent-child'")
            .get(resolvedId) as { depends_on_id: string } | null;
          if (parentDep) {
            deleteDependency(resolvedId, parentDep.depends_on_id);
          }
        }

        // Handle deps
        for (const dep of allDeps) {
          if (dep.type === "blocked-by") {
            cacheDependency({
              issue_id: resolveIssueId(dep.targetId),
              depends_on_id: resolvedId,
              type: "blocks",
              created_at: now,
              created_by: "local",
            });
          } else {
            const depType = dep.type === "blocks" ? "blocks" : "related";
            cacheDependency({
              issue_id: resolvedId,
              depends_on_id: resolveIssueId(dep.targetId),
              type: depType as "blocks" | "related",
              created_at: now,
              created_by: "local",
            });
          }
        }

        if (options.json) {
          output(formatIssueJson(updated));
        } else {
          output(formatIssueHuman(updated, getDisplayId(updated.id)));
        }
        return;
      }

      if (options.sync) {
        if (isLocalId(resolvedId)) {
          outputError(`Issue not synced yet: ${id}`);
          process.exit(1);
        }
        // Sync mode: update directly in Linear
        const teamId = await getTeamId(options.team);
        let issue = null;

        if (Object.keys(updates).length > 0) {
          issue = await updateIssue(resolvedId, updates, teamId);
        } else {
          issue = await fetchIssue(resolvedId);
        }

        // Handle parent
        if (options.parent) {
          try {
            const parentId = resolveIssueId(options.parent);
            if (isLocalId(parentId)) {
              outputError(`Parent not synced yet: ${options.parent}`);
            } else {
              await updateIssueParent(resolvedId, parentId);
            }
          } catch (error) {
            outputError(
              `Failed to set parent to ${options.parent}: ${error instanceof Error ? error.message : error}`
            );
          }
        }

        // Handle unparent
        if (options.unparent) {
          try {
            await updateIssueParent(resolvedId, null);
            // Also remove from local cache
            const db = getDatabase();
            const parentDep = db
              .query("SELECT * FROM dependencies WHERE issue_id = ? AND type = 'parent-child'")
              .get(resolvedId) as { depends_on_id: string } | null;
            if (parentDep) {
              deleteDependency(resolvedId, parentDep.depends_on_id);
            }
          } catch (error) {
            outputError(
              `Failed to remove parent: ${error instanceof Error ? error.message : error}`
            );
          }
        }

        // Handle deps
        if (allDeps.length > 0) {
          for (const dep of allDeps) {
            try {
              if (dep.type === "blocked-by") {
                // blocked-by is inverse: target blocks this issue
                const targetId = resolveIssueId(dep.targetId);
                if (isLocalId(targetId)) {
                  outputError(`Target not synced yet: ${dep.targetId}`);
                  continue;
                }
                await createRelation(targetId, resolvedId, "blocks");
              } else {
                const targetId = resolveIssueId(dep.targetId);
                if (isLocalId(targetId)) {
                  outputError(`Target not synced yet: ${dep.targetId}`);
                  continue;
                }
                const relationType = dep.type === "blocks" ? "blocks" : "related";
                await createRelation(resolvedId, targetId, relationType);
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
            output(formatIssueHuman(issue, getDisplayId(issue.id)));
          }
        }
      } else {
        // Queue mode: add to outbox and spawn background worker
        // Convert allDeps to string format for queue
        const depsString = resolvedDeps.map((d) => `${d.type}:${d.targetId}`).join(",");

        // For queue mode, pass flags for worker to resolve
        const payload: Record<string, unknown> = {
          issueId: resolvedId,
          ...updates,
        };
        // Pass assign/unassign flags for worker to resolve
        if (options.assign) payload.assign = options.assign;
        if (options.unassign) payload.unassign = true;
        if (depsString) payload.deps = depsString;
        if (options.parent) payload.parentId = resolveIssueId(options.parent);
        if (options.unparent) payload.parentId = null;
        // Remove assigneeId from payload - worker will resolve it
        delete payload.assigneeId;

        queueOutboxItem("update", payload, resolvedId);

        // Spawn background worker if not already running
        ensureOutboxProcessed();

        // Return cached issue with updates applied
        let issue = getCachedIssue(resolvedId);
        if (!issue) {
          try {
            issue = isLocalId(resolvedId) ? null : await fetchIssue(resolvedId);
          } catch {
            issue = null;
          }
        }

        const now = new Date().toISOString();

        if (issue) {
          const updated = { ...issue, ...updates, updated_at: now };
          cacheIssue(updated);

          if (options.parent) {
            cacheDependency({
              issue_id: resolvedId,
              depends_on_id: resolveIssueId(options.parent),
              type: "parent-child",
              created_at: now,
              created_by: "local",
            });
          }

          if (options.unparent) {
            const db = getDatabase();
            const parentDep = db
              .query("SELECT * FROM dependencies WHERE issue_id = ? AND type = 'parent-child'")
              .get(resolvedId) as { depends_on_id: string } | null;
            if (parentDep) {
              deleteDependency(resolvedId, parentDep.depends_on_id);
            }
          }

          for (const dep of allDeps) {
            if (dep.type === "blocked-by") {
              cacheDependency({
                issue_id: resolveIssueId(dep.targetId),
                depends_on_id: resolvedId,
                type: "blocks",
                created_at: now,
                created_by: "local",
              });
            } else {
              const depType = dep.type === "blocks" ? "blocks" : "related";
              cacheDependency({
                issue_id: resolvedId,
                depends_on_id: resolveIssueId(dep.targetId),
                type: depType as "blocks" | "related",
                created_at: now,
                created_by: "local",
              });
            }
          }

          if (options.json) {
            output(formatIssueJson(updated));
          } else {
            output(formatIssueHuman(updated, getDisplayId(updated.id)));
          }
        } else {
          output(`Updated: ${getDisplayId(resolvedId)}`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
