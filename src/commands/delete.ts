/**
 * lb delete - Delete an issue permanently
 */

import { Command } from "commander";
import { deleteIssue } from "../utils/issue-backend.js";
import {
  deleteCachedIssue,
  getCachedIssue,
  queueOutboxItem,
  getDisplayId,
  resolveIssueId,
  isLocalId,
} from "../utils/database.js";
import { output, outputError } from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";
import { isLocalOnly } from "../utils/config.js";
import {
  formatRemoteSyncPauseNotice,
  getActiveRemoteSyncPause,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";

export const deleteCommand = new Command("delete")
  .description("Delete an issue permanently")
  .argument("<id>", "Issue ID")
  .option("-f, --force", "Skip confirmation")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Delete immediately (block on network)")
  .action(async (id: string, options) => {
    try {
      const resolvedId = resolveIssueId(id);
      // Get issue info first for display
      const issue = getCachedIssue(resolvedId);
      const title = issue?.title || id;

      if (!options.force) {
        // Show what will be deleted
        output(`Will delete: ${getDisplayId(id)}: ${title}`);
        output(`This is permanent and cannot be undone.`);
        output(`Run with --force to confirm.`);
        process.exit(0);
      }

      // Local-only mode: just delete from cache
      if (isLocalOnly()) {
        deleteCachedIssue(resolvedId);
        if (options.json) {
          output(JSON.stringify({ deleted: resolvedId, title }));
        } else {
          output(`Deleted: ${getDisplayId(resolvedId)}: ${title}`);
        }
        return;
      }

      let useImmediateSync = Boolean(options.sync);
      const remotePause = getActiveRemoteSyncPause();
      if (useImmediateSync && remotePause) {
        outputError(formatRemoteSyncPauseNotice(remotePause));
        useImmediateSync = false;
      }

      if (useImmediateSync) {
        // Sync mode: delete directly from Linear
        if (isLocalId(resolvedId)) {
          outputError(`Issue not synced yet: ${id}`);
          process.exit(1);
        }
        try {
          await deleteIssue(resolvedId);
          deleteCachedIssue(resolvedId);

          if (options.json) {
            output(JSON.stringify({ deleted: resolvedId, title }));
          } else {
            output(`Deleted: ${getDisplayId(resolvedId)}: ${title}`);
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
      queueOutboxItem("delete", { issueId: resolvedId }, resolvedId);

      // Optimistically remove from cache so it disappears immediately
      deleteCachedIssue(resolvedId);

      // Spawn background worker
      ensureOutboxProcessed();

      if (options.json) {
        output(JSON.stringify({ deleted: resolvedId, title, queued: true }));
      } else {
        output(`Deleted: ${getDisplayId(resolvedId)}: ${title}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
