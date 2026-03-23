import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getLinearApiErrorInfoFromResponse } from "../src/utils/graphql.js";
import {
  clearRemoteSyncPause,
  formatRemoteSyncPauseNotice,
  recordRemoteSyncPause,
} from "../src/utils/remote-sync-state.js";

const tempDirs: string[] = [];
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");

afterEach(() => {
  clearRemoteSyncPause();
});

afterAll(() => {
  clearRemoteSyncPause();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-structured-rate-limit-"));
  tempDirs.push(repoDir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    throw new Error("Failed to initialize git repo");
  }

  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), `${JSON.stringify({ local_only: true })}\n`);
  return repoDir;
}

describe("structured rate-limit metadata", () => {
  test("records endpoint pause details from structured response metadata", () => {
    const pause = recordRemoteSyncPause(
      getLinearApiErrorInfoFromResponse({
        status: 429,
        headers: {
          "retry-after": "2",
          "x-ratelimit-endpoint-name": "issueCreate",
          "x-ratelimit-endpoint-requests-reset": "1742544000000",
        },
        body: JSON.stringify({
          errors: [
            {
              message: "usage limit exceeded",
              extensions: {
                code: "RATELIMITED",
                duration: 60000,
                limit: 5,
                remaining: 1,
                requested: 2,
              },
            },
          ],
        }),
      })
    );

    expect(pause).not.toBeNull();
    expect(pause?.kind).toBe("rate_limit");
    expect(pause?.scope.kind).toBe("endpoint");
    expect(pause?.scope.kind === "endpoint" ? pause.scope.endpointName : null).toBe("issueCreate");
    expect(pause?.details?.limit).toBe(5);
    expect(pause?.details?.remaining).toBe(1);
    expect(pause?.details?.requested).toBe(2);
    expect(pause?.details?.durationMs).toBe(60000);
    expect(pause?.details?.diagnosis).toBe("free_tier_issue_limit");

    const notice = formatRemoteSyncPauseNotice(pause!);
    expect(notice).toContain("unable to sync new issues to Linear");
    expect(notice).toContain("free-tier active-issue limit");
    expect(notice).toContain("lb linear prune");
    expect(notice).toContain("issueCreate requests");
    expect(notice).toContain("endpoint issueCreate");
    expect(notice).toContain("1/5 remaining");
    expect(notice).toContain("window 1m");
  });

  test("detects the free-tier issue cap even when Linear reports it through the complexity bucket", () => {
    const pause = recordRemoteSyncPause(
      getLinearApiErrorInfoFromResponse({
        status: 200,
        headers: {
          "x-ratelimit-complexity-reset": "1742545000000",
        },
        body: JSON.stringify({
          errors: [
            {
              message: "usage limit exceeded",
              path: ["issueCreate"],
              extensions: {
                code: "USAGE_LIMIT_EXCEEDED",
                type: "usage limit exceeded",
              },
            },
          ],
        }),
      })
    );

    expect(pause).not.toBeNull();
    expect(pause?.scope.kind).toBe("complexity");
    expect(pause?.details?.diagnosis).toBe("free_tier_issue_limit");

    const notice = formatRemoteSyncPauseNotice(pause!);
    expect(notice).toContain("unable to sync new issues to Linear");
    expect(notice).toContain("free-tier active-issue limit");
    expect(notice).toContain("lb linear prune");
  });

  test("row retry timing honors typed rate-limit hints without relying on message text", async () => {
    const repoDir = createRepo();
    const script = `
      import {
        closeDatabase,
        getDatabase,
        queueOutboxItem,
        updateOutboxItemError,
      } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const outboxId = queueOutboxItem("update", { issueId: "LIN-123", title: "x" });
      const startedAt = Date.now();
      updateOutboxItemError(outboxId, "temporary remote failure", {
        retryAfterMs: 2000,
        rateLimited: true,
      });
      const db = getDatabase();
      const item = db
        .query(
          "SELECT retry_count, last_error, next_attempt_at FROM outbox WHERE id = ? LIMIT 1"
        )
        .get(outboxId);
      const nextAttemptAt = item?.next_attempt_at ? Date.parse(item.next_attempt_at) : NaN;
      closeDatabase();
      console.log(
        JSON.stringify({
          retryCount: item?.retry_count ?? null,
          deltaMs: Number.isFinite(nextAttemptAt) ? nextAttemptAt - startedAt : null,
          lastError: item?.last_error ?? null,
        })
      );
    `;

    const proc = Bun.spawn(["bun", "--eval", script], {
      cwd: repoDir,
      env: {
        ...process.env,
        LB_TEAM_KEY: "",
        LINEAR_API_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const parsed = JSON.parse(stdout) as {
      retryCount: number;
      deltaMs: number;
      lastError: string;
    };
    expect(parsed.retryCount).toBe(1);
    expect(parsed.lastError).toBe("temporary remote failure");
    expect(parsed.deltaMs).toBeGreaterThanOrEqual(2000);
    expect(parsed.deltaMs).toBeLessThanOrEqual(2600);
  });

  test("does not record a pause for invalid input errors that carry routine reset headers", () => {
    const pause = recordRemoteSyncPause(
      getLinearApiErrorInfoFromResponse({
        status: 200,
        headers: {
          "x-ratelimit-complexity-reset": "1774089461297",
          "x-ratelimit-requests-reset": "1774089461297",
        },
        body: JSON.stringify({
          errors: [
            {
              message: "Argument Validation Error",
              extensions: {
                code: "INVALID_INPUT",
                type: "invalid input",
                userError: true,
                userPresentableMessage: "relatedIssueId cannot have the same value as issueId.",
              },
            },
          ],
        }),
      })
    );

    expect(pause).toBeNull();
  });
});
