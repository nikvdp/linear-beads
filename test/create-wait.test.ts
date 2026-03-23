import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
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

function createRepo(options: { localOnly?: boolean } = {}): string {
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
  writeFileSync(
    join(repoDir, ".lb", "config.jsonc"),
    `${JSON.stringify(options.localOnly === false ? {} : { local_only: true })}\n`
  );
  return repoDir;
}

async function runEval(
  cwd: string,
  script: string
): Promise<{
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

async function runCli(
  cwd: string,
  args: string[],
  envOverrides?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: "",
      LINEAR_API_KEY: "",
      ...(envOverrides || {}),
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

  test("reports a structured JSON error when --wait is used in local-only mode", async () => {
    const repoDir = createRepo();
    const result = await runCli(repoDir, ["create", "Local-only wait", "--wait", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr) as {
      error: string;
      message: string;
      timeout_ms: number;
    };
    expect(parsed.error).toBe("wait_unavailable");
    expect(parsed.message).toContain("local-only mode");
    expect(parsed.timeout_ms).toBe(20000);
  });

  test("create --wait --json returns the resolved remote identifier for scripts", async () => {
    const repoDir = createRepo({ localOnly: false });
    const title = "Waited CLI issue";

    const createProc = Bun.spawn(
      ["bun", "run", CLI_PATH, "create", title, "--wait", "--json", "--wait-timeout-ms", "2000"],
      {
        cwd: repoDir,
        env: {
          ...process.env,
          LB_TEAM_KEY: "",
          LINEAR_API_KEY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const updater = runEval(
      repoDir,
      `
        import { cacheIssue, closeDatabase, getCachedIssues } from ${JSON.stringify(DATABASE_UTILS_PATH)};

        const deadline = Date.now() + 1500;
        let issue = null;
        while (Date.now() < deadline) {
          issue = getCachedIssues().find((entry) => entry.title === ${JSON.stringify(title)}) || null;
          if (issue) break;
          await Bun.sleep(25);
        }

        if (!issue) {
          throw new Error("Queued issue not found");
        }

        const localId = issue.local_id || issue.id;
        cacheIssue({
          ...issue,
          id: "LIN-777",
          local_id: localId,
          linear_id: "issue-777",
          linear_identifier: "LIN-777",
          sync_status: "synced",
          updated_at: new Date().toISOString(),
        });

        closeDatabase();
      `
    );

    const stdout = await new Response(createProc.stdout).text();
    const stderr = await new Response(createProc.stderr).text();
    const exitCode = await createProc.exited;
    const updaterResult = await updater;

    expect(updaterResult.exitCode).toBe(0);
    expect(updaterResult.stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const parsed = JSON.parse(stdout) as Array<{ id: string; linear_identifier?: string }>;
    expect(parsed[0]?.id).toBe("LIN-777");
    expect(parsed[0]?.linear_identifier).toBe("LIN-777");
  });

  test("create --wait --json returns a structured timeout error with the local id", async () => {
    const repoDir = createRepo({ localOnly: false });
    const result = await runCli(repoDir, [
      "create",
      "Timed out wait",
      "--wait",
      "--json",
      "--wait-timeout-ms",
      "50",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");

    const parsed = JSON.parse(result.stderr) as {
      error: string;
      message: string;
      local_id: string;
      timeout_ms: number;
      issue?: { id: string; sync_status?: string };
    };
    expect(parsed.error).toBe("wait_timeout");
    expect(parsed.message).toContain("Timed out waiting");
    expect(parsed.local_id).toMatch(/^LOCAL-\d+$/);
    expect(parsed.timeout_ms).toBe(50);
    expect(parsed.issue?.id).toBe(parsed.local_id);
    expect(parsed.issue?.sync_status).toBe("pending");
  });
});
