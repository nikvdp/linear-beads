/**
 * lb deliver - Record delivery evidence on an issue (MG-1207)
 *
 * Writes a canonical marker comment (`<!-- lb-delivered:v1 -->`) so ready
 * views can reclassify delivered-but-untransitioned beads. Idempotent:
 * an existing marker comment is reused, not duplicated.
 */

import { Command } from "commander";
import { buildDeliveredCommentBody, isDeliveredCommentBody } from "../utils/delivered.js";
import {
  createLocalIssueComment,
  getCachedIssue,
  getDisplayId,
  getIssueComments,
  queueOutboxItem,
  resolveIssueId,
} from "../utils/database.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import { isLocalOnly } from "../utils/config.js";
import { output } from "../utils/output.js";

export const deliverCommand = new Command("deliver")
  .description("Record delivery evidence on an issue (excludes it from lb ready)")
  .argument("<id>", "Issue ID")
  .option("--pr <url>", "Pull request URL that delivered the work")
  .option("--note <text>", "Optional note stored with the marker")
  .option("-j, --json", "Output as JSON")
  .action(async (id: string, options: { pr?: string; note?: string; json?: boolean }) => {
    try {
      const resolvedId = resolveIssueId(id);
      const issue = getCachedIssue(resolvedId);
      if (!issue) {
        throw new Error(`Issue not found: ${id}`);
      }

      const body = buildDeliveredCommentBody({ prUrl: options.pr, note: options.note });
      const existing = getIssueComments(resolvedId, Number.MAX_SAFE_INTEGER).find((comment) =>
        isDeliveredCommentBody(comment.body)
      );

      if (existing) {
        if (options.json) {
          output(
            JSON.stringify(
              {
                id: resolvedId,
                display_id: getDisplayId(resolvedId),
                delivered: true,
                already_recorded: true,
                comment_id: existing.id,
              },
              null,
              2
            )
          );
        } else {
          output(
            `${getDisplayId(resolvedId)} already marked delivered (${existing.id}) — no duplicate written.`
          );
        }
        return;
      }

      let commentId: string;
      if (isLocalOnly()) {
        const created = createLocalIssueComment({
          issueId: resolvedId,
          body,
          syncStatus: "synced",
        });
        commentId = created.id;
      } else {
        // Remote mode: queue like `lb comment` does — local pending comment
        // + outbox item; the worker pushes to Linear. No direct API call
        // here, so the marker can never be written twice.
        const pending = createLocalIssueComment({
          issueId: resolvedId,
          body,
          syncStatus: "pending",
        });
        queueOutboxItem("comment_create", { issueId: resolvedId, body }, resolvedId);
        ensureOutboxProcessed();
        commentId = pending.id;
      }

      if (options.json) {
        output(
          JSON.stringify(
            {
              id: resolvedId,
              display_id: getDisplayId(resolvedId),
              delivered: true,
              already_recorded: false,
              comment_id: commentId,
            },
            null,
            2
          )
        );
      } else {
        const pr = options.pr ? ` (pr=${options.pr})` : "";
        output(
          `${getDisplayId(resolvedId)} marked delivered${pr} — excluded from lb ready until status advances.`
        );
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
