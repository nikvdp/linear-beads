import {
  clearRemoteSyncPauseRecord,
  getRemoteSyncPauseRecord,
  setRemoteSyncPauseRecord,
  type RemoteSyncPauseRecord,
} from "./database.js";
import { getApiKey } from "./config.js";
import { getLinearRequestPolicy, linearFetchWithRetry } from "./graphql.js";

const DEFAULT_RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
const DEFAULT_NETWORK_PAUSE_MS = 30 * 1000;
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

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
    if (Number.isFinite(currentUntilMs) && Number.isFinite(nextUntilMs)) {
      const clampedUntilMs = Math.min(currentUntilMs, nextUntilMs);
      if (clampedUntilMs === currentUntilMs) {
        return current;
      }

      const clamped: ActiveRemoteSyncPause = {
        ...next,
        until: new Date(clampedUntilMs).toISOString(),
        retryAfterMs: Math.max(0, clampedUntilMs - nowMs),
      };
      setRemoteSyncPauseRecord({
        kind: clamped.kind,
        until: clamped.until,
        message: clamped.message,
      });
      return clamped;
    }
  }

  setRemoteSyncPauseRecord({
    kind: next.kind,
    until: next.until,
    message: next.message,
  });
  return next;
}

export async function getCommandRemoteSyncPause(): Promise<ActiveRemoteSyncPause | null> {
  const currentPause = getActiveRemoteSyncPause();
  if (!currentPause) {
    return null;
  }

  try {
    const policy = getLinearRequestPolicy();
    const response = await linearFetchWithRetry(
      LINEAR_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: getApiKey(),
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
      return pause || getActiveRemoteSyncPause() || currentPause;
    }

    let parsed: { errors?: unknown[] } | null = null;
    try {
      parsed = JSON.parse(body) as { errors?: unknown[] };
    } catch {
      parsed = null;
    }

    if (parsed?.errors && parsed.errors.length > 0) {
      const pause = recordRemoteSyncPause(body);
      return pause || getActiveRemoteSyncPause() || currentPause;
    }

    clearRemoteSyncPauseRecord();
    return null;
  } catch (error) {
    const pause = recordRemoteSyncPause(error);
    return pause || getActiveRemoteSyncPause() || currentPause;
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

export function formatRemoteSyncPauseNotice(
  pause: ActiveRemoteSyncPause,
  options: { prefix?: string } = {}
): string {
  const prefix = options.prefix || "Warning:";
  const cause = pause.kind === "rate_limit" ? "Linear rate limit" : "network failure";
  return `${prefix} remote sync is paused until ${formatPauseUntilLocal(
    pause.until
  )} (${formatPauseDuration(pause.retryAfterMs)}) after ${cause}. Local cache and queued writes are still available.`;
}
