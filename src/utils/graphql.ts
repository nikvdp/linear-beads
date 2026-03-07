/**
 * GraphQL client for Linear API
 */

import { GraphQLClient } from "graphql-request";
import { getApiKey } from "./config.js";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const LINEAR_DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const LINEAR_DEFAULT_MAX_RETRIES = 5;
const LINEAR_DEFAULT_RETRY_BASE_MS = 500;
const LINEAR_DEFAULT_JITTER_RATIO = 0.2;
const TIMEOUT_ABORT_REASON = "lb-linear-request-timeout";

let client: GraphQLClient | null = null;

export type LinearRequestPolicy = {
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  jitterRatio: number;
};

type LinearFetchOptions = {
  baseFetch?: typeof fetch;
  policy?: LinearRequestPolicy;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseFloatInRange(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function getLinearRequestPolicy(env: NodeJS.ProcessEnv = process.env): LinearRequestPolicy {
  return {
    timeoutMs: parsePositiveInt(
      env.LB_LINEAR_REQUEST_TIMEOUT_MS,
      LINEAR_DEFAULT_REQUEST_TIMEOUT_MS
    ),
    maxRetries: parsePositiveInt(env.LB_LINEAR_MAX_RETRIES, LINEAR_DEFAULT_MAX_RETRIES),
    retryBaseMs: parsePositiveInt(env.LB_LINEAR_RETRY_BASE_MS, LINEAR_DEFAULT_RETRY_BASE_MS),
    jitterRatio: parseFloatInRange(
      env.LB_LINEAR_RETRY_JITTER_RATIO,
      LINEAR_DEFAULT_JITTER_RATIO,
      0,
      1
    ),
  };
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function parseRetryAfterMs(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) return null;
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) return null;

  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const diff = date - Date.now();
  return diff > 0 ? diff : 0;
}

export function computeRetryDelayMs(retryNumber: number, retryBaseMs: number): number {
  if (retryNumber <= 2) {
    return retryBaseMs;
  }
  return retryBaseMs * 2 ** (retryNumber - 2);
}

function applyJitter(delayMs: number, jitterRatio: number, random: () => number): number {
  if (delayMs <= 0 || jitterRatio <= 0) return delayMs;
  const jitterScale = 1 + (random() * 2 - 1) * jitterRatio;
  return Math.max(0, Math.round(delayMs * jitterScale));
}

function isTimeoutAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(TIMEOUT_ABORT_REASON);
}

function isRetryableNetworkError(error: unknown): boolean {
  if (isTimeoutAbort(error)) return true;
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("etimedout") ||
    msg.includes("connection reset") ||
    msg.includes("socket hang up") ||
    msg.includes("unable to connect")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withAttemptSignal(
  init: RequestInit,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const upstream = init.signal;
  const controller = new AbortController();
  let timedOut = false;

  const onUpstreamAbort = (): void => {
    controller.abort(upstream?.reason || new Error("aborted"));
  };

  if (upstream) {
    if (upstream.aborted) {
      onUpstreamAbort();
    } else {
      upstream.addEventListener("abort", onUpstreamAbort, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(TIMEOUT_ABORT_REASON));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      if (upstream) {
        upstream.removeEventListener("abort", onUpstreamAbort);
      }
    },
    didTimeout: () => timedOut,
  };
}

export async function linearFetchWithRetry(
  input: string | URL | Request,
  init: RequestInit = {},
  options: LinearFetchOptions = {}
): Promise<Response> {
  const baseFetch = options.baseFetch || fetch;
  const policy = options.policy || getLinearRequestPolicy();
  const sleepFn = options.sleep || sleep;
  const random = options.random || Math.random;

  let retryNumber = 0;

  while (true) {
    const attempt = withAttemptSignal(init, policy.timeoutMs);
    try {
      const response = await baseFetch(input, {
        ...init,
        signal: attempt.signal,
      });
      attempt.cleanup();

      if (!isRetryableHttpStatus(response.status)) {
        return response;
      }

      if (retryNumber >= policy.maxRetries) {
        return response;
      }

      retryNumber += 1;
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const scheduledDelay = computeRetryDelayMs(retryNumber, policy.retryBaseMs);
      const delayWithJitter = applyJitter(scheduledDelay, policy.jitterRatio, random);
      const delayMs =
        retryAfterMs !== null ? Math.max(delayWithJitter, retryAfterMs) : delayWithJitter;
      await sleepFn(delayMs);
      continue;
    } catch (error) {
      const timedOut = attempt.didTimeout();
      attempt.cleanup();

      if (init.signal?.aborted && !timedOut) {
        throw error;
      }

      if (!isRetryableNetworkError(error) || retryNumber >= policy.maxRetries) {
        throw error;
      }

      retryNumber += 1;
      const scheduledDelay = computeRetryDelayMs(retryNumber, policy.retryBaseMs);
      const delayMs = applyJitter(scheduledDelay, policy.jitterRatio, random);
      await sleepFn(delayMs);
    }
  }
}

/**
 * Get GraphQL client singleton
 */
export function getGraphQLClient(): GraphQLClient {
  if (!client) {
    const apiKey = getApiKey();
    client = new GraphQLClient(LINEAR_ENDPOINT, {
      headers: {
        Authorization: apiKey,
      },
      fetch: (input, init) => linearFetchWithRetry(input, init || {}),
    });
  }
  return client;
}

/**
 * Reset client (useful for testing or key changes)
 */
export function resetGraphQLClient(): void {
  client = null;
}

// Common GraphQL fragments
export const ISSUE_FRAGMENT = `
  id
  identifier
  title
  description
  priority
  createdAt
  updatedAt
  completedAt
  canceledAt
  state {
    id
    name
    type
  }
  labels {
    nodes {
      id
      name
    }
  }
  assignee {
    id
    email
    name
  }
  parent {
    id
    identifier
  }
`;

export const ISSUE_WITH_RELATIONS_FRAGMENT = `
  ${ISSUE_FRAGMENT}
  children {
    nodes {
      id
      identifier
    }
  }
  relations {
    nodes {
      id
      type
      relatedIssue {
        id
        identifier
      }
    }
  }
  inverseRelations {
    nodes {
      id
      type
      issue {
        id
        identifier
      }
    }
  }
`;
