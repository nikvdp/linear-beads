import { describe, expect, test } from "bun:test";
import {
  computeRetryDelayMs,
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
