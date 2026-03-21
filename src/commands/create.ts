/**
 * lb create - Create a new issue
 */

import { Command } from "commander";
import {
  queueOutboxItem,
  deleteMediaItems,
  generateLocalId,
  cacheIssue,
  cacheDependency,
  getDatabase,
  getCachedIssue,
  getCachedIssues,
  getDisplayId,
  reassignMediaItemsToIssue,
  resolveIssueId,
  isLocalId,
  isPlaceholderIssueInput,
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
import {
  formatIssueJson,
  formatIssueHuman,
  formatIssueHumanBeads,
  output,
  outputError,
} from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import type { Issue, IssueType } from "../types.js";
import { isActionableStatus, parsePriority, VALID_ISSUE_TYPES } from "../types.js";
import {
  getHumanOutputStyle,
  HUMAN_OUTPUT_STYLE_CHOICES,
  isLocalOnly,
  parseHumanOutputStyle,
  useTypes,
} from "../utils/config.js";
import { chooseReuseIssue, findDuplicateMatches } from "../utils/duplicate-detection.js";
import {
  protectDescriptionFromEscapedNewlines,
  resolveDescriptionInput,
} from "../utils/description-input.js";
import { cachePreparedDescriptionMedia, planDescriptionMediaInput } from "../utils/media-input.js";
import {
  getActiveRemoteSyncPauseForEndpoints,
  getAutomaticRemoteSyncPauseForEndpoints,
  getBlockingActiveRemoteSyncPause,
  getBlockingAutomaticRemoteSyncPause,
  formatRemoteSyncPauseNotice,
  getCommandRemoteSyncPause,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";

const VALID_DEP_TYPES = ["blocks", "related", "discovered-from"];
const CREATE_WAIT_ENDPOINTS = ["issueCreate"];
const CREATE_WAIT_DEFAULT_TIMEOUT_MS = 20000;
const CREATE_WAIT_POLL_MS = 100;
const CREATE_WAIT_KICK_INTERVAL_MS = 1000;

type WaitForCreateResolutionResult =
  | { status: "resolved"; issue: Issue }
  | { status: "paused"; issue: Issue | null; pauseNotice: string }
  | { status: "timeout"; issue: Issue | null }
  | { status: "missing" };

type CreateWaitFailurePayload = {
  error: "wait_unavailable" | "wait_paused" | "wait_timeout" | "wait_missing";
  message: string;
  local_id?: string;
  timeout_ms?: number;
  pause_notice?: string;
  issue?: Issue | null;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getCreateWaitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.LB_CREATE_WAIT_TIMEOUT_MS, CREATE_WAIT_DEFAULT_TIMEOUT_MS);
}

function resolveCreateWaitTimeoutMs(optionValue: string | undefined): number {
  if (!optionValue) {
    return getCreateWaitTimeoutMs();
  }

  const parsed = Number.parseInt(optionValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    outputError("--wait-timeout-ms must be a positive integer.");
    process.exit(1);
  }

  return parsed;
}

function getCreateWaitPauseNotice(): string | null {
  const pause =
    getActiveRemoteSyncPauseForEndpoints(CREATE_WAIT_ENDPOINTS) ||
    getAutomaticRemoteSyncPauseForEndpoints(CREATE_WAIT_ENDPOINTS) ||
    getBlockingActiveRemoteSyncPause() ||
    getBlockingAutomaticRemoteSyncPause();
  return pause ? formatRemoteSyncPauseNotice(pause) : null;
}

export async function waitForCreateResolution(
  localId: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    kickWorker?: () => void;
  } = {}
): Promise<WaitForCreateResolutionResult> {
  const timeoutMs = options.timeoutMs ?? getCreateWaitTimeoutMs();
  const pollMs = options.pollMs ?? CREATE_WAIT_POLL_MS;
  const kickWorker = options.kickWorker ?? ensureOutboxProcessed;
  const deadline = Date.now() + timeoutMs;
  let nextKickAt = 0;

  while (Date.now() <= deadline) {
    const issue = getCachedIssue(localId);
    if (!issue) {
      return { status: "missing" };
    }
    if (issue.linear_identifier) {
      return { status: "resolved", issue };
    }

    const pauseNotice = getCreateWaitPauseNotice();
    if (pauseNotice) {
      return { status: "paused", issue, pauseNotice };
    }

    if (Date.now() >= nextKickAt) {
      kickWorker();
      nextKickAt = Date.now() + CREATE_WAIT_KICK_INTERVAL_MS;
    }

    await Bun.sleep(pollMs);
  }

  return { status: "timeout", issue: getCachedIssue(localId) };
}

function emitJsonCreateWaitFailure(payload: CreateWaitFailurePayload): never {
  outputError(JSON.stringify(payload, null, 2));
  process.exit(1);
}

function emitCreateWaitFailure(
  result: WaitForCreateResolutionResult,
  localId: string,
  options: { json?: boolean; timeoutMs: number }
): never {
  if (result.status === "paused") {
    if (options.json) {
      emitJsonCreateWaitFailure({
        error: "wait_paused",
        message: `Waiting for a remote issue ID stopped. The issue is still queued locally as ${localId}.`,
        local_id: localId,
        pause_notice: result.pauseNotice,
        issue: result.issue,
      });
    }
    outputError(result.pauseNotice);
    outputError(`Waiting for a remote issue ID stopped. The issue is still queued locally as ${localId}.`);
  } else if (result.status === "timeout") {
    if (options.json) {
      emitJsonCreateWaitFailure({
        error: "wait_timeout",
        message: `Timed out waiting for a remote issue ID. The issue is still queued locally as ${localId}.`,
        local_id: localId,
        timeout_ms: options.timeoutMs,
        issue: result.issue,
      });
    }
    outputError(
      `Timed out waiting for a remote issue ID. The issue is still queued locally as ${localId}.`
    );
  } else {
    if (options.json) {
      emitJsonCreateWaitFailure({
        error: "wait_missing",
        message: `Created issue ${localId}, but it disappeared from the local cache while waiting.`,
        local_id: localId,
        timeout_ms: options.timeoutMs,
      });
    }
    outputError(`Created issue ${localId}, but it disappeared from the local cache while waiting.`);
  }
  process.exit(1);
}

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

function normalizeOptionalParentInput(parent: string | undefined): string | undefined {
  if (!parent || isPlaceholderIssueInput(parent)) {
    return undefined;
  }
  return parent;
}

function assertConcreteRelationTarget(value: string, flagName: string): void {
  if (isPlaceholderIssueInput(value)) {
    console.error(`${flagName} requires a real issue ID, not '${value}'.`);
    process.exit(1);
  }
}

function reasonLabel(reason: string): string {
  if (reason === "exact_title") return "exact title";
  if (reason === "normalized_title") return "normalized title";
  return "description hash";
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

export const createCommand = new Command("create")
  .description("Create a new issue")
  .argument("<title>", "Issue title")
  .option("-d, --description <desc>", "Issue description")
  .option("--description-file <path>", "Read issue description from file")
  .option("--description-stdin", "Read issue description from stdin")
  .option("--media <path>", "Attach media from a local file (repeatable)", collect)
  .option("--media-id <id>", "Media id to pair with --media by position (repeatable)", collect)
  .option(
    "--no-auto-format-escaped-newlines",
    "Preserve literal \\\\n sequences instead of auto-correcting them"
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
  .option("--wait", "Wait for a resolved remote issue ID after queueing locally")
  .option("--wait-timeout-ms <ms>", "Maximum time to wait for remote ID resolution")
  .option("--style <style>", `Human output style: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`)
  .option("--team <team>", "Team key (overrides config)")
  .action(async (title: string, options) => {
    try {
      const waitTimeoutMs = resolveCreateWaitTimeoutMs(options.waitTimeoutMs as string | undefined);
      const requestedStyle = options.style ? parseHumanOutputStyle(options.style) : undefined;
      if (options.style && !requestedStyle) {
        console.error(
          `Invalid style '${options.style}'. Must be one of: ${HUMAN_OUTPUT_STYLE_CHOICES.join(", ")}`
        );
        process.exit(1);
      }
      const style = getHumanOutputStyle(requestedStyle);

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
      const escapedNewlineProtection = protectDescriptionFromEscapedNewlines(description, {
        autoFormat: options.autoFormatEscapedNewlines as boolean,
      });
      description = escapedNewlineProtection.description;
      warnOnAutoHealedEscapedNewlineDescription(escapedNewlineProtection.autoHealed);
      const preparedMedia = await planDescriptionMediaInput({
        description,
        mediaPaths: options.media as string[] | undefined,
        mediaIds: options.mediaId as string[] | undefined,
      });
      description = preparedMedia.description;
      const canonicalDescription = toCanonicalLocalDescription(description, {
        autoFormatEscapedNewlines: options.autoFormatEscapedNewlines as boolean,
      });

      const duplicateCandidates = getCachedIssues().filter(
        (issue) => isActionableStatus(issue.status) || issue.status === "backlog"
      );
      const duplicateMatches = findDuplicateMatches(duplicateCandidates, title, description);

      if (duplicateMatches.length > 0) {
        if (options.reuseIfDuplicate) {
          const reused = chooseReuseIssue(duplicateMatches);
          if (options.json) {
            output(formatIssueJson(reused));
          } else {
            output(
              style === "beads"
                ? formatIssueHumanBeads(reused, getDisplayId(reused.id))
                : `Reused existing issue: ${getDisplayId(reused.id)}: ${reused.title}`
            );
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
      const resolvedParent = normalizedParentInput
        ? resolveIssueId(normalizedParentInput)
        : undefined;

      // Local-only mode: create locally without Linear
      if (isLocalOnly()) {
        if (options.wait) {
          if (options.json) {
            emitJsonCreateWaitFailure({
              error: "wait_unavailable",
              message: "--wait requires remote sync and is unavailable in local-only mode.",
              timeout_ms: waitTimeoutMs,
            });
          }
          outputError("--wait requires remote sync and is unavailable in local-only mode.");
          process.exit(1);
        }
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
        cachePreparedDescriptionMedia(localId, preparedMedia.mediaItems);

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
          output(
            style === "beads"
              ? formatIssueHumanBeads(issue, localId)
              : `Created: ${localId}: ${title}`
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
        const syncKey = generateIssueSyncKey();
        const stagedMediaOwnerId = `MEDIA-STAGING-${generateIssueSyncKey()}`;
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
        try {
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

          if (preparedMedia.mediaItems.length > 0) {
            cachePreparedDescriptionMedia(stagedMediaOwnerId, preparedMedia.mediaItems);
          }

          let issue;
          try {
            issue = await createIssue({
              title,
              description: canonicalDescription,
              priority,
              issueType, // undefined if types disabled
              teamId,
              parentId: resolvedParent,
              assigneeId,
              syncKey,
              autoFormatEscapedNewlines: options.autoFormatEscapedNewlines as boolean,
            });
          } catch (error) {
            deleteMediaItems(preparedMedia.mediaItems.map((item) => item.id));
            throw error;
          }

          if (preparedMedia.mediaItems.length > 0) {
            reassignMediaItemsToIssue(stagedMediaOwnerId, issue.local_id || issue.id);
          }

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
            output(
              style === "beads"
                ? formatIssueHumanBeads(issue, getDisplayId(issue.id))
                : formatIssueHuman(issue, getDisplayId(issue.id))
            );
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
        cachePreparedDescriptionMedia(localId, preparedMedia.mediaItems);

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

      if (options.wait) {
        const result = await waitForCreateResolution(localId, { timeoutMs: waitTimeoutMs });
        if (result.status !== "resolved") {
          emitCreateWaitFailure(result, localId, {
            json: options.json,
            timeoutMs: waitTimeoutMs,
          });
        }

        if (options.json) {
          output(formatIssueJson(result.issue));
        } else {
          output(
            style === "beads"
              ? formatIssueHumanBeads(result.issue, getDisplayId(result.issue.id))
              : formatIssueHuman(result.issue, getDisplayId(result.issue.id))
          );
        }
        return;
      }

      if (options.json) {
        output(formatIssueJson(issue));
      } else {
        output(
          style === "beads"
            ? formatIssueHumanBeads(issue, localId)
            : `Created: ${localId}: ${title} (syncing...)`
        );
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
