/**
 * GraphQL client for Linear API
 */

import { ClientError, GraphQLClient } from "graphql-request";
import { getApiKey } from "./config.js";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const LINEAR_DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const LINEAR_DEFAULT_MAX_RETRIES = 5;
const LINEAR_DEFAULT_RETRY_BASE_MS = 500;
const LINEAR_DEFAULT_JITTER_RATIO = 0.2;
const LINEAR_DEFAULT_PAGINATION_MAX_PAGES = 2000;
const LINEAR_DEFAULT_PAGINATION_MAX_DURATION_MS = 120000;
const TIMEOUT_ABORT_REASON = "lb-linear-request-timeout";

let client: GraphQLClient | null = null;

export type LinearRequestPolicy = {
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  jitterRatio: number;
};

export type LinearPaginationPolicy = {
  maxPages: number;
  maxDurationMs: number;
};

export type LinearPageInfo = {
  hasNextPage: boolean;
  endCursor?: string | null;
};

export type LinearRateLimitBucketKind = "global" | "endpoint" | "complexity";
export type LinearRateLimitDiagnosis = "free_tier_issue_limit";

export type LinearGraphQLErrorInfo = {
  message?: string;
  extensions?: Record<string, unknown>;
  path?: Array<string | number>;
};

export type LinearRateLimitErrorInfo = {
  bucketKind: LinearRateLimitBucketKind;
  endpointName?: string;
  retryAfterMs?: number;
  resetAtMs?: number;
  durationMs?: number;
  limit?: number;
  remaining?: number;
  requested?: number;
  diagnosis?: LinearRateLimitDiagnosis;
  headers: Record<string, string>;
  graphqlErrors: LinearGraphQLErrorInfo[];
  status: number;
  body: string;
};

export type LinearApiErrorInfo = {
  status: number;
  headers: Record<string, string>;
  graphqlErrors: LinearGraphQLErrorInfo[];
  body: string;
  rateLimit?: LinearRateLimitErrorInfo;
};

type LinearPaginationGuardOptions = {
  policy?: LinearPaginationPolicy;
  now?: () => number;
};

type LinearFetchOptions = {
  baseFetch?: typeof fetch;
  policy?: LinearRequestPolicy;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

type GraphQLResponseLike = {
  status?: number;
  headers?: Headers | Record<string, string>;
  body?: string;
  errors?: Array<{
    message?: string;
    extensions?: Record<string, unknown>;
    path?: Array<string | number>;
  }>;
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

export function getLinearPaginationPolicy(
  env: NodeJS.ProcessEnv = process.env
): LinearPaginationPolicy {
  return {
    maxPages: parsePositiveInt(
      env.LB_LINEAR_PAGINATION_MAX_PAGES,
      LINEAR_DEFAULT_PAGINATION_MAX_PAGES
    ),
    maxDurationMs: parsePositiveInt(
      env.LB_LINEAR_PAGINATION_MAX_DURATION_MS,
      LINEAR_DEFAULT_PAGINATION_MAX_DURATION_MS
    ),
  };
}

export function createLinearPaginationGuard(
  context: string,
  options: LinearPaginationGuardOptions = {}
): {
  nextCursor: (pageInfo: LinearPageInfo, requestCursor?: string | null) => string | null;
} {
  const policy = options.policy || getLinearPaginationPolicy();
  const now = options.now || Date.now;
  const startedAt = now();
  const seenCursors = new Set<string>();
  let pageCount = 0;

  const fail = (reason: string): never => {
    throw new Error(`Linear pagination guard (${context}): ${reason}`);
  };

  return {
    nextCursor: (pageInfo: LinearPageInfo, requestCursor?: string | null): string | null => {
      pageCount += 1;
      if (pageCount > policy.maxPages) {
        fail(`exceeded max pages (${policy.maxPages})`);
      }

      const elapsedMs = now() - startedAt;
      if (elapsedMs > policy.maxDurationMs) {
        fail(`exceeded max duration (${policy.maxDurationMs}ms)`);
      }

      if (!pageInfo.hasNextPage) {
        return null;
      }

      const endCursor = typeof pageInfo.endCursor === "string" ? pageInfo.endCursor.trim() : "";
      if (!endCursor) {
        fail("received hasNextPage=true with missing endCursor");
      }

      const normalizedRequestCursor = typeof requestCursor === "string" ? requestCursor.trim() : "";
      if (normalizedRequestCursor && normalizedRequestCursor === endCursor) {
        fail(`cursor stalled at '${endCursor}'`);
      }

      if (seenCursors.has(endCursor)) {
        fail(`cursor repeated without progress ('${endCursor}')`);
      }

      seenCursors.add(endCursor);
      return endCursor;
    },
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

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return value?.trim() || undefined;
}

function headersToRecord(
  headers: Headers | Record<string, string> | undefined
): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const entries = Array.from(headers.entries()).map(([key, value]) => [key.toLowerCase(), value]);
    return Object.fromEntries(entries);
  }

  if (typeof headers === "object") {
    const entries = Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]);
    return Object.fromEntries(entries);
  }

  return {};
}

function parseResetHeaderMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toGraphQLErrorInfo(
  errors: GraphQLResponseLike["errors"] | undefined
): LinearGraphQLErrorInfo[] {
  return (errors || []).map((error) => ({
    message: typeof error?.message === "string" ? error.message : undefined,
    extensions:
      error?.extensions && typeof error.extensions === "object" ? error.extensions : undefined,
    path: Array.isArray(error?.path)
      ? error.path.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number"
        )
      : undefined,
  }));
}

function pickPathRoot(graphqlErrors: LinearGraphQLErrorInfo[]): string | undefined {
  for (const error of graphqlErrors) {
    const firstSegment = error.path?.find((segment) => typeof segment === "string");
    if (typeof firstSegment === "string" && firstSegment.trim()) {
      return firstSegment.trim();
    }
  }
  return undefined;
}

function pickPathRootFromBody(body: string): string | undefined {
  const match = body.match(/["']path["']\s*:\s*\[\s*["']([A-Za-z][A-Za-z0-9_]*)["']/i);
  return match?.[1]?.trim() || undefined;
}

function hasUsageLimitSignal(graphqlErrors: LinearGraphQLErrorInfo[], body: string): boolean {
  const messages = graphqlErrors
    .map((error) => {
      const extensionJson =
        error.extensions && Object.keys(error.extensions).length > 0
          ? JSON.stringify(error.extensions)
          : "";
      return [error.message || "", extensionJson].filter(Boolean).join(" ");
    })
    .filter((value) => value.trim().length > 0);
  const haystacks = [...messages, body].filter((value) => value.trim().length > 0);

  return haystacks.some((value) => {
    const normalized = value.toLowerCase();
    return (
      normalized.includes("usage limit exceeded") ||
      normalized.includes("usage_limit_exceeded") ||
      normalized.includes("usagelimitexceeded")
    );
  });
}

export function isLikelyLinearFreeTierIssueLimitMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  const mentionsUsageLimit =
    normalized.includes("usage limit exceeded") ||
    normalized.includes("usage_limit_exceeded") ||
    normalized.includes("usagelimitexceeded");
  const mentionsIssueCreate =
    normalized.includes("issuecreate") ||
    /["']endpointname["']?\s*[:=]\s*["']issuecreate["']/i.test(message) ||
    /["']path["']\s*:\s*\[\s*["']issuecreate["']/i.test(message);
  return mentionsUsageLimit && mentionsIssueCreate;
}

function parseGraphQLErrorBody(body: string): LinearGraphQLErrorInfo[] {
  if (!body.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{
        message?: string;
        extensions?: Record<string, unknown>;
      }>;
    };
    return toGraphQLErrorInfo(parsed.errors);
  } catch {
    return [];
  }
}

function pickNumericExtensionValue(
  graphqlErrors: LinearGraphQLErrorInfo[],
  fieldName: string
): number | undefined {
  for (const error of graphqlErrors) {
    const value = error.extensions?.[fieldName];
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number.parseInt(value, 10)
          : Number.NaN;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function pickStringExtensionValue(
  graphqlErrors: LinearGraphQLErrorInfo[],
  fieldName: string
): string | undefined {
  for (const error of graphqlErrors) {
    const value = error.extensions?.[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isRateLimitGraphQLError(graphqlErrors: LinearGraphQLErrorInfo[]): boolean {
  return graphqlErrors.some((error) => {
    const code = String(error.extensions?.code || "").toLowerCase();
    const type = String(error.extensions?.type || "").toLowerCase();
    return code === "ratelimited" || type === "ratelimited";
  });
}

function hasRateLimitResetHeaders(headers: Record<string, string>): boolean {
  return Boolean(
    headerValue(headers, "x-ratelimit-endpoint-requests-reset") ||
    headerValue(headers, "x-ratelimit-endpoint-name") ||
    headerValue(headers, "x-ratelimit-complexity-reset") ||
    headerValue(headers, "x-ratelimit-requests-reset")
  );
}

function hasRateLimitMessageSignal(graphqlErrors: LinearGraphQLErrorInfo[], body: string): boolean {
  if (hasUsageLimitSignal(graphqlErrors, body)) {
    return true;
  }

  const messages = graphqlErrors
    .map((error) => {
      const extensionJson =
        error.extensions && Object.keys(error.extensions).length > 0
          ? JSON.stringify(error.extensions)
          : "";
      return [error.message || "", extensionJson].filter(Boolean).join(" ");
    })
    .filter((value) => value.trim().length > 0);
  const haystacks = [...messages, body].filter((value) => value.trim().length > 0);

  return haystacks.some((value) => {
    const normalized = value.toLowerCase();
    return (
      normalized.includes("rate limit exceeded") ||
      normalized.includes('"code":"ratelimited"') ||
      normalized.includes('"type":"ratelimited"')
    );
  });
}

function hasRateLimitSignal(
  status: number,
  headers: Record<string, string>,
  graphqlErrors: LinearGraphQLErrorInfo[],
  body: string
): boolean {
  if (status === 429 || isRateLimitGraphQLError(graphqlErrors)) {
    return true;
  }

  if (headerValue(headers, "retry-after") && hasRateLimitResetHeaders(headers)) {
    return true;
  }

  // Fallback for cases where a client strips structured extensions but keeps the server message.
  return hasRateLimitMessageSignal(graphqlErrors, body);
}

function inferRateLimitBucket(
  headers: Record<string, string>,
  graphqlErrors: LinearGraphQLErrorInfo[],
  status: number,
  body: string
): LinearRateLimitBucketKind | null {
  if (!hasRateLimitSignal(status, headers, graphqlErrors, body)) {
    return null;
  }

  if (
    headerValue(headers, "x-ratelimit-endpoint-requests-reset") ||
    headerValue(headers, "x-ratelimit-endpoint-name")
  ) {
    return "endpoint";
  }
  if (headerValue(headers, "x-ratelimit-complexity-reset")) {
    return "complexity";
  }
  if (headerValue(headers, "x-ratelimit-requests-reset") || status === 429) {
    return "global";
  }
  if (isRateLimitGraphQLError(graphqlErrors)) {
    return "global";
  }
  return null;
}

function buildRateLimitInfo(
  status: number,
  headers: Record<string, string>,
  graphqlErrors: LinearGraphQLErrorInfo[],
  body: string
): LinearRateLimitErrorInfo | undefined {
  const bucketKind = inferRateLimitBucket(headers, graphqlErrors, status, body);
  if (!bucketKind) {
    return undefined;
  }

  const retryAfterMs = parseRetryAfterMs(headerValue(headers, "retry-after") || null) ?? undefined;
  const resetAtMs =
    parseResetHeaderMs(
      bucketKind === "endpoint"
        ? headerValue(headers, "x-ratelimit-endpoint-requests-reset")
        : bucketKind === "complexity"
          ? headerValue(headers, "x-ratelimit-complexity-reset")
          : headerValue(headers, "x-ratelimit-requests-reset")
    ) ?? parseResetHeaderMs(headerValue(headers, "x-ratelimit-requests-reset"));
  const endpointName =
    headerValue(headers, "x-ratelimit-endpoint-name") ||
    pickStringExtensionValue(graphqlErrors, "endpointName") ||
    pickPathRoot(graphqlErrors) ||
    pickPathRootFromBody(body);
  const diagnosis =
    endpointName === "issueCreate" && hasUsageLimitSignal(graphqlErrors, body)
      ? "free_tier_issue_limit"
      : undefined;

  return {
    bucketKind,
    endpointName,
    retryAfterMs,
    resetAtMs,
    durationMs: pickNumericExtensionValue(graphqlErrors, "duration"),
    limit: pickNumericExtensionValue(graphqlErrors, "limit"),
    remaining: pickNumericExtensionValue(graphqlErrors, "remaining"),
    requested: pickNumericExtensionValue(graphqlErrors, "requested"),
    diagnosis,
    headers,
    graphqlErrors,
    status,
    body,
  };
}

function getGraphQLResponseLike(error: unknown): GraphQLResponseLike | null {
  if (!(error instanceof ClientError)) {
    return null;
  }

  return error.response as GraphQLResponseLike;
}

export function getLinearApiErrorInfoFromResponse(
  response: GraphQLResponseLike
): LinearApiErrorInfo {
  const status = typeof response.status === "number" ? response.status : 0;
  const headers = headersToRecord(response.headers);
  const body = typeof response.body === "string" ? response.body : "";
  const graphqlErrors =
    response.errors && response.errors.length > 0
      ? toGraphQLErrorInfo(response.errors)
      : parseGraphQLErrorBody(body);

  return {
    status,
    headers,
    body,
    graphqlErrors,
    rateLimit: buildRateLimitInfo(status, headers, graphqlErrors, body),
  };
}

export function getLinearApiErrorInfo(error: unknown): LinearApiErrorInfo | null {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    "headers" in error &&
    "body" in error &&
    "graphqlErrors" in error
  ) {
    return error as LinearApiErrorInfo;
  }

  const response = getGraphQLResponseLike(error);
  if (!response) {
    return null;
  }

  return getLinearApiErrorInfoFromResponse(response);
}

export function getLinearRateLimitErrorInfo(error: unknown): LinearRateLimitErrorInfo | null {
  return getLinearApiErrorInfo(error)?.rateLimit || null;
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
    const fetchWithRetry: typeof fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        linearFetchWithRetry(input as string | URL | Request, init || {}),
      fetch
    );
    client = new GraphQLClient(LINEAR_ENDPOINT, {
      headers: {
        Authorization: apiKey,
      },
      fetch: fetchWithRetry,
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
  creator {
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
