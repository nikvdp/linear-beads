/**
 * lb update - Update an issue
 */

import { Command } from "commander";
import {
  queueOutboxItem,
  getCachedIssue,
  getCachedTeamId,
  getCachedWorkflowStates,
  getCachedViewer,
  cacheIssue,
  cacheDependency,
  deleteDependency,
  getDisplayId,
  resolveIssueId,
  isSameCanonicalIssue,
  isLocalId,
  isPlaceholderIssueInput,
  isPlausibleIssueInput,
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
import { resolveAssignPayload } from "../utils/outbox-processor.js";
import { resolveWorkflowState, toCanonicalLocalDescription } from "../utils/linear.js";
import {
  formatIssueJson,
  formatIssueHuman,
  formatIssueHumanBeads,
  normalizeIssueDescriptionForOutput,
  output,
  outputError,
} from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import type { Issue, Priority } from "../types.js";
import {
  isTerminalStatus,
  linearStateToStatus,
  parseIssueStatus,
  parsePriority,
  VALID_ISSUE_STATUSES,
} from "../types.js";
import {
  getHumanOutputStyle,
  getOption,
  getTeamKey,
  HUMAN_OUTPUT_STYLE_CHOICES,
  isLocalOnly,
  parseHumanOutputStyle,
} from "../utils/config.js";
import {
  protectDescriptionFromEscapedNewlines,
  resolveAtFileText,
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

type ReplaceOperation = {
  needle: string;
  replacement: string;
};

type ReplaceToken = {
  kind: "replace" | "with";
  value: string;
};

const replaceTokenSequence: ReplaceToken[] = [];

function summarizeReplaceText(value: string): string {
  const compact = value.replace(/\n/g, "\\n");
  if (compact.length <= 80) {
    return compact;
  }
  return `${compact.slice(0, 77)}...`;
}

async function parseReplaceOperations(tokens: ReplaceToken[]): Promise<ReplaceOperation[]> {
  if (tokens.length === 0) {
    return [];
  }

  const operations: ReplaceOperation[] = [];
  let pendingNeedle: string | null = null;
  let replaceCount = 0;

  for (const token of tokens) {
    if (token.kind === "replace") {
      if (pendingNeedle !== null) {
        throw new Error("--replace must be followed by --with before another --replace");
      }
      pendingNeedle = await resolveAtFileText(token.value);
      replaceCount += 1;
      if (pendingNeedle.length === 0) {
        throw new Error(`--replace needle ${replaceCount} must not be empty`);
      }
      continue;
    }

    if (pendingNeedle === null) {
      throw new Error("--with requires a preceding --replace");
    }

    const replacement = await resolveAtFileText(token.value);
    operations.push({ needle: pendingNeedle, replacement });
    pendingNeedle = null;
  }

  if (pendingNeedle !== null) {
    throw new Error("--replace must be followed by --with");
  }

  return operations;
}

function countLiteralMatches(haystack: string, needle: string): number {
  let count = 0;
  let startIndex = 0;
  while (startIndex <= haystack.length) {
    const nextIndex = haystack.indexOf(needle, startIndex);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    startIndex = nextIndex + needle.length;
  }
  return count;
}

function applyReplaceOperations(description: string, operations: ReplaceOperation[]): string {
  let nextDescription = description;

  for (const operation of operations) {
    const matchCount = countLiteralMatches(nextDescription, operation.needle);
    const summarizedNeedle = summarizeReplaceText(operation.needle);
    if (matchCount === 0) {
      throw new Error(`--replace needle matched 0 times: "${summarizedNeedle}"`);
    }
    if (matchCount > 1) {
      throw new Error(
        `--replace needle matched ${matchCount} times; it must match exactly once: "${summarizedNeedle}"`
      );
    }
    nextDescription = nextDescription.replace(operation.needle, operation.replacement);
  }

  return nextDescription;
}

function warnOnAutoHealedEscapedNewlineDescription(autoHealed: boolean): void {
  if (!autoHealed) return;
  outputError("");
  outputError("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  outputError("WARNING: lb auto-corrected literal '\\n' sequences into real line breaks.");
  outputError("This usually means multiline text was escaped instead of entered directly.");
  outputError(
    "Prefer a temp file plus -d @file, or use --description-file / --description-stdin for multiline content."
  );
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
  if (!isPlausibleIssueInput(parent)) {
    outputError(`--parent must be a plausible issue ID, not '${parent}'.`);
    process.exit(1);
  }
  return parent;
}

function assertConcreteRelationTarget(value: string, flagName: string): void {
  if (isPlaceholderIssueInput(value)) {
    outputError(`${flagName} requires a real issue ID, not '${value}'.`);
    process.exit(1);
  }
  if (!isPlausibleIssueInput(value)) {
    outputError(`${flagName} must be a plausible issue ID, not '${value}'.`);
    process.exit(1);
  }
}

function assertNotSelfReferentialRelation(
  issueId: string,
  targetId: string,
  relationDescription: string
): void {
  if (!isSameCanonicalIssue(issueId, targetId)) {
    return;
  }
  outputError(
    `Skipped invalid relation: ${getDisplayId(issueId)} cannot ${relationDescription} itself.`
  );
  process.exit(1);
}

function applyLocalStatusMetadata(
  issue: Issue,
  updates: {
    status?: string;
    assigneeId?: string | null;
  },
  now: string,
  workflowState?: { name: string; type: string }
): Issue {
  const { status: statusInput, assigneeId: _assigneeId, ...fields } = updates;
  const status = statusInput
    ? (parseIssueStatus(statusInput) ??
      (workflowState ? linearStateToStatus(workflowState.type) : null))
    : null;
  if (!status) {
    return { ...issue, ...fields };
  }

  return {
    ...issue,
    ...fields,
    status,
    linear_state_name: workflowState?.name,
    closed_at: isTerminalStatus(status) ? now : undefined,
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
  .option("-d, --description <desc>", "New description; prefix with @ to read from file")
  .option("--description-file <path>", "Read new description from file")
  .option("--description-stdin", "Read new description from stdin")
  .option(
    "--replace <needle>",
    "Exact body text to replace; prefix with @ to read the needle from a file"
  )
  .option(
    "--with <replacement>",
    "Replacement text for the preceding --replace; prefix with @ to read it from a file"
  )
  .option("--media <path>", "Attach media from a local file (repeatable)", collect)
  .option("--media-id <id>", "Media id to pair with --media by position (repeatable)", collect)
  .option(
    "--no-auto-format-escaped-newlines",
    "Preserve literal \\\\n sequences instead of auto-correcting them"
  )
  .option(
    "-s, --status <status>",
    "Status: canonical (backlog, open, in_progress, closed, cancelled) or custom workflow state name"
  )
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
  .on("option:replace", (value: string) => {
    replaceTokenSequence.push({ kind: "replace", value });
  })
  .on("option:with", (value: string) => {
    replaceTokenSequence.push({ kind: "with", value });
  })
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
      const replaceOperations = await parseReplaceOperations(replaceTokenSequence);
      // Validate inputs
      let description = await resolveDescriptionInput({
        inlineDescription: options.description as string | undefined,
        descriptionFile: options.descriptionFile as string | undefined,
        descriptionStdin: !!options.descriptionStdin,
      });
      if (replaceOperations.length > 0 && description !== undefined) {
        throw new Error(
          "Description input conflict: choose either --replace/--with or one of --description, --description-file, or --description-stdin"
        );
      }
      if (replaceOperations.length > 0) {
        const currentDescription = await loadCurrentDescriptionForUpdate(resolvedId);
        const editableBody =
          normalizeIssueDescriptionForOutput(currentDescription, resolvedId) ?? "";
        description = applyReplaceOperations(editableBody, replaceOperations);
      }
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
        status?: string;
        priority?: Priority;
        assigneeId?: string | null;
      } = {};
      let workflowState: { name: string; type: string } | undefined;

      if (options.title) updates.title = options.title;
      if (canonicalDescription !== undefined) updates.description = canonicalDescription;
      if (options.status) {
        const canonicalStatus = parseIssueStatus(options.status);
        if (canonicalStatus) {
          updates.status = canonicalStatus;
        } else if (isLocalOnly()) {
          throw new Error(
            `Invalid status '${options.status}'. Must be one of: ${VALID_ISSUE_STATUSES.join(", ")}`
          );
        } else {
          const requestedStatus = String(options.status).trim();
          updates.status = requestedStatus;
          let teamId =
            getCachedTeamId(options.team || getTeamKey() || "") ||
            (!options.team ? getOption("team_id") : undefined);
          workflowState = teamId
            ? getCachedWorkflowStates(teamId).find(
                (state) => state.name.trim().toLowerCase() === requestedStatus.toLowerCase()
              )
            : undefined;
          if (!workflowState && !getAutomaticRemoteSyncPause() && !getActiveRemoteSyncPause()) {
            try {
              teamId ||= await getTeamId(options.team);
              const stateId = await resolveWorkflowState(teamId, updates.status);
              workflowState = getCachedWorkflowStates(teamId).find((state) => state.id === stateId);
            } catch (error) {
              if (!recordRemoteSyncPause(error)) throw error;
            }
          }
        }
      }

      if (options.priority !== undefined) {
        const { priority, error: priorityError } = parsePriority(options.priority);
        if (priorityError || priority === undefined) {
          outputError(priorityError || "Invalid priority");
          process.exit(1);
        }
        updates.priority = priority;
      }

      if (options.unassign) {
        updates.assigneeId = null;
      }

      const requestedAssignee = options.assign as string | undefined;
      const localAssigneeEmail =
        requestedAssignee === "me" ? getCachedViewer()?.email : requestedAssignee;

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
      const resolvedParent = normalizedParentInput
        ? resolveIssueId(normalizedParentInput)
        : undefined;

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
        !requestedAssignee &&
        allDeps.length === 0 &&
        !normalizedParentInput &&
        !options.unparent
      ) {
        outputError("No updates specified");
        process.exit(1);
      }

      if (resolvedParent) {
        assertNotSelfReferentialRelation(resolvedId, resolvedParent, "be its own parent");
      }
      for (const dep of resolvedDeps) {
        const relationDescription =
          dep.type === "blocked-by"
            ? "be blocked by"
            : dep.type === "blocks"
              ? "block"
              : "be related to";
        assertNotSelfReferentialRelation(resolvedId, dep.targetId, relationDescription);
      }

      // Local-only mode: update cache directly
      if (isLocalOnly()) {
        const issue = getCachedIssue(resolvedId);
        if (!issue) {
          outputError(`Issue not found: ${id}`);
          process.exit(1);
        }
        if (requestedAssignee === "me" && !localAssigneeEmail && !options.unassign) {
          throw new Error("Cannot assign to 'me' in local-only mode without a cached viewer");
        }

        const now = new Date().toISOString();
        const updated = {
          ...applyLocalStatusMetadata(issue, updates, now, workflowState),
          updated_at: now,
        };
        if (options.unassign) delete updated.assignee;
        else if (localAssigneeEmail) updated.assignee = localAssigneeEmail;
        cacheIssue(updated);

        // Handle parent
        if (normalizedParentInput) {
          cacheDependency({
            issue_id: resolvedId,
            depends_on_id: resolvedParent!,
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
              const parentId = resolvedParent!;
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
      if (resolvedParent) payload.parentId = resolvedParent;
      if (options.unparent) payload.parentId = null;
      // Remove assigneeId from payload - worker will resolve it
      delete payload.assigneeId;

      // Best-effort: canonicalize bare agent handles to emails at queue time so
      // push-time resolution has less work. Offline, rewrite with the cached
      // viewer's domain; push-time resolve-or-drop still validates the user.
      if (
        typeof payload.assign === "string" &&
        payload.assign !== "me" &&
        !payload.assign.includes("@")
      ) {
        try {
          const resolvedAssign = await resolveAssignPayload(payload.assign);
          if (resolvedAssign?.email) {
            payload.assign = resolvedAssign.email;
          }
        } catch {
          const cachedViewer = getCachedViewer();
          const at = cachedViewer ? cachedViewer.email.lastIndexOf("@") : -1;
          if (cachedViewer && at > 0) {
            payload.assign = `${payload.assign}@${cachedViewer.email.slice(at + 1)}`;
          }
        }
      }

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
        const updated = {
          ...applyLocalStatusMetadata(issue, updates, now, workflowState),
          updated_at: now,
        };
        cacheIssue(updated);

        if (normalizedParentInput) {
          cacheDependency({
            issue_id: resolvedId,
            depends_on_id: resolvedParent!,
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
            (style === "beads"
              ? formatIssueHumanBeads(updated, getDisplayId(updated.id))
              : formatIssueHuman(updated, getDisplayId(updated.id))) +
              (requestedAssignee || options.unassign
                ? "\n  Assignment change queued; current assignee shown until sync."
                : "")
          );
        }
      } else {
        output(`Updated: ${getDisplayId(resolvedId)}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      replaceTokenSequence.length = 0;
    }
  });
