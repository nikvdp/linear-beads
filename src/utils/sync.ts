/**
 * Sync operations - push outbox and pull from Linear
 */

import { Issue } from "../types.js";
import {
  isCacheStale,
  hasSyncContextChanged,
  getIncrementalSyncTimestamp,
  incrementSyncRunCount,
  needsFullSync,
  getLastSync,
  getOutboxStats,
  repairCreateOutboxForUnsyncedIssues,
  updateLastSyncContext,
  updateIssueUpdateWatermarkFromIssues,
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
import { getMailBackendAdapter } from "./mail-backend.js";
import { getRepoName, getRepoScope, getTeamKey } from "./config.js";
import {
  getActiveRemoteSyncPause,
  getAutomaticRemoteSyncPause,
  recordRemoteSyncPause,
} from "./remote-sync-state.js";

/**
 * Process outbox queue - push pending mutations to Linear
 */
const OUTBOX_INFLIGHT_WAIT_MS = 1200;
const OUTBOX_INFLIGHT_POLL_MS = 100;
const SYNC_DEFAULT_STRICT_TIMEOUT_MS = 120000;
const SYNC_DEFAULT_BEST_EFFORT_TIMEOUT_MS = 12000;

type SmartSyncResult = {
  pushed: { success: number; failed: number };
  pulled: number;
  pruned?: number;
  type: "incremental" | "full" | "skipped";
};

type SmartSyncRunner = (teamKey?: string, forceFullSync?: boolean) => Promise<SmartSyncResult>;

let smartSyncRunnerForTests: SmartSyncRunner | null = null;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSyncDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env.LB_SYNC_DEBUG);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function syncDebug(message: string): void {
  if (!isSyncDebugEnabled()) return;
  console.error(`>>> sync: ${message}`);
}

async function measureSyncPhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  syncDebug(`${phase} start`);
  try {
    const result = await operation();
    syncDebug(`${phase} done (${Date.now() - startedAt}ms)`);
    return result;
  } catch (error) {
    syncDebug(`${phase} failed (${Date.now() - startedAt}ms): ${formatError(error)}`);
    throw error;
  }
}

class SyncTimeoutError extends Error {
  constructor(
    public readonly phase: string,
    public readonly timeoutMs: number
  ) {
    super(`Sync timed out after ${timeoutMs}ms during ${phase}`);
    this.name = "SyncTimeoutError";
  }
}

function isSyncTimeoutError(error: unknown): error is SyncTimeoutError {
  return error instanceof SyncTimeoutError;
}

async function runWithTimeout<T>(
  phase: string,
  timeoutMs: number,
  operation: () => Promise<T>
): Promise<T> {
  if (timeoutMs <= 0) {
    return operation();
  }

  const opPromise = Promise.resolve().then(operation);

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      settled = true;
      reject(new SyncTimeoutError(phase, timeoutMs));
    }, timeoutMs);

    opPromise
      .then((value) => {
        if (settled) {
          syncDebug(`${phase} completed after timeout`);
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          syncDebug(`${phase} failed after timeout: ${formatError(error)}`);
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function getStrictSyncTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.LB_SYNC_STRICT_TIMEOUT_MS, SYNC_DEFAULT_STRICT_TIMEOUT_MS);
}

function getBestEffortSyncTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.LB_SYNC_BEST_EFFORT_TIMEOUT_MS, SYNC_DEFAULT_BEST_EFFORT_TIMEOUT_MS);
}

function getSmartSyncRunner(): SmartSyncRunner {
  return smartSyncRunnerForTests || smartSync;
}

export function __setSmartSyncRunnerForTests(runner: SmartSyncRunner | null): void {
  smartSyncRunnerForTests = runner;
}

export async function pushOutbox(teamId: string): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  let waitedMs = 0;

  // Self-heal missing/stuck create rows so LOCAL issues can converge even if outbox state was lost.
  repairCreateOutboxForUnsyncedIssues();

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

function buildSyncContextKey(teamKeyOverride?: string): string {
  return JSON.stringify({
    teamKey: teamKeyOverride || getTeamKey() || "__auto__",
    repoScope: getRepoScope(),
    repoName: getRepoName() || "unknown",
  });
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
  type: "incremental" | "skipped";
} | null> {
  const since = getIncrementalSyncTimestamp();
  if (!since) {
    // Never synced before - need full sync
    return null;
  }

  const teamId = await measureSyncPhase("incremental.getTeamId", () => getTeamId(teamKey));

  // Push first
  const pushed = await measureSyncPhase("incremental.pushOutbox", () => pushOutbox(teamId));
  if (getActiveRemoteSyncPause()) {
    return {
      pushed,
      pulled: 0,
      type: "skipped",
    };
  }

  // Pull only updated issues
  const issues = await measureSyncPhase("incremental.pullUpdated", () =>
    fetchAllUpdatedIssues(teamId, since)
  );
  updateIssueUpdateWatermarkFromIssues(issues);
  await measureSyncPhase("incremental.mailIngest", () => getMailBackendAdapter().ingest());

  // Export to JSONL
  await measureSyncPhase("incremental.export", async () => {
    exportToJsonl();
  });

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
  type: "full" | "skipped";
}> {
  const teamId = await measureSyncPhase("full.getTeamId", () => getTeamId(teamKey));

  // Push first
  const pushed = await measureSyncPhase("full.pushOutbox", () => pushOutbox(teamId));
  if (getActiveRemoteSyncPause()) {
    return {
      pushed,
      pulled: 0,
      pruned: 0,
      type: "skipped",
    };
  }

  // Pull all issues with pagination
  const { issues, pruned } = await measureSyncPhase("full.pullAllPaginated", () =>
    fetchAllIssuesPaginated(teamId)
  );
  updateIssueUpdateWatermarkFromIssues(issues);
  await measureSyncPhase("full.mailIngest", () => getMailBackendAdapter().ingest());

  // Export to JSONL
  await measureSyncPhase("full.export", async () => {
    exportToJsonl();
  });

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
  type?: "skipped";
}> {
  const teamId = await measureSyncPhase("legacyFull.getTeamId", () => getTeamId(teamKey));

  // Push first
  const pushed = await measureSyncPhase("legacyFull.pushOutbox", () => pushOutbox(teamId));
  if (getActiveRemoteSyncPause()) {
    return {
      pushed,
      pulled: 0,
      type: "skipped",
    };
  }

  // Then pull
  const issues = await measureSyncPhase("legacyFull.pull", () => pullFromLinear(teamId));
  updateIssueUpdateWatermarkFromIssues(issues);
  await measureSyncPhase("legacyFull.mailIngest", () => getMailBackendAdapter().ingest());

  // Export to JSONL
  await measureSyncPhase("legacyFull.export", async () => {
    exportToJsonl();
  });

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
): Promise<SmartSyncResult> {
  const activePause = getActiveRemoteSyncPause();
  if (activePause) {
    syncDebug(`smartSync skipped until ${activePause.until}`);
    return {
      pushed: { success: 0, failed: 0 },
      pulled: 0,
      type: "skipped",
    };
  }

  const contextKey = buildSyncContextKey(teamKey);

  // Check if we should do a full sync
  const shouldFullSync = forceFullSync || needsFullSync();
  syncDebug(
    `smartSync start forceFullSync=${forceFullSync} shouldFullSync=${shouldFullSync} workerRunning=${isWorkerRunning()}`
  );

  // If full sync is needed and worker is already running, skip
  // (the worker will handle the full sync)
  if (shouldFullSync && isWorkerRunning() && !forceFullSync) {
    // Do incremental in foreground, worker will handle full sync
    const result = await measureSyncPhase("smartSync.incrementalWithWorker", () =>
      incrementalSync(teamKey)
    );
    if (result) {
      if (result.type !== "skipped") {
        updateLastSyncContext(contextKey);
      }
      syncDebug(`smartSync done type=${result.type}`);
      return result.type === "skipped" ? result : { ...result, type: "incremental" };
    }
    // If first run, do full sync anyway
  }

  try {
    if (shouldFullSync || !getLastSync()) {
      // Full sync
      const result = await measureSyncPhase("smartSync.fullSyncPaginated", () =>
        fullSyncPaginated(teamKey)
      );
      if (result.type !== "skipped") {
        updateLastSyncContext(contextKey);
      }
      syncDebug(`smartSync done type=${result.type}`);
      return result;
    } else {
      // Incremental sync
      const result = await measureSyncPhase("smartSync.incremental", () =>
        incrementalSync(teamKey)
      );
      if (result) {
        if (result.type !== "skipped") {
          updateLastSyncContext(contextKey);
        }
        syncDebug(`smartSync done type=${result.type}`);
        return result;
      } else {
        // Fallback to full if incremental isn't possible (first run edge case)
        const fullResult = await measureSyncPhase("smartSync.incrementalFallbackFull", () =>
          fullSyncPaginated(teamKey)
        );
        if (fullResult.type !== "skipped") {
          updateLastSyncContext(contextKey);
        }
        syncDebug(`smartSync done type=${fullResult.type}`);
        return fullResult;
      }
    }
  } catch (error) {
    const pause = recordRemoteSyncPause(error);
    if (pause) {
      syncDebug(`smartSync paused until ${pause.until}: ${pause.message || pause.kind}`);
      return {
        pushed: { success: 0, failed: 0 },
        pulled: 0,
        type: "skipped",
      };
    }
    throw error;
  }
}

/**
 * Schedule a background full sync if needed.
 * Called after incremental sync to check if it's time for a full refresh.
 */
export function scheduleBackgroundFullSyncIfNeeded(): void {
  if (!getAutomaticRemoteSyncPause() && needsFullSync() && !isWorkerRunning()) {
    // Spawn background worker which will detect needsFullSync and do a full sync
    ensureOutboxProcessed();
  }
}

async function runFreshSyncWithBudget(
  teamKey: string | undefined,
  force: boolean,
  contextChanged: boolean,
  timeoutMs: number,
  phaseLabel: string
): Promise<SmartSyncResult> {
  const forceSync = force || contextChanged;
  return await runWithTimeout(phaseLabel, timeoutMs, async () => {
    return await measureSyncPhase("ensureFresh.smartSync", () =>
      getSmartSyncRunner()(teamKey, forceSync)
    );
  });
}

/**
 * Check if sync is needed and optionally perform it
 */
export async function ensureFresh(teamKey?: string, force: boolean = false): Promise<boolean> {
  const contextKey = buildSyncContextKey(teamKey);
  const contextChanged = hasSyncContextChanged(contextKey);
  const cacheStale = isCacheStale();
  syncDebug(
    `ensureFresh start force=${force} contextChanged=${contextChanged} cacheStale=${cacheStale}`
  );

  if (!force && !contextChanged && !cacheStale) {
    syncDebug("ensureFresh skipped (cache fresh and context unchanged)");
    return false; // Cache is fresh
  }

  const result = await runFreshSyncWithBudget(
    teamKey,
    force,
    contextChanged,
    getStrictSyncTimeoutMs(),
    "ensureFresh.strict"
  );
  syncDebug(`ensureFresh done type=${result.type}`);
  return result.type !== "skipped";
}

export type EnsureFreshBestEffortResult = {
  synced: boolean;
  timedOut: boolean;
  error?: Error;
};

export async function ensureFreshBestEffort(
  teamKey?: string,
  options: {
    force?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<EnsureFreshBestEffortResult> {
  const force = options.force === true;
  const contextKey = buildSyncContextKey(teamKey);
  const contextChanged = hasSyncContextChanged(contextKey);
  const cacheStale = isCacheStale();
  syncDebug(
    `ensureFreshBestEffort start force=${force} contextChanged=${contextChanged} cacheStale=${cacheStale}`
  );

  if (!force && !contextChanged && !cacheStale) {
    syncDebug("ensureFreshBestEffort skipped (cache fresh and context unchanged)");
    return { synced: false, timedOut: false };
  }

  const timeoutMs = options.timeoutMs || getBestEffortSyncTimeoutMs();
  try {
    const result = await runFreshSyncWithBudget(
      teamKey,
      force,
      contextChanged,
      timeoutMs,
      "ensureFresh.bestEffort"
    );
    syncDebug(`ensureFreshBestEffort done type=${result.type}`);
    return { synced: result.type !== "skipped", timedOut: false };
  } catch (error) {
    if (isSyncTimeoutError(error)) {
      syncDebug(`ensureFreshBestEffort timeout: ${error.message}`);
      return { synced: false, timedOut: true, error };
    }

    const normalized = error instanceof Error ? error : new Error(String(error));
    syncDebug(`ensureFreshBestEffort failed: ${normalized.message}`);
    return { synced: false, timedOut: false, error: normalized };
  }
}
