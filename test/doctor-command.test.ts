import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const GRAPHQL_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "graphql.ts");
const REMOTE_SYNC_STATE_PATH = join(import.meta.dir, "..", "src", "utils", "remote-sync-state.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-doctor-"));
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
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), "{}\n");
  return repoDir;
}

async function runDoctorWithMockedFetch(
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import {
      cacheIssue,
      cacheMediaItem,
      queueOutboxItem,
      updateOutboxItemError,
    } from ${JSON.stringify(DATABASE_UTILS_PATH)};

    const now = new Date().toISOString();
    cacheIssue({
      id: "LOCAL-284",
      title: "Upload-backed issue",
      status: "open",
      priority: 2,
      sync_status: "pending",
      created_at: now,
      updated_at: now,
    });
    cacheMediaItem({
      id: "m_upload001",
      issue_local_id: "LOCAL-284",
      source: "description",
      kind: "image",
      label: "shot.png",
      original_filename: "shot.png",
      local_path: "/tmp/shot.png",
    });
    const outboxId = queueOutboxItem(
      "create",
      {
        title: "Upload-backed issue",
        priority: 2,
        description: "See ![shot](lb-media:m_upload001)",
      },
      "LOCAL-284"
    );
    updateOutboxItemError(outboxId, "Unable to connect. Is the computer able to access the url?");

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://api.linear.app/graphql") {
        return new Response(
          JSON.stringify({
            data: {
              viewer: { id: "viewer-1", name: "Doctor User" },
              teams: {
                nodes: [{ id: "team-1", key: "DOC", name: "Doctor Team" }],
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      if (url === "https://uploads.linear.app/") {
        throw new Error("Unable to connect. Is the computer able to access the url?");
      }
      throw new Error("Unexpected fetch target: " + url);
    };

    process.argv = ["bun", "doctor", "--json"];
    await import(${JSON.stringify(CLI_PATH)});
  `;

  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd,
    env: {
      ...process.env,
      LINEAR_API_KEY: "linear-test-key",
      LB_TEAM_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function runDoctorWithFreeTierIssueLimit(
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { cacheIssue, queueOutboxItem, updateOutboxItemError } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    import { getLinearApiErrorInfoFromResponse } from ${JSON.stringify(GRAPHQL_UTILS_PATH)};
    import { recordRemoteSyncPause } from ${JSON.stringify(REMOTE_SYNC_STATE_PATH)};

    const now = new Date().toISOString();
    cacheIssue({
      id: "LOCAL-401",
      title: "Free-tier capped issue",
      status: "open",
      priority: 2,
      sync_status: "pending",
      created_at: now,
      updated_at: now,
    });
    const rawError = JSON.stringify({
      response: {
        data: null,
        errors: [
          {
            message: "usage limit exceeded",
            path: ["issueCreate"],
            extensions: {
              type: "usage limit exceeded",
              code: "USAGE_LIMIT_EXCEEDED",
            },
          },
        ],
      },
    });
    const outboxId = queueOutboxItem(
      "create",
      {
        title: "Free-tier capped issue",
        priority: 2,
      },
      "LOCAL-401"
    );
    updateOutboxItemError(outboxId, rawError);
    recordRemoteSyncPause(
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
                type: "usage limit exceeded",
                code: "USAGE_LIMIT_EXCEEDED",
              },
            },
          ],
        }),
      })
    );

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://api.linear.app/graphql") {
        return new Response(
          JSON.stringify({
            data: {
              viewer: { id: "viewer-1", name: "Doctor User" },
              teams: {
                nodes: [{ id: "team-1", key: "DOC", name: "Doctor Team" }],
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      if (url === "https://uploads.linear.app/") {
        return new Response("not found", { status: 404 });
      }
      throw new Error("Unexpected fetch target: " + url);
    };

    process.argv = ["bun", "doctor", "--json"];
    await import(${JSON.stringify(CLI_PATH)});
  `;

  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd,
    env: {
      ...process.env,
      LINEAR_API_KEY: "linear-test-key-free-tier",
      LB_TEAM_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("doctor command", () => {
  test("reports partial upload connectivity and the latest failed media-linked outbox row", async () => {
    const repoDir = createRepo();
    const result = await runDoctorWithMockedFetch(repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");

    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      connectivity: {
        status: string;
        graphql: { status: string; viewer: { name: string } };
        uploads: { status: string; url: string };
      };
      outbox: {
        latest_failed_item: {
          subject: string;
          operation: string;
          error: string;
          context: string[];
          last_error_at: string | null;
        } | null;
        recent_errors: Array<{
          subject: string;
          context: string[];
        }>;
      };
    };

    expect(report.ok).toBe(false);
    expect(report.connectivity.status).toBe("partial");
    expect(report.connectivity.graphql.status).toBe("ok");
    expect(report.connectivity.graphql.viewer.name).toBe("Doctor User");
    expect(report.connectivity.uploads.status).toBe("network_error");
    expect(report.connectivity.uploads.url).toBe("https://uploads.linear.app/");

    expect(report.outbox.latest_failed_item?.subject).toBe("LOCAL-284");
    expect(report.outbox.latest_failed_item?.operation).toBe("create");
    expect(report.outbox.latest_failed_item?.error).toContain("Unable to connect");
    expect(report.outbox.latest_failed_item?.last_error_at).not.toBeNull();
    expect(report.outbox.latest_failed_item?.context).toContain("description references cached media");
    expect(report.outbox.recent_errors[0]?.subject).toBe("LOCAL-284");
  });

  test("reports the likely Linear free-tier issue cap when issueCreate usage limits block sync", async () => {
    const repoDir = createRepo();
    const result = await runDoctorWithFreeTierIssueLimit(repoDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      connectivity: {
        status: string;
      };
      remote_sync: {
        likely_sync_blocker: {
          kind: string;
          source: string;
          message: string;
        } | null;
      };
      outbox: {
        latest_failed_item: {
          subject: string;
          error: string;
        } | null;
      };
    };

    expect(report.ok).toBe(true);
    expect(report.connectivity.status).toBe("ok");
    expect(report.remote_sync.likely_sync_blocker?.kind).toBe("linear_free_tier_issue_limit");
    expect(report.remote_sync.likely_sync_blocker?.source).toBe("active_pause");
    expect(report.remote_sync.likely_sync_blocker?.message).toContain("free-tier active-issue limit");
    expect(report.outbox.latest_failed_item?.subject).toBe("LOCAL-401");
    expect(report.outbox.latest_failed_item?.error).toContain("usage limit exceeded");
  });
});
