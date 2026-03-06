/**
 * lb create - Create a new issue
 */

import { Command } from "commander";
import {
  queueOutboxItem,
  generateLocalId,
  cacheIssue,
  cacheDependency,
  getDatabase,
  getCachedIssues,
  getDisplayId,
  resolveIssueId,
  isLocalId,
  runWithBusyRetry,
  generateIssueSyncKey,
} from "../utils/database.js";
import {
  createIssue,
  getTeamId,
  getViewer,
  getUserByEmail,
  createRelation,
} from "../utils/issue-backend.js";
import { toCanonicalLocalDescription } from "../utils/linear.js";
import { formatIssueJson, formatIssueHuman, output, outputError } from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import type { Issue, IssueType } from "../types.js";
import { parsePriority, VALID_ISSUE_TYPES } from "../types.js";
import { useTypes, isLocalOnly } from "../utils/config.js";
import { chooseReuseIssue, findDuplicateMatches } from "../utils/duplicate-detection.js";
import {
  looksLikeEscapedNewlineMistake,
  resolveDescriptionInput,
  rewriteEscapedNewlines,
} from "../utils/description-input.js";

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

function reasonLabel(reason: string): string {
  if (reason === "exact_title") return "exact title";
  if (reason === "normalized_title") return "normalized title";
  return "description hash";
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

export const createCommand = new Command("create")
  .description("Create a new issue")
  .argument("<title>", "Issue title")
  .option("-d, --description <desc>", "Issue description")
  .option("--description-file <path>", "Read issue description from file")
  .option("--description-stdin", "Read issue description from stdin")
  .option(
    "--auto-format-escaped-newlines",
    "Rewrite literal \\\\n sequences in description content into real line breaks"
  )
  .option("-t, --type <type>", "Type: bug, feature, task, epic, chore (requires use_types config)")
  .option("-p, --priority <priority>", "Priority: urgent, high, medium, low, backlog (or 0-4)", "2")
  .option("--parent <id>", "Parent issue ID (makes this a subtask)")
  .option("--blocks <id>", "This issue blocks ID (repeatable)", collect)
  .option("--blocked-by <id>", "This issue is blocked by ID (repeatable)", collect)
  .option("--related <id>", "Related issue ID (repeatable)", collect)
  .option("--discovered-from <id>", "Found while working on ID (repeatable)", collect)
  .option("--assign <email>", "Assign to user (email or 'me')")
  .option("--unassign", "Leave unassigned (skip auto-assign)")
  .option("--allow-duplicate", "Allow creating an issue even when duplicate matches are found")
  .option("--reuse-if-duplicate", "Return a matching issue instead of creating a duplicate")
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
      let description = await resolveDescriptionInput({
        inlineDescription: options.description as string | undefined,
        descriptionFile: options.descriptionFile as string | undefined,
        descriptionStdin: !!options.descriptionStdin,
      });
      if (options.autoFormatEscapedNewlines) {
        description = rewriteEscapedNewlines(description);
      }
      warnOnLikelyEscapedNewlineDescription(description);
      const canonicalDescription = toCanonicalLocalDescription(description);

      const duplicateCandidates = getCachedIssues().filter(
        (issue) => issue.status === "open" || issue.status === "in_progress"
      );
      const duplicateMatches = findDuplicateMatches(duplicateCandidates, title, description);

      if (duplicateMatches.length > 0) {
        if (options.reuseIfDuplicate) {
          const reused = chooseReuseIssue(duplicateMatches);
          if (options.json) {
            output(formatIssueJson(reused));
          } else {
            output(`Reused existing issue: ${getDisplayId(reused.id)}: ${reused.title}`);
          }
          return;
        }

        if (!options.allowDuplicate) {
          const details = duplicateMatches
            .map((match) => {
              const reasons = match.reasons.map((reason) => reasonLabel(reason)).join(", ");
              return `- ${getDisplayId(match.issue.id)} [${match.issue.status}] ${match.issue.title} (${reasons})`;
            })
            .join("\n");

          const guidance =
            "Re-run with --allow-duplicate to create anyway, or --reuse-if-duplicate to reuse one.";
          if (options.json) {
            outputError(
              JSON.stringify(
                {
                  error: "duplicate_detected",
                  message: guidance,
                  matches: duplicateMatches.map((match) => ({
                    id: getDisplayId(match.issue.id),
                    title: match.issue.title,
                    status: match.issue.status,
                    reasons: match.reasons,
                  })),
                },
                null,
                2
              )
            );
          } else {
            outputError("Potential duplicate issue(s) found:");
            outputError(details);
            outputError(guidance);
          }
          process.exit(1);
        }
      }

      // Handle issue type - only if types are enabled or explicitly provided
      let issueType: IssueType | undefined;
      if (options.type) {
        if (!VALID_ISSUE_TYPES.includes(options.type)) {
          console.error(
            `Invalid type '${options.type}'. Must be one of: ${VALID_ISSUE_TYPES.join(", ")}`
          );
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

      const resolvedDeps = allDeps.map((dep) => ({
        ...dep,
        targetId: resolveIssueId(dep.targetId),
      }));
      const resolvedParent = options.parent ? resolveIssueId(options.parent) : undefined;

      // Local-only mode: create locally without Linear
      if (isLocalOnly()) {
        const localId = generateLocalId();
        const syncKey = generateIssueSyncKey();
        const now = new Date().toISOString();

        const issue: Issue = {
          id: localId,
          title,
          description: canonicalDescription,
          status: "open",
          priority,
          issue_type: issueType,
          created_at: now,
          updated_at: now,
        };

        cacheIssue({ ...issue, sync_key: syncKey });

        // Handle parent relationship
        if (resolvedParent) {
          cacheDependency({
            issue_id: localId,
            depends_on_id: resolvedParent,
            type: "parent-child",
            created_at: now,
            created_by: "local",
          });
        }

        // Handle deps
        for (const dep of resolvedDeps) {
          if (dep.type === "blocked-by") {
            cacheDependency({
              issue_id: dep.targetId,
              depends_on_id: localId,
              type: "blocks",
              created_at: now,
              created_by: "local",
            });
          } else {
            const depType = dep.type === "blocks" ? "blocks" : "related";
            cacheDependency({
              issue_id: localId,
              depends_on_id: dep.targetId,
              type: depType as "blocks" | "related",
              created_at: now,
              created_by: "local",
            });
          }
        }

        if (options.json) {
          output(formatIssueJson(issue));
        } else {
          output(`Created: ${localId}: ${title}`);
        }
        return;
      }

      if (options.sync) {
        const syncKey = generateIssueSyncKey();
        if (resolvedParent && isLocalId(resolvedParent)) {
          console.error(`Parent not synced yet: ${options.parent}`);
          process.exit(1);
        }
        for (const dep of resolvedDeps) {
          if (isLocalId(dep.targetId)) {
            console.error(`Target not synced yet: ${dep.targetId}`);
            process.exit(1);
          }
        }
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
          description: canonicalDescription,
          priority,
          issueType, // undefined if types disabled
          teamId,
          parentId: resolvedParent,
          assigneeId,
          syncKey,
        });

        // Handle deps after issue creation
        if (resolvedDeps.length > 0) {
          const createdIssueRef = issue.linear_id || issue.id;
          for (const dep of resolvedDeps) {
            try {
              if (dep.type === "blocked-by") {
                // blocked-by is inverse: target blocks this issue
                await createRelation(dep.targetId, createdIssueRef, "blocks");
              } else {
                // Map dep types to Linear relation types
                const relationType = dep.type === "blocks" ? "blocks" : "related";
                await createRelation(createdIssueRef, dep.targetId, relationType);
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
          output(formatIssueHuman(issue, getDisplayId(issue.id)));
        }
      } else {
        // Queue mode: add to outbox and spawn background worker
        // For queue mode, we pass the assign/unassign flags
        // The worker will resolve them when processing

        const localId = generateLocalId();
        const syncKey = generateIssueSyncKey();
        const now = new Date().toISOString();

        const issue: Issue = {
          id: localId,
          title,
          description: canonicalDescription,
          status: "open",
          priority,
          issue_type: issueType,
          sync_status: "pending",
          created_at: now,
          updated_at: now,
        };

        // Convert allDeps to string format for queue
        const depsString = resolvedDeps.map((d) => `${d.type}:${d.targetId}`).join(",");

        const payload: Record<string, unknown> = {
          title,
          description: canonicalDescription,
          priority,
          parentId: resolvedParent,
          assign: options.assign,
          unassign: options.unassign || false,
          deps: depsString || undefined,
          syncKey,
        };
        if (issueType) {
          payload.issueType = issueType;
        }

        const db = getDatabase();
        const transaction = db.transaction(() => {
          cacheIssue({ ...issue, sync_key: syncKey });

          if (resolvedParent) {
            cacheDependency({
              issue_id: localId,
              depends_on_id: resolvedParent,
              type: "parent-child",
              created_at: now,
              created_by: "local",
            });
          }

          for (const dep of resolvedDeps) {
            if (dep.type === "blocked-by") {
              cacheDependency({
                issue_id: dep.targetId,
                depends_on_id: localId,
                type: "blocks",
                created_at: now,
                created_by: "local",
              });
            } else {
              const depType = dep.type === "blocks" ? "blocks" : "related";
              cacheDependency({
                issue_id: localId,
                depends_on_id: dep.targetId,
                type: depType as "blocks" | "related",
                created_at: now,
                created_by: "local",
              });
            }
          }

          queueOutboxItem("create", payload, localId);
        });
        runWithBusyRetry(() => {
          transaction();
        });

        // Spawn background worker if not already running
        ensureOutboxProcessed();

        if (options.json) {
          output(formatIssueJson(issue));
        } else {
          output(`Created: ${localId}: ${title} (syncing...)`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
