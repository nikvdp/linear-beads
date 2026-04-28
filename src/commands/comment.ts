/**
 * lb comment - Read and write issue comments
 */

import { Command } from "commander";
import type { IssueComment } from "../types.js";
import {
  createLocalIssueComment,
  getDisplayId,
  getIssueComments,
  isLocalId,
  queueOutboxItem,
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

function isHiddenMailComment(comment: IssueComment): boolean {
  return (
    comment.body.includes("<!-- lb-mail-envelope:v1") ||
    comment.body.includes("<!-- lb-mail-directory:v1")
  );
}

function visibleComments(issueId: string): IssueComment[] {
  return getIssueComments(issueId).filter((comment) => !isHiddenMailComment(comment));
}

function formatCommentLine(comment: IssueComment): string {
  const author = comment.author ? `${comment.author}: ` : "";
  const status =
    comment.sync_status && comment.sync_status !== "synced" ? ` [${comment.sync_status}]` : "";
  const body = comment.body.replace(/\s+/g, " ").trim();
  return `${comment.created_at}${status} ${author}${body}`;
}

function formatCommentJson(comment: IssueComment): IssueComment {
  return comment;
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

  let useImmediateSync = Boolean(params.options.sync) && !isLocalId(resolvedId);
  const remotePause = await getCommandRemoteSyncPause();
  if (useImmediateSync && remotePause) {
    if (!params.options.json) {
      outputError(formatRemoteSyncPauseNotice(remotePause));
    }
    useImmediateSync = false;
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

  const pending = createLocalIssueComment({
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
  return pending;
}

export const commentCommand = new Command("comment")
  .description("Read and write issue comments")
  .addCommand(
    new Command("list")
      .description("List comments for an issue")
      .argument("<id>", "Issue ID")
      .option("-j, --json", "Output as JSON")
      .option("--sync", "Fetch comments from Linear before listing")
      .action(async (id: string, options) => {
        try {
          const resolvedId = resolveIssueId(id);
          if (options.sync && !isLocalOnly() && !isLocalId(resolvedId)) {
            await fetchIssueComments(resolvedId);
          }
          const comments = visibleComments(resolvedId);
          if (options.json) {
            output(JSON.stringify(comments.map(formatCommentJson), null, 2));
            return;
          }
          if (comments.length === 0) {
            output(`No comments for ${getDisplayId(resolvedId)}.`);
            return;
          }
          output(`Comments for ${getDisplayId(resolvedId)} (${comments.length}):`);
          for (const comment of comments) {
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
            output(JSON.stringify([formatCommentJson(comment)], null, 2));
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
              output(JSON.stringify([formatCommentJson(comment)], null, 2));
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
