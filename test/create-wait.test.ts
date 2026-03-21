import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CREATE_COMMAND_PATH = join(import.meta.dir, "..", "src", "commands", "create.ts");
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
  const repoDir = mkdtempSync(join(tmpdir(), "lb-create-wait-"));
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
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), '{ "local_only": true }\n');
  return repoDir;
}

async function runEval(cwd: string, script: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd,
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
  return { stdout, stderr, exitCode };
}

describe("create --wait helper", () => {
  test("resolves once the cached issue gains a remote identifier", async () => {
    const repoDir = createRepo();
    const script = `
      import { waitForCreateResolution } from ${JSON.stringify(CREATE_COMMAND_PATH)};
      import { cacheIssue, closeDatabase } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const now = new Date().toISOString();
      cacheIssue({
        id: "LOCAL-001",
        local_id: "LOCAL-001",
        title: "Queued issue",
        status: "open",
        priority: 2,
        sync_status: "pending",
        created_at: now,
        updated_at: now,
      });

      setTimeout(() => {
        cacheIssue({
          id: "LIN-123",
          local_id: "LOCAL-001",
          linear_id: "issue-123",
          linear_identifier: "LIN-123",
          title: "Queued issue",
          status: "open",
          priority: 2,
          sync_status: "synced",
          created_at: now,
          updated_at: new Date().toISOString(),
        });
      }, 75);

      const result = await waitForCreateResolution("LOCAL-001", {
        timeoutMs: 2000,
        pollMs: 20,
        kickWorker: () => {},
      });

      console.log(JSON.stringify(result));
      closeDatabase();
    `;

    const result = await runEval(repoDir, script);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout) as {
      status: string;
      issue?: { id: string; linear_identifier?: string };
    };
    expect(parsed.status).toBe("resolved");
    expect(parsed.issue?.id).toBe("LIN-123");
    expect(parsed.issue?.linear_identifier).toBe("LIN-123");
  });

  test("stops waiting when an issueCreate pause becomes active", async () => {
    const repoDir = createRepo();
    const script = `
      import { waitForCreateResolution } from ${JSON.stringify(CREATE_COMMAND_PATH)};
      import { cacheIssue, closeDatabase } from ${JSON.stringify(DATABASE_UTILS_PATH)};
      import { getLinearApiErrorInfoFromResponse } from ${JSON.stringify(GRAPHQL_UTILS_PATH)};
      import { clearRemoteSyncPause, recordRemoteSyncPause } from ${JSON.stringify(REMOTE_SYNC_STATE_PATH)};

      const now = new Date().toISOString();
      cacheIssue({
        id: "LOCAL-001",
        local_id: "LOCAL-001",
        title: "Queued issue",
        status: "open",
        priority: 2,
        sync_status: "pending",
        created_at: now,
        updated_at: now,
      });

      setTimeout(() => {
        recordRemoteSyncPause(
          getLinearApiErrorInfoFromResponse({
            status: 429,
            headers: {
              "retry-after": "2",
              "x-ratelimit-endpoint-name": "issueCreate",
            },
            body: JSON.stringify({
              errors: [
                {
                  message: "usage limit exceeded",
                  extensions: {
                    code: "RATELIMITED",
                    duration: 60000,
                    limit: 5,
                    remaining: 0,
                    requested: 1,
                  },
                },
              ],
            }),
          })
        );
      }, 50);

      const result = await waitForCreateResolution("LOCAL-001", {
        timeoutMs: 2000,
        pollMs: 20,
        kickWorker: () => {},
      });

      console.log(JSON.stringify(result));
      clearRemoteSyncPause();
      closeDatabase();
    `;

    const result = await runEval(repoDir, script);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout) as {
      status: string;
      pauseNotice?: string;
      issue?: { id: string };
    };
    expect(parsed.status).toBe("paused");
    expect(parsed.issue?.id).toBe("LOCAL-001");
    expect(parsed.pauseNotice).toContain("issueCreate");
    expect(parsed.pauseNotice).toContain("Linear rate limit");
  });
});
