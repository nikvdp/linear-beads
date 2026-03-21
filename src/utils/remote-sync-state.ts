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
import {
  getLinearApiErrorInfo,
  getLinearApiErrorInfoFromResponse,
  getLinearRequestPolicy,
  linearFetchWithRetry,
  type LinearRateLimitBucketKind,
  type LinearRateLimitErrorInfo,
} from "./graphql.js";

const DEFAULT_RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
const DEFAULT_NETWORK_PAUSE_MS = 30 * 1000;
const DEFAULT_RATE_LIMIT_PROBE_MS = 15000;
const MAX_RATE_LIMIT_PROBE_MS = 60000;
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const GLOBAL_STATE_DB_FILENAME = "state.db";
const GLOBAL_REMOTE_SYNC_PAUSE_KEY_PREFIX = "remote_sync_pause:";

export type RemoteSyncPauseKind = "rate_limit" | "network";
export type RemoteSyncPauseScopeKind = "global" | "complexity" | "endpoint";

export type RemoteSyncPauseScope =
  | { kind: "global" }
  | { kind: "complexity" }
  | { kind: "endpoint"; endpointName: string };

type StoredRemoteSyncPauseRecord = {
  kind: RemoteSyncPauseKind;
  scope: RemoteSyncPauseScope;
  until: string;
  backgroundUntil?: string;
  message?: string;
  details?: {
    bucketKind?: LinearRateLimitBucketKind;
    endpointName?: string;
    retryAfterMs?: number;
    resetAtMs?: number;
    durationMs?: number;
    limit?: number;
    remaining?: number;
    requested?: number;
  };
};

export type ActiveRemoteSyncPause = StoredRemoteSyncPauseRecord & {
  retryAfterMs: number;
  backgroundUntil: string;
  backgroundRetryAfterMs: number;
};

type ExtractedErrorInfo = {
  message: string;
  headers: Record<string, string>;
  endpointName?: string;
  rateLimited: boolean;
  complexityLimited: boolean;
  networkError: boolean;
  rateLimit?: LinearRateLimitErrorInfo | null;
  rateLimitDetails?: StoredRemoteSyncPauseRecord["details"];
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
  db.exec("PRAGMA busy_timeout = 10000");
  runWithBusyRetry(() => {
    const journalModeRow = db.query("PRAGMA journal_mode").get() as {
      journal_mode?: string;
    } | null;
    const journalMode = journalModeRow?.journal_mode?.toLowerCase();
    if (journalMode !== "wal") {
      db.exec("PRAGMA journal_mode = WAL");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  });

  globalStateDb = db;
  return db;
}

function getConfiguredApiKey(): string | null {
  const apiKey = getConfig().api_key?.trim();
  return apiKey ? apiKey : null;
}

function getRemoteSyncPauseKeyPrefix(): string | null {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) {
    return null;
  }

  const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 24);
  return `${GLOBAL_REMOTE_SYNC_PAUSE_KEY_PREFIX}${fingerprint}:`;
}

function getLegacyRemoteSyncPauseKey(): string | null {
  const prefix = getRemoteSyncPauseKeyPrefix();
  if (!prefix) {
    return null;
  }

  return prefix.slice(0, -1);
}

function normalizeEndpointName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function encodeScope(scope: RemoteSyncPauseScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "complexity":
      return "complexity";
    case "endpoint":
      return `endpoint:${scope.endpointName}`;
  }
}

function getPauseKeyForScope(scope: RemoteSyncPauseScope): string | null {
  const prefix = getRemoteSyncPauseKeyPrefix();
  if (!prefix) {
    return null;
  }
  return `${prefix}${encodeScope(scope)}`;
}

function getBackgroundUntil(record: StoredRemoteSyncPauseRecord): string {
  return record.backgroundUntil || record.until;
}

function getStoredUntilMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStoredPauseScope(value: unknown): RemoteSyncPauseScope | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as { kind?: unknown; endpointName?: unknown };
  if (candidate.kind === "global" || candidate.kind === "complexity") {
    return { kind: candidate.kind };
  }
  if (candidate.kind === "endpoint" && typeof candidate.endpointName === "string") {
    const endpointName = normalizeEndpointName(candidate.endpointName);
    if (!endpointName) {
      return null;
    }
    return { kind: "endpoint", endpointName };
  }

  return null;
}

function parseStoredPauseRecord(raw: string): StoredRemoteSyncPauseRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRemoteSyncPauseRecord> & {
      scope?: unknown;
    };
    if (
      (parsed.kind !== "rate_limit" && parsed.kind !== "network") ||
      typeof parsed.until !== "string"
    ) {
      return null;
    }

    const scope = parseStoredPauseScope(parsed.scope) || { kind: "global" as const };
    return {
      kind: parsed.kind,
      scope,
      until: parsed.until,
      backgroundUntil:
        typeof parsed.backgroundUntil === "string" ? parsed.backgroundUntil : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      details:
        parsed.details && typeof parsed.details === "object"
          ? (parsed.details as StoredRemoteSyncPauseRecord["details"])
          : undefined,
    };
  } catch {
    return null;
  }
}

function deletePauseKey(key: string): void {
  const db = getGlobalStateDb();
  runWithBusyRetry(() => {
    db.run("DELETE FROM metadata WHERE key = ?", [key]);
  });
}

function setStoredRemoteSyncPauseRecord(record: StoredRemoteSyncPauseRecord): void {
  const key = getPauseKeyForScope(record.scope);
  if (!key) {
    return;
  }

  const db = getGlobalStateDb();
  runWithBusyRetry(() => {
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [
      key,
      JSON.stringify(record),
    ]);
  });
  clearLegacyRemoteSyncPauseRecord();
}

function clearStoredRemoteSyncPauseRecords(): void {
  const prefix = getRemoteSyncPauseKeyPrefix();
  if (!prefix) {
    clearLegacyRemoteSyncPauseRecord();
    return;
  }

  const db = getGlobalStateDb();
  runWithBusyRetry(() => {
    db.run("DELETE FROM metadata WHERE key LIKE ?", [`${prefix}%`]);
  });

  const legacyKey = getLegacyRemoteSyncPauseKey();
  if (legacyKey) {
    deletePauseKey(legacyKey);
  }
  clearLegacyRemoteSyncPauseRecord();
}

export function clearRemoteSyncPause(): void {
  clearStoredRemoteSyncPauseRecords();
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

function migrateLegacyRemoteSyncPauseRecord(nowMs: number): void {
  const prefix = getRemoteSyncPauseKeyPrefix();
  if (!prefix) {
    return;
  }

  const db = getGlobalStateDb();
  const existing = runWithBusyRetry(
    () =>
      db.query("SELECT key FROM metadata WHERE key LIKE ? LIMIT 1").get(`${prefix}%`) as {
        key: string;
      } | null
  );
  if (existing?.key) {
    clearLegacyRemoteSyncPauseRecord();
    return;
  }

  const legacyKey = getLegacyRemoteSyncPauseKey();
  if (legacyKey) {
    const legacyRow = runWithBusyRetry(
      () =>
        db.query("SELECT value FROM metadata WHERE key = ?").get(legacyKey) as {
          value: string;
        } | null
    );
    if (legacyRow?.value) {
      const legacyRecord = parseStoredPauseRecord(legacyRow.value);
      deletePauseKey(legacyKey);
      if (legacyRecord) {
        setStoredRemoteSyncPauseRecord(legacyRecord);
      }
      return;
    }
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
    scope: { kind: "global" },
    until:
      legacy.kind === "rate_limit"
        ? new Date(Math.min(legacyUntilMs, nowMs + DEFAULT_RATE_LIMIT_PROBE_MS)).toISOString()
        : legacy.until,
    backgroundUntil: legacy.until,
    message: legacy.message,
  });
}

function listStoredPauseRows(): Array<{ key: string; value: string }> {
  const prefix = getRemoteSyncPauseKeyPrefix();
  if (!prefix) {
    return [];
  }

  const db = getGlobalStateDb();
  return runWithBusyRetry(
    () =>
      db
        .query("SELECT key, value FROM metadata WHERE key LIKE ? ORDER BY key ASC")
        .all(`${prefix}%`) as Array<{ key: string; value: string }>
  );
}

function pauseSortWeight(pause: StoredRemoteSyncPauseRecord | ActiveRemoteSyncPause): number {
  if (pause.kind === "network") {
    return 0;
  }
  switch (pause.scope.kind) {
    case "global":
      return 1;
    case "complexity":
      return 2;
    case "endpoint":
      return 3;
  }
}

function sortPauses<T extends StoredRemoteSyncPauseRecord | ActiveRemoteSyncPause>(
  pauses: T[]
): T[] {
  return pauses.sort((left, right) => {
    const weight = pauseSortWeight(left) - pauseSortWeight(right);
    if (weight !== 0) {
      return weight;
    }

    const leftUntil = getStoredUntilMs(left.until) || Number.POSITIVE_INFINITY;
    const rightUntil = getStoredUntilMs(right.until) || Number.POSITIVE_INFINITY;
    return leftUntil - rightUntil;
  });
}

function getStoredRemoteSyncPauseRecords(
  nowMs: number = Date.now()
): Array<StoredRemoteSyncPauseRecord> {
  migrateLegacyRemoteSyncPauseRecord(nowMs);

  const records: StoredRemoteSyncPauseRecord[] = [];
  for (const row of listStoredPauseRows()) {
    const parsed = parseStoredPauseRecord(row.value);
    if (!parsed) {
      deletePauseKey(row.key);
      continue;
    }

    const normalized = normalizeStoredRateLimitPauseRecord(parsed, nowMs);
    if (
      normalized.until !== parsed.until ||
      normalized.backgroundUntil !== parsed.backgroundUntil ||
      JSON.stringify(normalized.scope) !== JSON.stringify(parsed.scope)
    ) {
      setStoredRemoteSyncPauseRecord(normalized);
    }

    const untilMs = getStoredUntilMs(normalized.until);
    const backgroundUntilMs = getStoredUntilMs(getBackgroundUntil(normalized));
    const commandActive = untilMs !== null && untilMs > nowMs;
    const backgroundActive = backgroundUntilMs !== null && backgroundUntilMs > nowMs;
    if (!commandActive && !backgroundActive) {
      deletePauseKey(row.key);
      continue;
    }

    records.push({
      ...normalized,
      backgroundUntil: getBackgroundUntil(normalized),
    });
  }

  return sortPauses(records);
}

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

export function getActiveRemoteSyncPauses(nowMs: number = Date.now()): ActiveRemoteSyncPause[] {
  const pauses = getStoredRemoteSyncPauseRecords(nowMs)
    .map((record) => toActivePause(record, record.until, nowMs))
    .filter((pause): pause is ActiveRemoteSyncPause => pause !== null);
  return sortPauses(pauses);
}

export function getAutomaticRemoteSyncPauses(nowMs: number = Date.now()): ActiveRemoteSyncPause[] {
  const pauses = getStoredRemoteSyncPauseRecords(nowMs)
    .map((record) => toActivePause(record, getBackgroundUntil(record), nowMs))
    .filter((pause): pause is ActiveRemoteSyncPause => pause !== null);
  return sortPauses(pauses);
}

function pauseAppliesToEndpoints(
  pause: StoredRemoteSyncPauseRecord | ActiveRemoteSyncPause,
  endpointNames: string[]
): boolean {
  if (pause.kind === "network") {
    return true;
  }

  switch (pause.scope.kind) {
    case "global":
    case "complexity":
      return true;
    case "endpoint": {
      if (endpointNames.length === 0) {
        return false;
      }
      const normalizedTargets = endpointNames
        .map((value) => normalizeEndpointName(value))
        .filter((value): value is string => Boolean(value));
      return normalizedTargets.includes(pause.scope.endpointName);
    }
  }
}

function getFirstMatchingPause(
  pauses: ActiveRemoteSyncPause[],
  endpointNames: string[]
): ActiveRemoteSyncPause | null {
  return pauses.find((pause) => pauseAppliesToEndpoints(pause, endpointNames)) || null;
}

export function getActiveRemoteSyncPause(nowMs: number = Date.now()): ActiveRemoteSyncPause | null {
  return getActiveRemoteSyncPauses(nowMs)[0] || null;
}

export function getAutomaticRemoteSyncPause(
  nowMs: number = Date.now()
): ActiveRemoteSyncPause | null {
  return getAutomaticRemoteSyncPauses(nowMs)[0] || null;
}

export function getActiveRemoteSyncPauseForEndpoints(
  endpointNames: string[],
  nowMs: number = Date.now()
): ActiveRemoteSyncPause | null {
  return getFirstMatchingPause(getActiveRemoteSyncPauses(nowMs), endpointNames);
}

export function getAutomaticRemoteSyncPauseForEndpoints(
  endpointNames: string[],
  nowMs: number = Date.now()
): ActiveRemoteSyncPause | null {
  return getFirstMatchingPause(getAutomaticRemoteSyncPauses(nowMs), endpointNames);
}

export function getBlockingActiveRemoteSyncPause(
  nowMs: number = Date.now()
): ActiveRemoteSyncPause | null {
  return getActiveRemoteSyncPauses(nowMs).find((pause) => pause.scope.kind !== "endpoint") || null;
}

export function getBlockingAutomaticRemoteSyncPause(
  nowMs: number = Date.now()
): ActiveRemoteSyncPause | null {
  return (
    getAutomaticRemoteSyncPauses(nowMs).find((pause) => pause.scope.kind !== "endpoint") || null
  );
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
    normalized.includes("usage limit exceeded") ||
    normalized.includes("ratelimited") ||
    normalized.includes('"code":"ratelimited"') ||
    normalized.includes('"type":"ratelimited"') ||
    normalized.includes("x-ratelimit-requests-") ||
    normalized.includes("x-ratelimit-endpoint-requests-") ||
    normalized.includes("x-ratelimit-complexity-")
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

function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function extractHeaders(headers: unknown): Record<string, string> {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string> = {};
  const append = (key: string, value: unknown): void => {
    if (typeof key !== "string") {
      return;
    }
    const normalizedKey = key.toLowerCase();
    const normalizedValue = typeof value === "string" ? value : String(value);
    if (!normalizedValue) {
      return;
    }
    normalized[normalizedKey] = normalizedValue;
  };

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => append(key, value));
    return normalized;
  }

  if (
    typeof headers === "object" &&
    headers !== null &&
    "forEach" in headers &&
    typeof (headers as { forEach?: unknown }).forEach === "function"
  ) {
    (headers as { forEach: (cb: (value: string, key: string) => void) => void }).forEach(
      (value, key) => append(key, value)
    );
    return normalized;
  }

  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length >= 2) {
        append(String(entry[0]), entry[1]);
      }
    }
    return normalized;
  }

  if (typeof headers === "object" && headers !== null) {
    for (const [key, value] of Object.entries(headers)) {
      append(key, value);
    }
  }

  return normalized;
}

function mergeHeaderBags(...bags: Array<Record<string, string>>): Record<string, string> {
  return lowerCaseKeys(Object.assign({}, ...bags));
}

function extractHeaderValueFromMessage(message: string, headerName: string): string | undefined {
  const escaped = headerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = message.match(
    new RegExp(`["']?${escaped}["']?\\s*[:=]\\s*["']?([^"',}\\]\\s]+)`, "i")
  );
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

function extractEndpointNameFromMessage(message: string): string | undefined {
  const endpointHeader = extractHeaderValueFromMessage(message, "x-ratelimit-endpoint-name");
  if (endpointHeader) {
    return normalizeEndpointName(endpointHeader);
  }

  const pathMatch = message.match(/["']path["']\s*:\s*\[\s*["']([A-Za-z][A-Za-z0-9_]*)["']/i);
  return normalizeEndpointName(pathMatch?.[1]);
}

function extractHeadersFromError(error: unknown): Record<string, string> {
  if (!error || typeof error !== "object") {
    return {};
  }

  const candidate = error as {
    response?: { headers?: unknown };
    headers?: unknown;
  };

  return mergeHeaderBags(
    extractHeaders(candidate.headers),
    extractHeaders(candidate.response?.headers)
  );
}

function extractErrorInfo(error: unknown): ExtractedErrorInfo {
  const apiError = getLinearApiErrorInfo(error);
  const message =
    apiError?.graphqlErrors
      .map((entry) => entry.message)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" | ") ||
    apiError?.body ||
    normalizeErrorMessage(error);
  const rateLimit = apiError?.rateLimit || null;
  const messageHeaders = lowerCaseKeys({
    "retry-after": extractHeaderValueFromMessage(message, "retry-after") || "",
    "x-ratelimit-requests-reset":
      extractHeaderValueFromMessage(message, "x-ratelimit-requests-reset") || "",
    "x-ratelimit-endpoint-requests-reset":
      extractHeaderValueFromMessage(message, "x-ratelimit-endpoint-requests-reset") || "",
    "x-ratelimit-complexity-reset":
      extractHeaderValueFromMessage(message, "x-ratelimit-complexity-reset") || "",
    "x-ratelimit-endpoint-name":
      extractHeaderValueFromMessage(message, "x-ratelimit-endpoint-name") || "",
  });
  const headers = mergeHeaderBags(apiError?.headers || {}, extractHeadersFromError(error), messageHeaders);
  const endpointName =
    rateLimit?.endpointName ||
    normalizeEndpointName(headers["x-ratelimit-endpoint-name"]) ||
    extractEndpointNameFromMessage(message);
  const fallbackRateLimited = !rateLimit && isRateLimitErrorMessage(message);
  const complexityLimited =
    rateLimit?.bucketKind === "complexity" ||
    (fallbackRateLimited && message.toLowerCase().includes("complexity"));
  const rateLimitDetails = rateLimit
    ? {
        bucketKind: rateLimit.bucketKind,
        endpointName: rateLimit.endpointName,
        retryAfterMs: rateLimit.retryAfterMs,
        resetAtMs: rateLimit.resetAtMs,
        durationMs: rateLimit.durationMs,
        limit: rateLimit.limit,
        remaining: rateLimit.remaining,
        requested: rateLimit.requested,
      }
    : undefined;

  return {
    message,
    headers,
    endpointName,
    rateLimited: Boolean(rateLimit) || fallbackRateLimited,
    complexityLimited,
    networkError: isNetworkErrorMessage(message),
    rateLimit,
    rateLimitDetails,
  };
}

function parseResetHeaderMs(value: string | undefined, nowMs: number): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > nowMs) {
    return parsed - nowMs;
  }
  return null;
}

function extractRetryAfterMs(info: ExtractedErrorInfo, nowMs: number): number | null {
  if (info.rateLimit?.resetAtMs && info.rateLimit.resetAtMs > nowMs) {
    return info.rateLimit.resetAtMs - nowMs;
  }

  if (info.rateLimit?.retryAfterMs && info.rateLimit.retryAfterMs > 0) {
    return info.rateLimit.retryAfterMs;
  }

  const headerNames = info.complexityLimited
    ? ["x-ratelimit-complexity-reset", "x-ratelimit-requests-reset"]
    : info.endpointName
      ? [
          "x-ratelimit-endpoint-requests-reset",
          "x-ratelimit-requests-reset",
          "x-ratelimit-complexity-reset",
        ]
      : ["x-ratelimit-requests-reset", "x-ratelimit-complexity-reset"];

  for (const headerName of headerNames) {
    const value = parseResetHeaderMs(info.headers[headerName], nowMs);
    if (value && value > 0) {
      return value;
    }
  }

  const retryAfterHeader = info.headers["retry-after"];
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  const retryAfterMatch = info.message.match(/["']?retry-?after["']?\s*[:=]\s*["']?(\d{1,10})/i);
  if (retryAfterMatch) {
    const seconds = Number.parseInt(retryAfterMatch[1], 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  return null;
}

function extractRateLimitMeta(message: string): {
  durationMs?: number;
  limit?: number;
  remaining?: number;
  requested?: number;
  resetAtMs?: number;
  retryAfterMs?: number;
  endpointName?: string;
} {
  const durationMatch = message.match(/["']duration["']\s*:\s*(\d{1,12})/i);
  const limitMatch = message.match(/["']limit["']\s*:\s*(\d{1,12})/i);
  const remainingMatch = message.match(/["']remaining["']\s*:\s*(\d{1,12})/i);
  const requestedMatch = message.match(/["']requested["']\s*:\s*(\d{1,12})/i);
  const resetMatch = message.match(
    /["']?x-ratelimit-(?:endpoint-requests|requests|complexity)-reset["']?\s*[:=]\s*["']?(\d{10,16})/i
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
    endpointName: extractEndpointNameFromMessage(message),
  };
}

function computeRateLimitAutomaticPauseMs(info: ExtractedErrorInfo, nowMs: number): number {
  return extractRetryAfterMs(info, nowMs) || DEFAULT_RATE_LIMIT_PAUSE_MS;
}

function computeRateLimitProbeMs(info: ExtractedErrorInfo, nowMs: number): number {
  const meta = info.rateLimitDetails || extractRateLimitMeta(info.message);
  if (meta.durationMs && meta.limit && meta.limit > 0) {
    const requested = Math.max(1, meta.requested || 1);
    const msPerToken = meta.durationMs / meta.limit;
    const conservativeProbeMs = Math.ceil(msPerToken * requested * 20);
    return Math.min(
      MAX_RATE_LIMIT_PROBE_MS,
      Math.max(DEFAULT_RATE_LIMIT_PROBE_MS, conservativeProbeMs)
    );
  }

  const retryAfterMs = extractRetryAfterMs(info, nowMs);
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.min(MAX_RATE_LIMIT_PROBE_MS, Math.max(DEFAULT_RATE_LIMIT_PROBE_MS, retryAfterMs));
  }

  return DEFAULT_RATE_LIMIT_PROBE_MS;
}

function derivePauseScope(info: ExtractedErrorInfo): RemoteSyncPauseScope {
  if (info.rateLimit?.bucketKind === "complexity") {
    return { kind: "complexity" };
  }

  if (info.rateLimit?.bucketKind === "endpoint" && info.rateLimit.endpointName) {
    return { kind: "endpoint", endpointName: info.rateLimit.endpointName };
  }

  if (info.complexityLimited) {
    return { kind: "complexity" };
  }

  if (info.endpointName) {
    return { kind: "endpoint", endpointName: info.endpointName };
  }

  return { kind: "global" };
}

function buildPauseRecord(error: unknown, nowMs: number): ActiveRemoteSyncPause | null {
  const info = extractErrorInfo(error);

  if (info.rateLimited) {
    const retryAfterMs = computeRateLimitProbeMs(info, nowMs);
    const backgroundRetryAfterMs = computeRateLimitAutomaticPauseMs(info, nowMs);
    return {
      kind: "rate_limit",
      scope: derivePauseScope(info),
      until: new Date(nowMs + retryAfterMs).toISOString(),
      backgroundUntil: new Date(nowMs + backgroundRetryAfterMs).toISOString(),
      retryAfterMs,
      backgroundRetryAfterMs,
      message: normalizeForDisplay(info.message),
      details: info.rateLimitDetails,
    };
  }

  if (info.networkError) {
    return {
      kind: "network",
      scope: { kind: "global" },
      until: new Date(nowMs + DEFAULT_NETWORK_PAUSE_MS).toISOString(),
      backgroundUntil: new Date(nowMs + DEFAULT_NETWORK_PAUSE_MS).toISOString(),
      retryAfterMs: DEFAULT_NETWORK_PAUSE_MS,
      backgroundRetryAfterMs: DEFAULT_NETWORK_PAUSE_MS,
      message: normalizeForDisplay(info.message),
      details: undefined,
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

function getStoredPauseForScope(
  scope: RemoteSyncPauseScope,
  nowMs: number
): StoredRemoteSyncPauseRecord | null {
  return (
    getStoredRemoteSyncPauseRecords(nowMs).find(
      (record) => encodeScope(record.scope) === encodeScope(scope)
    ) || null
  );
}

export function recordRemoteSyncPause(
  error: unknown,
  nowMs: number = Date.now()
): ActiveRemoteSyncPause | null {
  const next = buildPauseRecord(error, nowMs);
  if (!next) {
    return null;
  }

  const current = getStoredPauseForScope(next.scope, nowMs);
  const merged: StoredRemoteSyncPauseRecord = current
      ? {
          kind: next.kind,
          scope: next.scope,
          until: clampActiveUntil(current.until, next.until, nowMs),
          backgroundUntil: clampActiveUntil(getBackgroundUntil(current), next.backgroundUntil, nowMs),
          message: next.message,
          details: next.details,
        }
      : {
          kind: next.kind,
          scope: next.scope,
          until: next.until,
          backgroundUntil: next.backgroundUntil,
          message: next.message,
          details: next.details,
        };

  setStoredRemoteSyncPauseRecord(merged);

  const active = getActiveRemoteSyncPauseForEndpoints(
    next.scope.kind === "endpoint" ? [next.scope.endpointName] : [],
    nowMs
  );
  if (active && encodeScope(active.scope) === encodeScope(next.scope)) {
    return active;
  }

  return (
    getAutomaticRemoteSyncPauseForEndpoints(
      next.scope.kind === "endpoint" ? [next.scope.endpointName] : [],
      nowMs
    ) || null
  );
}

export async function getCommandRemoteSyncPause(): Promise<ActiveRemoteSyncPause | null> {
  const nowMs = Date.now();
  const blockingPause = getBlockingActiveRemoteSyncPause(nowMs);
  if (blockingPause) {
    return blockingPause;
  }

  const storedBroadPause = getStoredRemoteSyncPauseRecords(nowMs).find(
    (pause) => pause.scope.kind !== "endpoint"
  );
  if (!storedBroadPause) {
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
      const pause = recordRemoteSyncPause(
        getLinearApiErrorInfoFromResponse({
          status: response.status,
          headers: response.headers,
          body,
        })
      );
      return pause && pause.scope.kind !== "endpoint"
        ? pause
        : getBlockingActiveRemoteSyncPause() || getBlockingAutomaticRemoteSyncPause() || null;
    }

    let parsed: { errors?: unknown[] } | null = null;
    try {
      parsed = JSON.parse(body) as { errors?: unknown[] };
    } catch {
      parsed = null;
    }

    if (parsed?.errors && parsed.errors.length > 0) {
      const pause = recordRemoteSyncPause(
        getLinearApiErrorInfoFromResponse({
          status: response.status,
          headers: response.headers,
          body,
          errors: parsed.errors as Array<{
            message?: string;
            extensions?: Record<string, unknown>;
          }>,
        })
      );
      return pause && pause.scope.kind !== "endpoint"
        ? pause
        : getBlockingActiveRemoteSyncPause() || getBlockingAutomaticRemoteSyncPause() || null;
    }

    const endpointPauses = getStoredRemoteSyncPauseRecords().filter(
      (pause) => pause.scope.kind === "endpoint"
    );
    clearStoredRemoteSyncPauseRecords();
    for (const pause of endpointPauses) {
      setStoredRemoteSyncPauseRecord(pause);
    }
    return null;
  } catch (error) {
    const pause = recordRemoteSyncPause(error);
    return pause && pause.scope.kind !== "endpoint"
      ? pause
      : getBlockingActiveRemoteSyncPause() || getBlockingAutomaticRemoteSyncPause() || null;
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

function describePauseScope(pause: ActiveRemoteSyncPause): string {
  if (pause.kind === "network") {
    return "all remote work";
  }

  switch (pause.scope.kind) {
    case "global":
      return "all Linear requests";
    case "complexity":
      return "high-complexity Linear requests";
    case "endpoint":
      return `${pause.scope.endpointName} requests`;
  }
}

function formatRateLimitDetails(pause: ActiveRemoteSyncPause): string | null {
  if (pause.kind !== "rate_limit" || !pause.message) {
    return null;
  }

  const meta = pause.details || extractRateLimitMeta(pause.message);
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
  if (meta.endpointName || pause.scope.kind === "endpoint") {
    const endpointName =
      meta.endpointName || (pause.scope.kind === "endpoint" ? pause.scope.endpointName : undefined);
    if (endpointName) {
      bucketParts.push(`endpoint ${endpointName.trim()}`);
    }
  } else if (pause.scope.kind === "complexity") {
    bucketParts.push("complexity bucket");
  } else {
    bucketParts.push("global request bucket");
  }
  if (meta.remaining !== undefined && meta.limit !== undefined) {
    bucketParts.push(`${meta.remaining}/${meta.limit} remaining`);
  } else if (meta.limit !== undefined) {
    bucketParts.push(`limit ${meta.limit}`);
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
    retryParts.push(
      `reset header ${formatPauseUntilLocal(new Date(meta.resetAtMs).toISOString())}`
    );
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
  const scope = describePauseScope(pause);
  const summary = `${prefix} ${scope} ${pause.kind === "network" ? "is" : "are"} paused until ${formatPauseUntilLocal(
    pause.until
  )} (${formatPauseDuration(pause.retryAfterMs)}) after ${cause}.`;
  const details = formatRateLimitDetails(pause);
  const suffix =
    pause.scope.kind === "endpoint"
      ? " Other Linear operations may still continue."
      : " Local cache and queued writes are still available.";
  return details ? `${summary}${suffix}\n  ${details}` : `${summary}${suffix}`;
}
