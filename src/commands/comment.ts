/**
 * lb comment - Read and write issue comments
 */

import { Command } from "commander";
import type { IssueComment } from "../types.js";
import {
  createLocalIssueComment,
  findIssueCommentByBody,
  getDisplayId,
  getIssueComments,
  isLocalId,
  queueOutboxItem,
  removeMatchingCommentCreateOutbox,
  resolveIssueId,
} from "../utils/database.js";
import { addComment, fetchIssueComments } from "../utils/issue-backend.js";
import { isLocalOnly } from "../utils/config.js";
import { resolveDescriptionInput } from "../utils/description-input.js";
import { output, outputError } from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import {
  formatRemoteSyncPauseNotice,
  getCommandRemoteSyncPause,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";

type CommentWriteOptions = {
  message?: string;
  messageFile?: string;
  messageStdin?: boolean;
  sync?: boolean;
  json?: boolean;
};

type CommentListOptions = {
  json?: boolean;
  sync?: boolean;
  limit?: string;
  page?: string;
};

function isHiddenMailComment(comment: IssueComment): boolean {
  return (
    comment.body.includes("<!-- lb-mail-envelope:v1") ||
    comment.body.includes("<!-- lb-mail-directory:v1")
  );
}

function parsePositiveInteger(value: string | undefined, option: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}

function paginateComments(comments: IssueComment[], page: number, limit: number): IssueComment[] {
  const end = comments.length - (page - 1) * limit;
  return end > 0 ? comments.slice(Math.max(0, end - limit), end) : [];
}

function formatCommentLine(comment: IssueComment): string {
  const author = comment.author ? `${comment.author}: ` : "";
  const status =
    comment.sync_status && comment.sync_status !== "synced" ? ` [${comment.sync_status}]` : "";
  const body = comment.body.replace(/\s+/g, " ").trim();
  return `${comment.created_at}${status} ${author}${body}`;
}

function findMatchingComment(
  comments: IssueComment[],
  params: { body: string; parentId?: string }
): IssueComment | undefined {
  return comments.find(
    (comment) =>
      comment.body === params.body && (comment.parent_id || "") === (params.parentId || "")
  );
}

async function resolveCommentBody(
  argumentBody: string | undefined,
  options: CommentWriteOptions
): Promise<string> {
  const body = await resolveDescriptionInput({
    inlineDescription: options.message ?? argumentBody,
    descriptionFile: options.messageFile,
    descriptionStdin: options.messageStdin,
  });
  const normalized = body?.trim();
  if (!normalized) {
    throw new Error("Comment body is required.");
  }
  return normalized;
}

async function writeComment(params: {
  issueId: string;
  body: string;
  parentId?: string;
  options: CommentWriteOptions;
}): Promise<IssueComment> {
  const resolvedId = resolveIssueId(params.issueId);

  if (isLocalOnly()) {
    return createLocalIssueComment({
      issueId: resolvedId,
      parentId: params.parentId,
      body: params.body,
      syncStatus: "synced",
    });
  }

  const pending = findIssueCommentByBody({
    issueId: resolvedId,
    parentId: params.parentId,
    body: params.body,
    syncStatus: "pending",
  });
  if (pending) {
    return pending;
  }

  let useImmediateSync = Boolean(params.options.sync) && !isLocalId(resolvedId);
  const remotePause = await getCommandRemoteSyncPause();
  if (useImmediateSync && remotePause) {
    if (!params.options.json) {
      outputError(formatRemoteSyncPauseNotice(remotePause));
    }
    useImmediateSync = false;
  }

  const removedQueuedCreates = removeMatchingCommentCreateOutbox({
    issueId: resolvedId,
    parentId: params.parentId,
    body: params.body,
  });

  if (removedQueuedCreates > 0) {
    const synced = findIssueCommentByBody({
      issueId: resolvedId,
      parentId: params.parentId,
      body: params.body,
      syncStatus: "synced",
    });
    if (synced) {
      return synced;
    }

    if (useImmediateSync) {
      const remoteComments = await fetchIssueComments(resolvedId);
      const remoteMatch = findMatchingComment(remoteComments, {
        body: params.body,
        parentId: params.parentId,
      });
      if (remoteMatch) {
        return remoteMatch;
      }
    }
  }

  if (useImmediateSync) {
    try {
      return await addComment(resolvedId, params.body, params.parentId);
    } catch (error) {
      const pause = recordRemoteSyncPause(error);
      if (!pause) {
        throw error;
      }
      if (!params.options.json) {
        outputError(formatRemoteSyncPauseNotice(pause));
      }
    }
  }

  const newPending = createLocalIssueComment({
    issueId: resolvedId,
    parentId: params.parentId,
    body: params.body,
    syncStatus: "pending",
  });
  queueOutboxItem(
    "comment_create",
    {
      issueId: resolvedId,
      parentId: params.parentId,
      body: params.body,
    },
    resolvedId
  );
  ensureOutboxProcessed();
  return newPending;
}

export const commentCommand = new Command("comment")
  .description("Read and write issue comments")
  .addCommand(
    new Command("list")
      .description("List comments for an issue")
      .argument("<id>", "Issue ID")
      .option("-j, --json", "Output as JSON")
      .option("-l, --limit <count>", "Comments per page", "100")
      .option("-p, --page <number>", "Page number, newest page first", "1")
      .option("--sync", "Fetch comments from Linear before listing")
      .action(async (id: string, options: CommentListOptions) => {
        try {
          const resolvedId = resolveIssueId(id);
          const limit = parsePositiveInteger(options.limit, "--limit", 100);
          const page = parsePositiveInteger(options.page, "--page", 1);
          if (options.sync && !isLocalOnly() && !isLocalId(resolvedId)) {
            await fetchIssueComments(resolvedId);
          }
          const comments = getIssueComments(resolvedId, Number.MAX_SAFE_INTEGER).filter(
            (comment) => !isHiddenMailComment(comment)
          );
          const pageComments = paginateComments(comments, page, limit);
          if (options.json) {
            output(JSON.stringify(pageComments, null, 2));
            return;
          }
          if (comments.length === 0) {
            output(`No comments for ${getDisplayId(resolvedId)}.`);
            return;
          }
          const pageCount = Math.ceil(comments.length / limit);
          if (pageComments.length === 0) {
            output(
              `No comments for ${getDisplayId(resolvedId)} on page ${page}; ${pageCount} pages available.`
            );
            return;
          }
          const first = Math.max(1, comments.length - page * limit + 1);
          const last = comments.length - (page - 1) * limit;
          output(
            `Comments for ${getDisplayId(resolvedId)} (${first}-${last} of ${comments.length}; page ${page}/${pageCount}, newest page first):`
          );
          for (const comment of pageComments) {
            output(`- ${formatCommentLine(comment)}`);
          }
        } catch (error) {
          console.error("Error:", error instanceof Error ? error.message : error);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("add")
      .description("Add a comment to an issue")
      .argument("<id>", "Issue ID")
      .argument("[body]", "Comment body, or @file")
      .option("-m, --message <body>", "Comment body, or @file")
      .option("--message-file <path>", "Read comment body from a file")
      .option("--message-stdin", "Read comment body from stdin")
      .option("--sync", "Write directly to Linear instead of queueing")
      .option("-j, --json", "Output as JSON")
      .action(async (id: string, body: string | undefined, options: CommentWriteOptions) => {
        try {
          const comment = await writeComment({
            issueId: id,
            body: await resolveCommentBody(body, options),
            options,
          });
          if (options.json) {
            output(JSON.stringify([comment], null, 2));
          } else {
            output(`Commented on ${getDisplayId(resolveIssueId(id))}: ${comment.id}`);
          }
        } catch (error) {
          console.error("Error:", error instanceof Error ? error.message : error);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("reply")
      .description("Reply to a comment on an issue")
      .argument("<id>", "Issue ID")
      .argument("<comment-id>", "Parent comment ID")
      .argument("[body]", "Reply body, or @file")
      .option("-m, --message <body>", "Reply body, or @file")
      .option("--message-file <path>", "Read reply body from a file")
      .option("--message-stdin", "Read reply body from stdin")
      .option("--sync", "Write directly to Linear instead of queueing")
      .option("-j, --json", "Output as JSON")
      .action(
        async (
          id: string,
          parentId: string,
          body: string | undefined,
          options: CommentWriteOptions
        ) => {
          try {
            const comment = await writeComment({
              issueId: id,
              parentId,
              body: await resolveCommentBody(body, options),
              options,
            });
            if (options.json) {
              output(JSON.stringify([comment], null, 2));
            } else {
              output(`Replied on ${getDisplayId(resolveIssueId(id))}: ${comment.id}`);
            }
          } catch (error) {
            console.error("Error:", error instanceof Error ? error.message : error);
            process.exit(1);
          }
        }
      )
  );
