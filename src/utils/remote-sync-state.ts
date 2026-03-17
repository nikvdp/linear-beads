import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import {
  clearRemoteSyncPauseRecord as clearLegacyRemoteSyncPauseRecord,
  getRemoteSyncPauseRecord as getLegacyRemoteSyncPauseRecord,
  runWithBusyRetry,
} from "./database.js";
import { getConfig, getGlobalConfigPath } from "./config.js";
import { getLinearRequestPolicy, linearFetchWithRetry } from "./graphql.js";

const DEFAULT_RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
const DEFAULT_NETWORK_PAUSE_MS = 30 * 1000;
const DEFAULT_RATE_LIMIT_PROBE_MS = 15000;
const MAX_RATE_LIMIT_PROBE_MS = 60000;
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const GLOBAL_STATE_DB_FILENAME = "state.db";
const GLOBAL_REMOTE_SYNC_PAUSE_KEY_PREFIX = "remote_sync_pause:";

type StoredRemoteSyncPauseRecord = {
  kind: "rate_limit" | "network";
  until: string;
  backgroundUntil?: string;
  message?: string;
};

let globalStateDb: Database | null = null;

function getGlobalStateDbPath(): string {
  return join(dirname(getGlobalConfigPath()), GLOBAL_STATE_DB_FILENAME);
}

function getGlobalStateDb(): Database {
  if (globalStateDb) {
    return globalStateDb;
  }

  const dbPath = getGlobalStateDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  globalStateDb = db;
  return db;
}

function getConfiguredApiKey(): string | null {
  const apiKey = getConfig().api_key?.trim();
  return apiKey ? apiKey : null;
}

function getRemoteSyncPauseKey(): string | null {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    return null;
  }

  const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 24);
  return `${GLOBAL_REMOTE_SYNC_PAUSE_KEY_PREFIX}${fingerprint}`;
}

function parseStoredPauseRecord(raw: string): StoredRemoteSyncPauseRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRemoteSyncPauseRecord>;
    if (
      (parsed.kind !== "rate_limit" && parsed.kind !== "network") ||
      typeof parsed.until !== "string"
    ) {
      return null;
    }

    return {
      kind: parsed.kind,
      until: parsed.until,
      backgroundUntil:
        typeof parsed.backgroundUntil === "string" ? parsed.backgroundUntil : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
    };
  } catch {
    return null;
  }
}

function getBackgroundUntil(record: StoredRemoteSyncPauseRecord): string {
  return record.backgroundUntil || record.until;
}

function getStoredUntilMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStoredRateLimitPauseRecord(
  record: StoredRemoteSyncPauseRecord,
  nowMs: number
): StoredRemoteSyncPauseRecord {
  if (record.kind !== "rate_limit") {
    return record;
  }

  const backgroundUntil = getBackgroundUntil(record);
  const untilMs = getStoredUntilMs(record.until);
  if (untilMs === null) {
    return record;
  }

  if (backgroundUntil === record.until && untilMs - nowMs > MAX_RATE_LIMIT_PROBE_MS) {
    return {
      ...record,
      until: new Date(nowMs + DEFAULT_RATE_LIMIT_PROBE_MS).toISOString(),
      backgroundUntil,
    };
  }

  return {
    ...record,
    backgroundUntil,
  };
}

function clearStoredRemoteSyncPauseRecord(): void {
  const pauseKey = getRemoteSyncPauseKey();
  if (!pauseKey) {
    clearLegacyRemoteSyncPauseRecord();
    return;
  }

  const db = getGlobalStateDb();
  runWithBusyRetry(() => {
    db.run("DELETE FROM metadata WHERE key = ?", [pauseKey]);
  });
  clearLegacyRemoteSyncPauseRecord();
}

function setStoredRemoteSyncPauseRecord(record: StoredRemoteSyncPauseRecord): void {
  const pauseKey = getRemoteSyncPauseKey();
  if (!pauseKey) {
    return;
  }

  const db = getGlobalStateDb();
  runWithBusyRetry(() => {
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [
      pauseKey,
      JSON.stringify(record),
    ]);
  });
  clearLegacyRemoteSyncPauseRecord();
}

function migrateLegacyRemoteSyncPauseRecord(nowMs: number): void {
  const pauseKey = getRemoteSyncPauseKey();
  if (!pauseKey) {
    return;
  }

  const db = getGlobalStateDb();
  const existing = db.query("SELECT value FROM metadata WHERE key = ?").get(pauseKey) as
    | { value: string }
    | null;
  if (existing?.value) {
    clearLegacyRemoteSyncPauseRecord();
    return;
  }

  const legacy = getLegacyRemoteSyncPauseRecord();
  if (!legacy) {
    return;
  }

  const legacyUntilMs = getStoredUntilMs(legacy.until);
  if (legacyUntilMs === null || legacyUntilMs <= nowMs) {
    clearLegacyRemoteSyncPauseRecord();
    return;
  }

  setStoredRemoteSyncPauseRecord({
    kind: legacy.kind,
    until:
      legacy.kind === "rate_limit"
        ? new Date(Math.min(legacyUntilMs, nowMs + DEFAULT_RATE_LIMIT_PROBE_MS)).toISOString()
        : legacy.until,
    backgroundUntil: legacy.until,
    message: legacy.message,
  });
}

function getStoredRemoteSyncPauseRecord(
  nowMs: number = Date.now()
): StoredRemoteSyncPauseRecord | null {
  const pauseKey = getRemoteSyncPauseKey();
  if (!pauseKey) {
    return null;
  }

  migrateLegacyRemoteSyncPauseRecord(nowMs);

  const db = getGlobalStateDb();
  const row = db.query("SELECT value FROM metadata WHERE key = ?").get(pauseKey) as
    | { value: string }
    | null;

  if (!row?.value) {
    return null;
  }

  const record = parseStoredPauseRecord(row.value);
  if (!record) {
    clearStoredRemoteSyncPauseRecord();
    return null;
  }

  const normalizedRecord = normalizeStoredRateLimitPauseRecord(record, nowMs);
  if (
    normalizedRecord.until !== record.until ||
    normalizedRecord.backgroundUntil !== record.backgroundUntil
  ) {
    setStoredRemoteSyncPauseRecord(normalizedRecord);
  }

  const untilMs = getStoredUntilMs(normalizedRecord.until);
  const backgroundUntilMs = getStoredUntilMs(getBackgroundUntil(normalizedRecord));
  const commandActive = untilMs !== null && untilMs > nowMs;
  const backgroundActive = backgroundUntilMs !== null && backgroundUntilMs > nowMs;

  if (!commandActive && !backgroundActive) {
    clearStoredRemoteSyncPauseRecord();
    return null;
  }

  if (untilMs === null) {
    clearStoredRemoteSyncPauseRecord();
    return null;
  }

  if (backgroundUntilMs === null) {
    return {
      ...normalizedRecord,
      backgroundUntil: normalizedRecord.until,
    };
  }

  return {
    ...normalizedRecord,
    backgroundUntil: getBackgroundUntil(normalizedRecord),
  };
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeForDisplay(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (compact.length <= 220) {
    return compact;
  }
  return `${compact.slice(0, 217)}...`;
}

function isRateLimitErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("rate limit exceeded") ||
    normalized.includes("ratelimited") ||
    normalized.includes("\"code\":\"ratelimited\"") ||
    normalized.includes("\"type\":\"ratelimited\"")
  );
}

export function isNetworkErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("fetch failed") ||
    normalized.includes("network") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("etimedout") ||
    normalized.includes("connection reset") ||
    normalized.includes("socket hang up") ||
    normalized.includes("unable to connect")
  );
}

function extractRetryAfterMs(message: string, nowMs: number): number | null {
  const resetMatch = message.match(
    /["']?x-ratelimit-requests-reset["']?\s*[:=]\s*["']?(\d{10,16})/i
  );
  if (resetMatch) {
    const resetAtMs = Number.parseInt(resetMatch[1], 10);
    if (Number.isFinite(resetAtMs) && resetAtMs > nowMs) {
      return resetAtMs - nowMs;
    }
  }

  const retryAfterMatch = message.match(/["']?retry-?after["']?\s*[:=]\s*["']?(\d{1,10})/i);
  if (retryAfterMatch) {
    const seconds = Number.parseInt(retryAfterMatch[1], 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  return null;
}

function computeRateLimitAutomaticPauseMs(message: string, nowMs: number): number {
  const retryAfterMs = extractRetryAfterMs(message, nowMs);
  if (retryAfterMs && retryAfterMs > 0) {
    return retryAfterMs;
  }

  return DEFAULT_RATE_LIMIT_PAUSE_MS;
}

function extractRateLimitMeta(message: string): {
  durationMs?: number;
  limit?: number;
  remaining?: number;
  requested?: number;
  resetAtMs?: number;
  retryAfterMs?: number;
} {
  const durationMatch = message.match(/["']duration["']\s*:\s*(\d{1,12})/i);
  const limitMatch = message.match(/["']limit["']\s*:\s*(\d{1,12})/i);
  const remainingMatch = message.match(/["']remaining["']\s*:\s*(\d{1,12})/i);
  const requestedMatch = message.match(/["']requested["']\s*:\s*(\d{1,12})/i);
  const resetMatch = message.match(
    /["']?x-ratelimit-requests-reset["']?\s*[:=]\s*["']?(\d{10,16})/i
  );
  const retryAfterMatch = message.match(/["']?retry-?after["']?\s*[:=]\s*["']?(\d{1,10})/i);

  const durationMs = durationMatch ? Number.parseInt(durationMatch[1], 10) : undefined;
  const limit = limitMatch ? Number.parseInt(limitMatch[1], 10) : undefined;
  const remaining = remainingMatch ? Number.parseInt(remainingMatch[1], 10) : undefined;
  const requested = requestedMatch ? Number.parseInt(requestedMatch[1], 10) : undefined;
  const resetAtMs = resetMatch ? Number.parseInt(resetMatch[1], 10) : undefined;
  const retryAfterSeconds = retryAfterMatch ? Number.parseInt(retryAfterMatch[1], 10) : undefined;

  return {
    durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
    remaining: Number.isFinite(remaining) ? remaining : undefined,
    requested: Number.isFinite(requested) ? requested : undefined,
    resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : undefined,
    retryAfterMs:
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds !== undefined
        ? retryAfterSeconds * 1000
        : undefined,
  };
}

function computeRateLimitProbeMs(message: string, nowMs: number): number {
  const meta = extractRateLimitMeta(message);
  if (meta.durationMs && meta.limit && meta.limit > 0) {
    const requested = Math.max(1, meta.requested || 1);
    const msPerToken = meta.durationMs / meta.limit;
    const conservativeProbeMs = Math.ceil(msPerToken * requested * 20);
    return Math.min(MAX_RATE_LIMIT_PROBE_MS, Math.max(DEFAULT_RATE_LIMIT_PROBE_MS, conservativeProbeMs));
  }

  const retryAfterMs = extractRetryAfterMs(message, nowMs);
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.min(MAX_RATE_LIMIT_PROBE_MS, Math.max(DEFAULT_RATE_LIMIT_PROBE_MS, retryAfterMs));
  }

  return DEFAULT_RATE_LIMIT_PROBE_MS;
}

export type ActiveRemoteSyncPause = StoredRemoteSyncPauseRecord & {
  retryAfterMs: number;
  backgroundUntil: string;
  backgroundRetryAfterMs: number;
};

function toActivePause(
  record: StoredRemoteSyncPauseRecord,
  activeUntil: string,
  nowMs: number
): ActiveRemoteSyncPause | null {
  const untilMs = getStoredUntilMs(activeUntil);
  const backgroundUntil = getBackgroundUntil(record);
  const backgroundUntilMs = getStoredUntilMs(backgroundUntil);
  if (untilMs === null || untilMs <= nowMs || backgroundUntilMs === null) {
    return null;
  }

  return {
    ...record,
    until: activeUntil,
    backgroundUntil,
    retryAfterMs: untilMs - nowMs,
    backgroundRetryAfterMs: Math.max(0, backgroundUntilMs - nowMs),
  };
}

export function getActiveRemoteSyncPause(nowMs: number = Date.now()): ActiveRemoteSyncPause | null {
  const record = getStoredRemoteSyncPauseRecord(nowMs);
  if (!record) {
    return null;
  }

  return toActivePause(record, record.until, nowMs);
}

export function getAutomaticRemoteSyncPause(
  nowMs: number = Date.now()
): ActiveRemoteSyncPause | null {
  const record = getStoredRemoteSyncPauseRecord(nowMs);
  if (!record) {
    return null;
  }

  return toActivePause(record, getBackgroundUntil(record), nowMs);
}

function buildProbeFailureMessage(response: Response, body: string): string {
  return `Pause probe failed: ${JSON.stringify({
    status: response.status,
    headers: {
      "retry-after": response.headers.get("retry-after"),
      "x-ratelimit-requests-reset": response.headers.get("x-ratelimit-requests-reset"),
    },
    body,
  })}`;
}

function buildPauseRecord(error: unknown, nowMs: number): ActiveRemoteSyncPause | null {
  const message = normalizeErrorMessage(error);

  if (isRateLimitErrorMessage(message)) {
    const retryAfterMs = computeRateLimitProbeMs(message, nowMs);
    const backgroundRetryAfterMs = computeRateLimitAutomaticPauseMs(message, nowMs);
    return {
      kind: "rate_limit",
      until: new Date(nowMs + retryAfterMs).toISOString(),
      backgroundUntil: new Date(nowMs + backgroundRetryAfterMs).toISOString(),
      retryAfterMs,
      backgroundRetryAfterMs,
      message: normalizeForDisplay(message),
    };
  }

  if (isNetworkErrorMessage(message)) {
    return {
      kind: "network",
      until: new Date(nowMs + DEFAULT_NETWORK_PAUSE_MS).toISOString(),
      backgroundUntil: new Date(nowMs + DEFAULT_NETWORK_PAUSE_MS).toISOString(),
      retryAfterMs: DEFAULT_NETWORK_PAUSE_MS,
      backgroundRetryAfterMs: DEFAULT_NETWORK_PAUSE_MS,
      message: normalizeForDisplay(message),
    };
  }

  return null;
}

function clampActiveUntil(currentIso: string | undefined, nextIso: string, nowMs: number): string {
  const nextUntilMs = getStoredUntilMs(nextIso);
  if (nextUntilMs === null) {
    return nextIso;
  }

  const currentUntilMs = currentIso ? getStoredUntilMs(currentIso) : null;
  if (currentUntilMs !== null && currentUntilMs > nowMs && nextUntilMs > currentUntilMs) {
    return new Date(currentUntilMs).toISOString();
  }

  return nextIso;
}

export function recordRemoteSyncPause(
  error: unknown,
  nowMs: number = Date.now()
): ActiveRemoteSyncPause | null {
  const next = buildPauseRecord(error, nowMs);
  if (!next) {
    return null;
  }

  const current = getStoredRemoteSyncPauseRecord(nowMs);
  const merged: StoredRemoteSyncPauseRecord = current
    ? {
        kind: next.kind,
        until: clampActiveUntil(current.until, next.until, nowMs),
        backgroundUntil: clampActiveUntil(
          getBackgroundUntil(current),
          next.backgroundUntil,
          nowMs
        ),
        message: next.message,
      }
    : {
        kind: next.kind,
        until: next.until,
        backgroundUntil: next.backgroundUntil,
        message: next.message,
      };

  setStoredRemoteSyncPauseRecord(merged);

  const active = getActiveRemoteSyncPause(nowMs);
  if (active) {
    return active;
  }

  return getAutomaticRemoteSyncPause(nowMs);
}

export async function getCommandRemoteSyncPause(): Promise<ActiveRemoteSyncPause | null> {
  const nowMs = Date.now();
  const activePause = getActiveRemoteSyncPause(nowMs);
  if (activePause) {
    return activePause;
  }

  const storedPause = getStoredRemoteSyncPauseRecord(nowMs);
  if (!storedPause) {
    return null;
  }

  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    return null;
  }

  try {
    const policy = getLinearRequestPolicy();
    const response = await linearFetchWithRetry(
      LINEAR_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `
            query PauseProbe {
              viewer {
                id
              }
            }
          `,
        }),
      },
      {
        policy: {
          ...policy,
          timeoutMs: Math.min(policy.timeoutMs, 5000),
          maxRetries: 0,
        },
      }
    );

    const body = await response.text();
    if (!response.ok) {
      const pause = recordRemoteSyncPause(buildProbeFailureMessage(response, body));
      return pause || getActiveRemoteSyncPause() || getAutomaticRemoteSyncPause() || null;
    }

    let parsed: { errors?: unknown[] } | null = null;
    try {
      parsed = JSON.parse(body) as { errors?: unknown[] };
    } catch {
      parsed = null;
    }

    if (parsed?.errors && parsed.errors.length > 0) {
      const pause = recordRemoteSyncPause(body);
      return pause || getActiveRemoteSyncPause() || getAutomaticRemoteSyncPause() || null;
    }

    clearStoredRemoteSyncPauseRecord();
    return null;
  } catch (error) {
    const pause = recordRemoteSyncPause(error);
    return pause || getActiveRemoteSyncPause() || getAutomaticRemoteSyncPause() || null;
  }
}

function formatPauseDuration(retryAfterMs: number): string {
  const totalMinutes = Math.ceil(retryAfterMs / 60000);
  if (totalMinutes < 1) {
    return "under a minute";
  }
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatPauseUntilLocal(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return isoTimestamp;
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).format(parsed);
  } catch {
    return parsed.toLocaleString();
  }
}

function formatRateLimitDetails(pause: ActiveRemoteSyncPause): string | null {
  if (pause.kind !== "rate_limit" || !pause.message) {
    return null;
  }

  const meta = extractRateLimitMeta(pause.message);
  const details: string[] = [];

  details.push(
    `Next manual re-check: ${formatPauseUntilLocal(pause.until)} (${formatPauseDuration(
      pause.retryAfterMs
    )})`
  );

  if (pause.backgroundRetryAfterMs > pause.retryAfterMs) {
    details.push(
      `Background sync resumes: ${formatPauseUntilLocal(
        pause.backgroundUntil
      )} (${formatPauseDuration(pause.backgroundRetryAfterMs)})`
    );
  }

  const bucketParts: string[] = [];
  if (meta.remaining !== undefined && meta.limit !== undefined) {
    bucketParts.push(`${meta.remaining}/${meta.limit} requests remaining`);
  } else if (meta.limit !== undefined) {
    bucketParts.push(`bucket limit ${meta.limit} requests`);
  }
  if (meta.requested !== undefined) {
    bucketParts.push(`${meta.requested} requested`);
  }
  if (meta.durationMs !== undefined) {
    bucketParts.push(`window ${formatPauseDuration(meta.durationMs)}`);
  }
  if (bucketParts.length > 0) {
    details.push(`Linear last reported: ${bucketParts.join(", ")}`);
  }

  const retryParts: string[] = [];
  if (meta.retryAfterMs !== undefined) {
    retryParts.push(`retry-after ${formatPauseDuration(meta.retryAfterMs)}`);
  }
  if (meta.resetAtMs !== undefined) {
    retryParts.push(`reset header ${formatPauseUntilLocal(new Date(meta.resetAtMs).toISOString())}`);
  }
  if (retryParts.length > 0) {
    details.push(`Last rate-limit headers: ${retryParts.join(", ")}`);
  }

  return details.join(". ");
}

export function formatRemoteSyncPauseNotice(
  pause: ActiveRemoteSyncPause,
  options: { prefix?: string } = {}
): string {
  const prefix = options.prefix || "Warning:";
  const cause = pause.kind === "rate_limit" ? "Linear rate limit" : "network failure";
  const summary = `${prefix} remote sync is paused until ${formatPauseUntilLocal(
    pause.until
  )} (${formatPauseDuration(pause.retryAfterMs)}) after ${cause}. Local cache and queued writes are still available.`;
  const details = formatRateLimitDetails(pause);
  return details ? `${summary}\n  ${details}` : summary;
}
