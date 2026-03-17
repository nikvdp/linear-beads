import {
  clearRemoteSyncPauseRecord,
  getRemoteSyncPauseRecord,
  setRemoteSyncPauseRecord,
  type RemoteSyncPauseRecord,
} from "./database.js";

const DEFAULT_RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
const DEFAULT_NETWORK_PAUSE_MS = 30 * 1000;

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
  const retryAfterMatch = message.match(/["']?retry-?after["']?\s*[:=]\s*["']?(\d{1,10})/i);
  if (retryAfterMatch) {
    const seconds = Number.parseInt(retryAfterMatch[1], 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  const resetMatch = message.match(
    /["']?x-ratelimit-requests-reset["']?\s*[:=]\s*["']?(\d{10,16})/i
  );
  if (resetMatch) {
    const resetAtMs = Number.parseInt(resetMatch[1], 10);
    if (Number.isFinite(resetAtMs) && resetAtMs > nowMs) {
      return resetAtMs - nowMs;
    }
  }

  return null;
}

export type ActiveRemoteSyncPause = RemoteSyncPauseRecord & {
  retryAfterMs: number;
};

export function getActiveRemoteSyncPause(nowMs: number = Date.now()): ActiveRemoteSyncPause | null {
  const record = getRemoteSyncPauseRecord();
  if (!record) {
    return null;
  }

  const untilMs = Date.parse(record.until);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
    clearRemoteSyncPauseRecord();
    return null;
  }

  return {
    ...record,
    retryAfterMs: untilMs - nowMs,
  };
}

function buildPauseRecord(error: unknown, nowMs: number): ActiveRemoteSyncPause | null {
  const message = normalizeErrorMessage(error);

  if (isRateLimitErrorMessage(message)) {
    const retryAfterMs = extractRetryAfterMs(message, nowMs) || DEFAULT_RATE_LIMIT_PAUSE_MS;
    return {
      kind: "rate_limit",
      until: new Date(nowMs + retryAfterMs).toISOString(),
      retryAfterMs,
      message: normalizeForDisplay(message),
    };
  }

  if (isNetworkErrorMessage(message)) {
    return {
      kind: "network",
      until: new Date(nowMs + DEFAULT_NETWORK_PAUSE_MS).toISOString(),
      retryAfterMs: DEFAULT_NETWORK_PAUSE_MS,
      message: normalizeForDisplay(message),
    };
  }

  return null;
}

export function recordRemoteSyncPause(
  error: unknown,
  nowMs: number = Date.now()
): ActiveRemoteSyncPause | null {
  const next = buildPauseRecord(error, nowMs);
  if (!next) {
    return null;
  }

  const current = getActiveRemoteSyncPause(nowMs);
  if (current) {
    const currentUntilMs = Date.parse(current.until);
    const nextUntilMs = Date.parse(next.until);
    if (Number.isFinite(currentUntilMs) && currentUntilMs >= nextUntilMs) {
      return current;
    }
  }

  setRemoteSyncPauseRecord({
    kind: next.kind,
    until: next.until,
    message: next.message,
  });
  return next;
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

export function formatRemoteSyncPauseNotice(
  pause: ActiveRemoteSyncPause,
  options: { prefix?: string } = {}
): string {
  const prefix = options.prefix || "Warning:";
  const cause = pause.kind === "rate_limit" ? "Linear rate limit" : "network failure";
  return `${prefix} remote sync is paused until ${pause.until} (${formatPauseDuration(
    pause.retryAfterMs
  )}) after ${cause}. Local cache and queued writes are still available.`;
}
