/**
 * Sync operations - push outbox and pull from Linear
 */

import { Issue } from "../types.js";
import {
  isCacheStale,
  getIncrementalSyncTimestamp,
  incrementSyncRunCount,
  needsFullSync,
  getLastSync,
  getOutboxStats,
} from "./database.js";
import {
  fetchIssues,
  fetchAllIssuesPaginated,
  fetchAllUpdatedIssues,
  getTeamId,
} from "./issue-backend.js";
import { exportToJsonl } from "./jsonl.js";
import { isWorkerRunning } from "./pid-manager.js";
import { ensureOutboxProcessed } from "./spawn-worker.js";
import { processOutboxQueue } from "./outbox-processor.js";

/**
 * Process outbox queue - push pending mutations to Linear
 */
const OUTBOX_INFLIGHT_WAIT_MS = 1200;
const OUTBOX_INFLIGHT_POLL_MS = 100;

export async function pushOutbox(teamId: string): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  let waitedMs = 0;

  while (true) {
    const result = await processOutboxQueue(teamId);
    success += result.success;
    failed += result.failed;

    if (result.deferred === 0) {
      break;
    }

    if (result.success > 0 || result.failed > 0) {
      continue;
    }

    const stats = getOutboxStats();
    if (stats.total === 0 || stats.processing === 0) {
      break;
    }

    if (waitedMs >= OUTBOX_INFLIGHT_WAIT_MS) {
      break;
    }

    await sleep(OUTBOX_INFLIGHT_POLL_MS);
    waitedMs += OUTBOX_INFLIGHT_POLL_MS;
  }

  return { success, failed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull issues from Linear and update cache (legacy, non-paginated)
 */
export async function pullFromLinear(teamId: string): Promise<Issue[]> {
  // No clearCache - fetchIssues uses upsert (INSERT OR REPLACE)
  return fetchIssues(teamId);
}

/**
 * Incremental sync - only fetch issues updated since last sync.
 * Returns count of updated issues, or null if no last sync (first run).
 */
export async function incrementalSync(teamKey?: string): Promise<{
  pushed: { success: number; failed: number };
  pulled: number;
  type: "incremental";
} | null> {
  const since = getIncrementalSyncTimestamp();
  if (!since) {
    // Never synced before - need full sync
    return null;
  }

  const teamId = await getTeamId(teamKey);

  // Push first
  const pushed = await pushOutbox(teamId);

  // Pull only updated issues
  const issues = await fetchAllUpdatedIssues(teamId, since);

  // Export to JSONL
  exportToJsonl();

  // Increment run count after successful sync
  incrementSyncRunCount();

  return {
    pushed,
    pulled: issues.length,
    type: "incremental",
  };
}

/**
 * Full sync with pagination - fetches all issues and prunes stale ones.
 */
export async function fullSyncPaginated(teamKey?: string): Promise<{
  pushed: { success: number; failed: number };
  pulled: number;
  pruned: number;
  type: "full";
}> {
  const teamId = await getTeamId(teamKey);

  // Push first
  const pushed = await pushOutbox(teamId);

  // Pull all issues with pagination
  const { issues, pruned } = await fetchAllIssuesPaginated(teamId);

  // Export to JSONL
  exportToJsonl();

  // Increment run count after successful sync
  incrementSyncRunCount();

  return {
    pushed,
    pulled: issues.length,
    pruned,
    type: "full",
  };
}

/**
 * Full sync - push then pull (legacy, uses non-paginated fetch)
 */
export async function fullSync(teamKey?: string): Promise<{
  pushed: { success: number; failed: number };
  pulled: number;
}> {
  const teamId = await getTeamId(teamKey);

  // Push first
  const pushed = await pushOutbox(teamId);

  // Then pull
  const issues = await pullFromLinear(teamId);

  // Export to JSONL
  exportToJsonl();

  return {
    pushed,
    pulled: issues.length,
  };
}

/**
 * Smart sync - chooses incremental or full based on sync history.
 * Defaults to incremental, triggers full sync every 3rd run or if >24h since last full sync.
 * If full sync is needed and worker is already running, skips (worker will do it).
 */
export async function smartSync(
  teamKey?: string,
  forceFullSync: boolean = false
): Promise<{
  pushed: { success: number; failed: number };
  pulled: number;
  pruned?: number;
  type: "incremental" | "full" | "skipped";
}> {
  // Check if we should do a full sync
  const shouldFullSync = forceFullSync || needsFullSync();

  // If full sync is needed and worker is already running, skip
  // (the worker will handle the full sync)
  if (shouldFullSync && isWorkerRunning() && !forceFullSync) {
    // Do incremental in foreground, worker will handle full sync
    const result = await incrementalSync(teamKey);
    if (result) {
      return { ...result, type: "incremental" };
    }
    // If first run, do full sync anyway
  }

  if (shouldFullSync || !getLastSync()) {
    // Full sync
    return fullSyncPaginated(teamKey);
  } else {
    // Incremental sync
    const result = await incrementalSync(teamKey);
    if (result) {
      return result;
    } else {
      // Fallback to full if incremental isn't possible (first run edge case)
      return fullSyncPaginated(teamKey);
    }
  }
}

/**
 * Schedule a background full sync if needed.
 * Called after incremental sync to check if it's time for a full refresh.
 */
export function scheduleBackgroundFullSyncIfNeeded(): void {
  if (needsFullSync() && !isWorkerRunning()) {
    // Spawn background worker which will detect needsFullSync and do a full sync
    ensureOutboxProcessed();
  }
}

/**
 * Check if sync is needed and optionally perform it
 */
export async function ensureFresh(teamKey?: string, force: boolean = false): Promise<boolean> {
  if (!force && !isCacheStale()) {
    return false; // Cache is fresh
  }

  await smartSync(teamKey, force);
  return true; // Synced
}
