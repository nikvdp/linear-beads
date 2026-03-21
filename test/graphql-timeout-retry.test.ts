import { describe, expect, test } from "bun:test";
import { ClientError } from "graphql-request";
import {
  createLinearPaginationGuard,
  computeRetryDelayMs,
  getLinearApiErrorInfo,
  getLinearRateLimitErrorInfo,
  getLinearPaginationPolicy,
  getLinearRequestPolicy,
  linearFetchWithRetry,
  parseRetryAfterMs,
} from "../src/utils/graphql.js";

describe("linear GraphQL retry policy helpers", () => {
  test("computes static then exponential retry delays", () => {
    expect(computeRetryDelayMs(1, 500)).toBe(500);
    expect(computeRetryDelayMs(2, 500)).toBe(500);
    expect(computeRetryDelayMs(3, 500)).toBe(1000);
    expect(computeRetryDelayMs(4, 500)).toBe(2000);
    expect(computeRetryDelayMs(5, 500)).toBe(4000);
  });

  test("parses retry-after header values", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
  });

  test("loads policy from env with sane defaults", () => {
    const policy = getLinearRequestPolicy({
      LB_LINEAR_REQUEST_TIMEOUT_MS: "1234",
      LB_LINEAR_MAX_RETRIES: "7",
      LB_LINEAR_RETRY_BASE_MS: "250",
      LB_LINEAR_RETRY_JITTER_RATIO: "0.5",
    });
    expect(policy.timeoutMs).toBe(1234);
    expect(policy.maxRetries).toBe(7);
    expect(policy.retryBaseMs).toBe(250);
    expect(policy.jitterRatio).toBe(0.5);
  });
});

describe("linear GraphQL pagination guard", () => {
  test("loads pagination policy from env with sane defaults", () => {
    const policy = getLinearPaginationPolicy({
      LB_LINEAR_PAGINATION_MAX_PAGES: "321",
      LB_LINEAR_PAGINATION_MAX_DURATION_MS: "4567",
    });
    expect(policy.maxPages).toBe(321);
    expect(policy.maxDurationMs).toBe(4567);
  });

  test("throws when hasNextPage is true and endCursor is missing", () => {
    const guard = createLinearPaginationGuard("test-missing-cursor", {
      policy: { maxPages: 10, maxDurationMs: 10_000 },
    });
    expect(() => guard.nextCursor({ hasNextPage: true, endCursor: null }, null)).toThrow(
      "missing endCursor"
    );
  });

  test("throws when cursor stalls at the same value", () => {
    const guard = createLinearPaginationGuard("test-cursor-stall", {
      policy: { maxPages: 10, maxDurationMs: 10_000 },
    });
    expect(() =>
      guard.nextCursor({ hasNextPage: true, endCursor: "cursor-1" }, "cursor-1")
    ).toThrow("cursor stalled");
  });

  test("throws when a cursor repeats across pages", () => {
    const guard = createLinearPaginationGuard("test-cursor-repeat", {
      policy: { maxPages: 10, maxDurationMs: 10_000 },
    });
    expect(guard.nextCursor({ hasNextPage: true, endCursor: "cursor-1" }, null)).toBe("cursor-1");
    expect(guard.nextCursor({ hasNextPage: true, endCursor: "cursor-2" }, "cursor-1")).toBe(
      "cursor-2"
    );
    expect(() =>
      guard.nextCursor({ hasNextPage: true, endCursor: "cursor-1" }, "cursor-2")
    ).toThrow("cursor repeated");
  });

  test("throws when page limit is exceeded", () => {
    const guard = createLinearPaginationGuard("test-max-pages", {
      policy: { maxPages: 2, maxDurationMs: 10_000 },
    });
    expect(guard.nextCursor({ hasNextPage: true, endCursor: "c1" }, null)).toBe("c1");
    expect(guard.nextCursor({ hasNextPage: true, endCursor: "c2" }, "c1")).toBe("c2");
    expect(() => guard.nextCursor({ hasNextPage: true, endCursor: "c3" }, "c2")).toThrow(
      "exceeded max pages"
    );
  });

  test("throws when duration limit is exceeded", () => {
    const nowValues = [0, 3, 11];
    let nowIndex = 0;
    const guard = createLinearPaginationGuard("test-max-duration", {
      policy: { maxPages: 10, maxDurationMs: 10 },
      now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)],
    });

    expect(guard.nextCursor({ hasNextPage: true, endCursor: "c1" }, null)).toBe("c1");
    expect(() => guard.nextCursor({ hasNextPage: true, endCursor: "c2" }, "c1")).toThrow(
      "exceeded max duration"
    );
  });
});

describe("linearFetchWithRetry", () => {
  test("retries transient 500 responses then succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const baseFetch: typeof fetch = async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("server error", { status: 500 });
      }
      return new Response('{"ok":true}', { status: 200 });
    };

    const res = await linearFetchWithRetry(
      "https://example.test/graphql",
      {},
      {
        baseFetch,
        policy: {
          timeoutMs: 50,
          maxRetries: 5,
          retryBaseMs: 10,
          jitterRatio: 0,
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );

    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 10]);
  });

  test("uses retry-after for 429 responses", async () => {
    let calls = 0;
    const delays: number[] = [];
    const baseFetch: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: {
            "retry-after": "2",
          },
        });
      }
      return new Response('{"ok":true}', { status: 200 });
    };

    const res = await linearFetchWithRetry(
      "https://example.test/graphql",
      {},
      {
        baseFetch,
        policy: {
          timeoutMs: 50,
          maxRetries: 5,
          retryBaseMs: 10,
          jitterRatio: 0,
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(delays).toEqual([2000]);
  });

  test("retries timeout aborts and then succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const baseFetch: typeof fetch = async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason || new Error("aborted"));
          });
        });
      }
      return new Response("ok", { status: 200 });
    };

    const res = await linearFetchWithRetry(
      "https://example.test/graphql",
      {},
      {
        baseFetch,
        policy: {
          timeoutMs: 5,
          maxRetries: 2,
          retryBaseMs: 10,
          jitterRatio: 0,
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(delays).toEqual([10]);
  });

  test("returns final retryable response after retries are exhausted", async () => {
    let calls = 0;
    const delays: number[] = [];
    const baseFetch: typeof fetch = async () => {
      calls += 1;
      return new Response("still failing", { status: 500 });
    };

    const res = await linearFetchWithRetry(
      "https://example.test/graphql",
      {},
      {
        baseFetch,
        policy: {
          timeoutMs: 50,
          maxRetries: 2,
          retryBaseMs: 10,
          jitterRatio: 0,
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );

    expect(res.status).toBe(500);
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 10]);
  });

  test("throws after retries for non-recovering network errors", async () => {
    let calls = 0;
    const delays: number[] = [];
    const baseFetch: typeof fetch = async () => {
      calls += 1;
      throw new Error("fetch failed");
    };

    await expect(
      linearFetchWithRetry(
        "https://example.test/graphql",
        {},
        {
          baseFetch,
          policy: {
            timeoutMs: 50,
            maxRetries: 2,
            retryBaseMs: 10,
            jitterRatio: 0,
          },
          sleep: async (ms) => {
            delays.push(ms);
          },
        }
      )
    ).rejects.toThrow("fetch failed");

    expect(calls).toBe(3);
    expect(delays).toEqual([10, 10]);
  });
});

describe("structured Linear API error helpers", () => {
  test("extracts endpoint rate-limit metadata from a ClientError", () => {
    const error = new ClientError(
      {
        status: 429,
        headers: new Headers({
          "retry-after": "2",
          "x-ratelimit-endpoint-name": "issueCreate",
          "x-ratelimit-endpoint-requests-reset": "1742544000000",
        }),
        body: JSON.stringify({
          errors: [
            {
              message: "usage limit exceeded",
              extensions: {
                code: "RATELIMITED",
                userPresentableMessage: "usage limit exceeded",
              },
            },
          ],
        }),
        errors: [
          {
            message: "usage limit exceeded",
            extensions: {
              code: "RATELIMITED",
              userPresentableMessage: "usage limit exceeded",
            },
          },
        ],
      },
      {
        query: "mutation IssueCreate { issueCreate { success } }",
      }
    );

    const info = getLinearApiErrorInfo(error);
    expect(info).not.toBeNull();
    expect(info?.status).toBe(429);
    expect(info?.headers["x-ratelimit-endpoint-name"]).toBe("issueCreate");
    expect(info?.graphqlErrors[0]?.extensions?.code).toBe("RATELIMITED");

    const rateLimit = getLinearRateLimitErrorInfo(error);
    expect(rateLimit).not.toBeNull();
    expect(rateLimit?.bucketKind).toBe("endpoint");
    expect(rateLimit?.endpointName).toBe("issueCreate");
    expect(rateLimit?.retryAfterMs).toBe(2000);
    expect(rateLimit?.resetAtMs).toBe(1742544000000);
  });

  test("extracts complexity bucket metadata from response headers", () => {
    const error = new ClientError(
      {
        status: 200,
        headers: new Headers({
          "x-ratelimit-complexity-reset": "1742545000000",
        }),
        body: JSON.stringify({
          errors: [
            {
              message: "complexity exceeded",
              extensions: {
                type: "RATELIMITED",
              },
            },
          ],
        }),
        errors: [
          {
            message: "complexity exceeded",
            extensions: {
              type: "RATELIMITED",
            },
          },
        ],
      },
      {
        query: "query HeavyQuery { viewer { id } }",
      }
    );

    const rateLimit = getLinearRateLimitErrorInfo(error);
    expect(rateLimit).not.toBeNull();
    expect(rateLimit?.bucketKind).toBe("complexity");
    expect(rateLimit?.resetAtMs).toBe(1742545000000);
  });

  test("ignores routine reset headers on non-rate-limited GraphQL validation errors", () => {
    const error = new ClientError(
      {
        status: 200,
        headers: new Headers({
          "x-ratelimit-complexity-reset": "1774089461297",
          "x-ratelimit-requests-reset": "1774089461297",
        }),
        body: JSON.stringify({
          errors: [
            {
              message: "Argument Validation Error",
              extensions: {
                code: "INVALID_INPUT",
                type: "invalid input",
                userError: true,
              },
            },
          ],
        }),
        errors: [
          {
            message: "Argument Validation Error",
            extensions: {
              code: "INVALID_INPUT",
              type: "invalid input",
              userError: true,
            },
          },
        ],
      },
      {
        query: "mutation CreateRelation { issueRelationCreate(input: {}) { success } }",
      }
    );

    expect(getLinearRateLimitErrorInfo(error)).toBeNull();
  });

  test("returns null for non-Linear generic errors", () => {
    expect(getLinearApiErrorInfo(new Error("fetch failed"))).toBeNull();
    expect(getLinearRateLimitErrorInfo(new Error("fetch failed"))).toBeNull();
  });
});
