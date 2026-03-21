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
  isPlaceholderIssueInput,
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
import { toCanonicalLocalDescription } from "../utils/linear.js";
import {
  formatIssueJson,
  formatIssueHuman,
  formatIssueHumanBeads,
  output,
  outputError,
} from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import type { Issue, Priority, IssueStatus } from "../types.js";
import { isTerminalStatus, parseIssueStatus, parsePriority, VALID_ISSUE_STATUSES } from "../types.js";
import {
  getHumanOutputStyle,
  HUMAN_OUTPUT_STYLE_CHOICES,
  isLocalOnly,
  parseHumanOutputStyle,
} from "../utils/config.js";
import {
  protectDescriptionFromEscapedNewlines,
  resolveDescriptionInput,
} from "../utils/description-input.js";
import { cachePreparedDescriptionMedia, planDescriptionMediaInput } from "../utils/media-input.js";
import {
  formatRemoteSyncPauseNotice,
  getActiveRemoteSyncPause,
  getAutomaticRemoteSyncPause,
  getCommandRemoteSyncPause,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";

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

function warnOnAutoHealedEscapedNewlineDescription(autoHealed: boolean): void {
  if (!autoHealed) return;
  outputError("");
  outputError("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  outputError("WARNING: lb auto-corrected literal '\\n' sequences into real line breaks.");
  outputError("This usually means multiline text was escaped instead of entered directly.");
  outputError("Use a heredoc, --description-file, or --description-stdin for multiline content.");
  outputError(
    "If you truly need literal '\\n' stored, re-run with --no-auto-format-escaped-newlines."
  );
  outputError("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  outputError("");
}

function normalizeOptionalParentInput(parent: string | undefined): string | undefined {
  if (!parent || isPlaceholderIssueInput(parent)) {
    return undefined;
  }
  return parent;
}

function assertConcreteRelationTarget(value: string, flagName: string): void {
  if (isPlaceholderIssueInput(value)) {
    outputError(`${flagName} requires a real issue ID, not '${value}'.`);
    process.exit(1);
  }
}

function applyLocalStatusMetadata(
  issue: Issue,
  updates: {
    status?: IssueStatus;
  },
  now: string
): Issue {
  if (!updates.status) {
    return { ...issue, ...updates };
  }

  return {
    ...issue,
    ...updates,
    closed_at: isTerminalStatus(updates.status) ? now : undefined,
  };
}

async function loadCurrentDescriptionForUpdate(issueId: string): Promise<string | undefined> {
  const cached = getCachedIssue(issueId);
  if (cached) {
    return cached.description;
  }

  if (isLocalId(issueId) || getAutomaticRemoteSyncPause() || getActiveRemoteSyncPause()) {
    return undefined;
  }

  try {
    const fetched = await fetchIssue(issueId);
    return fetched?.description;
  } catch {
    return undefined;
  }
}

export const updateCommand = new Command("update")
  .description("Update an issue")
  .argument("<id>", "Issue ID")
  .option("--title <title>", "New title")
  .option("-d, --description <desc>", "New description")
  .option("--description-file <path>", "Read new description from file")
  .option("--description-stdin", "Read new description from stdin")
  .option("--media <path>", "Attach media from a local file (repeatable)", collect)
  .option("--media-id <id>", "Media id to pair with --media by position (repeatable)", collect)
  .option(
    "--no-auto-format-escaped-newlines",
    "Preserve literal \\\\n sequences instead of auto-correcting them"
  )
  .option("-s, --status <status>", "Status: open, in_progress, closed, cancelled")
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
      // Validate inputs
      let description = await resolveDescriptionInput({
        inlineDescription: options.description as string | undefined,
        descriptionFile: options.descriptionFile as string | undefined,
        descriptionStdin: !!options.descriptionStdin,
      });
      const hadExplicitDescriptionInput = description !== undefined;
      const requestedMediaPaths = options.media as string[] | undefined;
      const requestedMediaIds = options.mediaId as string[] | undefined;
      const hasRequestedMedia = (requestedMediaPaths?.length || 0) > 0;
      if (hasRequestedMedia && description === undefined) {
        description = await loadCurrentDescriptionForUpdate(resolvedId);
      }
      const escapedNewlineProtection = protectDescriptionFromEscapedNewlines(description, {
        autoFormat: options.autoFormatEscapedNewlines as boolean,
      });
      description = escapedNewlineProtection.description;
      warnOnAutoHealedEscapedNewlineDescription(escapedNewlineProtection.autoHealed);
      const preparedMedia = await planDescriptionMediaInput({
        description,
        mediaPaths: requestedMediaPaths,
        mediaIds: requestedMediaIds,
      });
      description = preparedMedia.description;
      const canonicalDescription = toCanonicalLocalDescription(description, {
        autoFormatEscapedNewlines: options.autoFormatEscapedNewlines as boolean,
      });
      const updates: {
        title?: string;
        description?: string;
        status?: IssueStatus;
        priority?: Priority;
        assigneeId?: string | null;
      } = {};

      if (options.title) updates.title = options.title;
      if (canonicalDescription !== undefined) updates.description = canonicalDescription;

      if (options.status) {
        const parsedStatus = parseIssueStatus(options.status);
        if (!parsedStatus) {
          outputError(
            `Invalid status '${options.status}'. Must be one of: ${VALID_ISSUE_STATUSES.join(", ")}`
          );
          process.exit(1);
        }
        updates.status = parsedStatus;
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

      for (const dep of allDeps) {
        assertConcreteRelationTarget(dep.targetId, `--${dep.type}`);
      }
      const normalizedParentInput = normalizeOptionalParentInput(
        options.parent as string | undefined
      );

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
        !normalizedParentInput &&
        !options.unparent
      ) {
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
        const updated = { ...applyLocalStatusMetadata(issue, updates, now), updated_at: now };
        cacheIssue(updated);
        cachePreparedDescriptionMedia(resolvedId, preparedMedia.mediaItems);

        // Handle parent
        if (normalizedParentInput) {
          cacheDependency({
            issue_id: resolvedId,
            depends_on_id: resolveIssueId(normalizedParentInput),
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
          output(
            style === "beads"
              ? formatIssueHumanBeads(updated, getDisplayId(updated.id))
              : formatIssueHuman(updated, getDisplayId(updated.id))
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
          // Sync mode: update directly in Linear
          const teamId = await getTeamId(options.team);
          let issue = null;

          if (options.assign && updates.assigneeId === undefined) {
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

          if (preparedMedia.mediaItems.length > 0) {
            cachePreparedDescriptionMedia(resolvedId, preparedMedia.mediaItems);
          }

          if (Object.keys(updates).length > 0) {
            issue = await updateIssue(resolvedId, updates, teamId, {
              autoFormatEscapedNewlines: options.autoFormatEscapedNewlines as boolean,
            });
          } else {
            issue = await fetchIssue(resolvedId);
          }

          // Handle parent
          if (normalizedParentInput) {
            try {
              const parentId = resolveIssueId(normalizedParentInput);
              if (isLocalId(parentId)) {
                outputError(`Parent not synced yet: ${normalizedParentInput}`);
              } else {
                await updateIssueParent(resolvedId, parentId);
              }
            } catch (error) {
              outputError(
                `Failed to set parent to ${normalizedParentInput}: ${error instanceof Error ? error.message : error}`
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
              output(
                style === "beads"
                  ? formatIssueHumanBeads(issue, getDisplayId(issue.id))
                  : formatIssueHuman(issue, getDisplayId(issue.id))
              );
            }
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
      if (normalizedParentInput) payload.parentId = resolveIssueId(normalizedParentInput);
      if (options.unparent) payload.parentId = null;
      // Remove assigneeId from payload - worker will resolve it
      delete payload.assigneeId;

      queueOutboxItem("update", payload, resolvedId);
      cachePreparedDescriptionMedia(resolvedId, preparedMedia.mediaItems);

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
        const updated = { ...applyLocalStatusMetadata(issue, updates, now), updated_at: now };
        cacheIssue(updated);

        if (normalizedParentInput) {
          cacheDependency({
            issue_id: resolvedId,
            depends_on_id: resolveIssueId(normalizedParentInput),
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
          output(
            style === "beads"
              ? formatIssueHumanBeads(updated, getDisplayId(updated.id))
              : formatIssueHuman(updated, getDisplayId(updated.id))
          );
        }
      } else {
        output(`Updated: ${getDisplayId(resolvedId)}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
