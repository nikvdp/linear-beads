/**
 * lb sync - Sync with Linear
 */

import { Command } from "commander";
import { smartSync, scheduleBackgroundFullSyncIfNeeded } from "../utils/sync.js";
import { output, outputError } from "../utils/output.js";
import { getPendingOutboxItems } from "../utils/database.js";
import { isLocalOnly } from "../utils/config.js";
import {
  formatRemoteSyncPauseNotice,
  getBlockingActiveRemoteSyncPause,
  getCommandRemoteSyncPause,
  isNetworkErrorMessage,
  recordRemoteSyncPause,
} from "../utils/remote-sync-state.js";

const SYNC_PROGRESS_DELAY_MS = 800;
const SYNC_PROGRESS_FRAME_INTERVAL_MS = 100;
const SYNC_PROGRESS_FRAMES = ["|", "/", "-", "\\"] as const;

function summarizeOutboxError(error: string): string {
  const compact = error.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) {
    return compact;
  }
  return `${compact.slice(0, 177)}...`;
}

function getSyncProgressDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LB_PROGRESS_DELAY_MS;
  if (!raw) {
    return SYNC_PROGRESS_DELAY_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return SYNC_PROGRESS_DELAY_MS;
  }

  return parsed;
}

export async function runWithSyncProgress<T>(
  operation: () => Promise<T>,
  options: {
    json?: boolean;
    stderrIsTTY?: boolean;
    delayMs?: number;
    write?: (chunk: string) => void;
  } = {}
): Promise<T> {
  const jsonMode = options.json === true;
  const stderrIsTTY = options.stderrIsTTY ?? Boolean(process.stderr.isTTY);
  if (jsonMode || !stderrIsTTY) {
    return await operation();
  }

  const delayMs = options.delayMs ?? getSyncProgressDelayMs();
  const write = options.write ?? ((chunk: string) => process.stderr.write(chunk));
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerStarted = false;
  let frameIndex = 0;

  const startSpinner = (): void => {
    spinnerStarted = true;
    write(`\r${SYNC_PROGRESS_FRAMES[frameIndex]} Syncing with Linear...`);
    spinnerTimer = setInterval(() => {
      frameIndex = (frameIndex + 1) % SYNC_PROGRESS_FRAMES.length;
      write(`\r${SYNC_PROGRESS_FRAMES[frameIndex]} Syncing with Linear...`);
    }, SYNC_PROGRESS_FRAME_INTERVAL_MS);
  };

  const delayTimer = setTimeout(startSpinner, delayMs);

  try {
    return await operation();
  } finally {
    clearTimeout(delayTimer);
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
    }
    if (spinnerStarted) {
      write("\r\x1b[K");
    }
  }
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

      const activePause = await getCommandRemoteSyncPause();
      if (activePause) {
        if (options.json) {
          output(
            JSON.stringify(
              {
                pushed: { success: 0, failed: 0 },
                pulled: 0,
                type: "skipped",
                degraded: true,
                pause: {
                  kind: activePause.kind,
                  until: activePause.until,
                  message: activePause.message,
                },
              },
              null,
              2
            )
          );
        } else {
          outputError(formatRemoteSyncPauseNotice(activePause));
          const pending = getPendingOutboxItems();
          if (pending.length > 0) {
            output(`  ${pending.length} pending change(s) will sync after the pause expires`);
          }
        }
        return;
      }

      const result = await runWithSyncProgress(
        () => smartSync(options.team, options.full),
        { json: Boolean(options.json) }
      );

      if (result.type === "skipped") {
        const pause = getBlockingActiveRemoteSyncPause();
        if (options.json) {
          output(
            JSON.stringify(
              {
                pushed: result.pushed,
                pulled: result.pulled,
                pruned: result.pruned,
                type: result.type,
                degraded: true,
                pause: pause
                  ? {
                      kind: pause.kind,
                      until: pause.until,
                      message: pause.message,
                    }
                  : undefined,
              },
              null,
              2
            )
          );
        } else {
          if (pause) {
            outputError(formatRemoteSyncPauseNotice(pause));
          } else {
            outputError("Warning: remote sync is temporarily unavailable; staying in local mode.");
          }
          const pending = getPendingOutboxItems();
          if (pending.length > 0) {
            output(`  ${pending.length} pending change(s) remain queued locally`);
          }
        }
        return;
      }

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
          if (result.pushed.failed > 0) {
            const failedItems = getPendingOutboxItems()
              .filter((item) => item.last_error)
              .slice(0, 3);
            if (failedItems.length > 0) {
              output("Recent push errors:");
              for (const item of failedItems) {
                const subject = item.local_id || item.operation;
                output(`  - ${subject}: ${summarizeOutboxError(item.last_error || "")}`);
              }
            }
          }
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
      const pause = recordRemoteSyncPause(error);
      if (pause) {
        outputError(formatRemoteSyncPauseNotice(pause));
        const pending = getPendingOutboxItems();
        if (pending.length > 0) {
          output(`  ${pending.length} pending change(s) will sync when remote access resumes`);
        }
        output("  Local cache is still available for reads");
        return;
      }
      if (error instanceof Error && isNetworkErrorMessage(error.message)) {
        const pending = getPendingOutboxItems();
        outputError("Offline: Unable to connect to Linear");
        if (pending.length > 0) {
          output(`  ${pending.length} pending change(s) will sync when back online`);
        }
        output("  Local cache is still available for reads");
        return;
      }
      outputError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
