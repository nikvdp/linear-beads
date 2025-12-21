/**
 * lb delete - Delete an issue
 */

import { Command } from "commander";
import { deleteIssue } from "../utils/linear.js";
import { deleteCachedIssue, getCachedIssue, queueOutboxItem } from "../utils/database.js";
import { output } from "../utils/output.js";
import { ensureOutboxProcessed } from "../utils/spawn-worker.js";

export const deleteCommand = new Command("delete")
  .description("Delete an issue permanently")
  .argument("<id>", "Issue ID")
  .option("-f, --force", "Skip confirmation")
  .option("-j, --json", "Output as JSON")
  .option("--sync", "Delete immediately (block on network)")
  .action(async (id: string, options) => {
    try {
      // Get issue info first for display
      const issue = getCachedIssue(id);
      const title = issue?.title || id;

      if (!options.force) {
        // Show what will be deleted
        output(`Will delete: ${id}: ${title}`);
        output(`This is permanent and cannot be undone.`);
        output(`Run with --force to confirm.`);
        process.exit(0);
      }

      if (options.sync) {
        // Sync mode: delete directly from Linear
        await deleteIssue(id);
        deleteCachedIssue(id);

        if (options.json) {
          output(JSON.stringify({ deleted: id, title }));
        } else {
          output(`Deleted: ${id}: ${title}`);
        }
      } else {
        // Queue mode: add to outbox and spawn background worker
        queueOutboxItem("delete", { issueId: id });

        // Optimistically remove from cache so it disappears immediately
        deleteCachedIssue(id);

        // Spawn background worker
        ensureOutboxProcessed();

        if (options.json) {
          output(JSON.stringify({ deleted: id, title, queued: true }));
        } else {
          output(`Deleted: ${id}: ${title}`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
