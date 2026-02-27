/**
 * Background sync worker - processes outbox queue and periodic full syncs
 * Should be spawned as a detached process by write commands
 *
 * Polls outbox every 500ms, exits after 5s of inactivity.
 * Parent can touch PID file to signal "stay alive" for new work.
 * Also runs full sync if needsFullSync() is true.
 */

import { writePidFile, removePidFile, getPidFileMtime } from "./pid-manager.js";
import { getPendingOutboxItems, needsFullSync, incrementSyncRunCount } from "./database.js";
import { getTeamId, fetchIssues, fetchAllIssuesPaginated } from "./linear.js";
import { exportToJsonl } from "./jsonl.js";
import { operationRequiresTeamId, processOutboxQueue } from "./outbox-processor.js";
import { isLocalOnly } from "./config.js";

const IDLE_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 500;

/**
 * Process the outbox queue with polling and idle timeout
 */
async function processOutbox(): Promise<void> {
  // Write our PID first
  writePidFile(process.pid);

  let lastActivityTime = Date.now();
  let lastPidMtime = getPidFileMtime();
  let teamId: string | null = null;
  let didWork = false;
  let didRemoteWork = false;

  try {
    while (true) {
      const items = getPendingOutboxItems();

      if (items.length > 0) {
        const needsTeamId = items.some((item) => operationRequiresTeamId(item.operation));

        // Get team ID once (cache it) only if any queued operation needs remote backend calls
        if (needsTeamId && !teamId) {
          teamId = await getTeamId();
        }

        const result = await processOutboxQueue(teamId || "", { propagateParent: true });
        if (result.success > 0 || result.failed > 0) {
          lastActivityTime = Date.now();
        }
        if (result.success > 0) {
          didWork = true;
        }
        if (result.remoteProcessed > 0) {
          didRemoteWork = true;
        }
      } else {
        // No items - check if we should stay alive
        const currentPidMtime = getPidFileMtime();

        // If PID file was touched since last check, reset idle timer
        if (currentPidMtime > lastPidMtime) {
          lastActivityTime = Date.now();
          lastPidMtime = currentPidMtime;
        }

        // Check if we've been idle too long
        if (Date.now() - lastActivityTime > IDLE_TIMEOUT_MS) {
          break;
        }
      }

      // Poll interval
      await sleep(POLL_INTERVAL_MS);
    }

    // Sync if we did work
    if (didWork && didRemoteWork) {
      if (!teamId) {
        teamId = await getTeamId();
      }
      await fetchIssues(teamId);
      exportToJsonl();
    }

    // Check if we should run a full sync (every 3rd run or >24h since last)
    if (!isLocalOnly() && needsFullSync()) {
      if (!teamId) {
        teamId = await getTeamId();
      }
      try {
        const { pruned } = await fetchAllIssuesPaginated(teamId);
        if (pruned > 0) {
          console.log(`Background full sync: pruned ${pruned} stale issues`);
        }
        exportToJsonl();
        incrementSyncRunCount();
      } catch (error) {
        console.error("Background full sync failed:", error);
        // Don't fail the worker, just log and continue
      }
    }

    // Note: We intentionally skip fetching relations here.
    // Fetching relations for all issues is O(n) API calls which is too slow.
    // Relations are fetched on-demand via `lb show <id> --sync`.
  } finally {
    // Clean up PID file when exiting
    removePidFile();
  }
}

/**
 * Sleep for ms milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main entry point when run as a script
 */
if (import.meta.main) {
  processOutbox()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error("Worker failed:", error);
      removePidFile();
      process.exit(1);
    });
}

export { processOutbox };
