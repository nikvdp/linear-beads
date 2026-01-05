/**
 * lb sync - Sync with Linear
 */

import { Command } from "commander";
import { smartSync, scheduleBackgroundFullSyncIfNeeded } from "../utils/sync.js";
import { output, outputError } from "../utils/output.js";
import { getPendingOutboxItems } from "../utils/database.js";
import { isLocalOnly } from "../utils/config.js";

/**
 * Check if error is a network/connectivity issue
 */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("etimedout") ||
    msg.includes("unable to connect")
  );
}

export const syncCommand = new Command("sync")
  .description("Sync with Linear (push pending changes, pull latest)")
  .option("--team <team>", "Team key (overrides config)")
  .option("--full", "Force full sync (re-fetch all issues, prune stale)")
  .option("-j, --json", "Output as JSON")
  .action(async (options) => {
    try {
      // Local-only mode: no sync needed
      if (isLocalOnly()) {
        output("Local-only mode: sync disabled (set local_only: false in config to enable)");
        return;
      }

      const result = await smartSync(options.team, options.full);

      if (options.json) {
        output(
          JSON.stringify(
            {
              pushed: result.pushed,
              pulled: result.pulled,
              pruned: result.pruned,
              type: result.type,
            },
            null,
            2
          )
        );
      } else {
        if (result.pushed.success > 0 || result.pushed.failed > 0) {
          output(`Pushed: ${result.pushed.success} succeeded, ${result.pushed.failed} failed`);
        }
        const typeLabel = result.type === "full" ? " (full sync)" : "";
        output(`Pulled: ${result.pulled} issues${typeLabel}`);
        if (result.pruned && result.pruned > 0) {
          output(`Pruned: ${result.pruned} stale issues`);
        }
      }

      // Schedule background full sync if needed (after incremental)
      if (result.type === "incremental") {
        scheduleBackgroundFullSyncIfNeeded();
      }
    } catch (error) {
      if (isNetworkError(error)) {
        const pending = getPendingOutboxItems();
        outputError("Offline: Unable to connect to Linear");
        if (pending.length > 0) {
          output(`  ${pending.length} pending change(s) will sync when back online`);
        }
        output("  Local cache is still available for reads");
        process.exit(1);
      }
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
