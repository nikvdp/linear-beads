import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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

function createRepo(): { repoDir: string; dbPath: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-linear-prune-"));
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

  return {
    repoDir,
    dbPath: join(repoDir, ".lb", "cache.db"),
  };
}

async function runInlineCli(
  cwd: string,
  args: string[],
  setupSource: string,
  envOverrides: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    ${setupSource}
    process.argv = ["bun", "lb", ${args.map((arg) => JSON.stringify(arg)).join(", ")}];
    await import(${JSON.stringify(CLI_PATH)});
  `;

  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: "",
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function runPruneStale(cwd: string): Promise<{ pruned: number }> {
  const script = `
    import { pruneStaleIssues } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    console.log(JSON.stringify({ pruned: pruneStaleIssues(new Set()) }));
  `;

  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd,
    env: {
      ...process.env,
      LB_TEAM_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`pruneStaleIssues helper failed: ${stderr}`);
  }

  return JSON.parse(stdout) as { pruned: number };
}

function readArchivedRow(dbPath: string, localId: string): {
  local_id: string;
  title: string;
  remote_archived_at: string | null;
} | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT local_id, title, remote_archived_at FROM issues WHERE local_id = ?")
      .get(localId) as {
      local_id: string;
      title: string;
      remote_archived_at: string | null;
    } | null;
  } finally {
    db.close();
  }
}

describe("linear prune command", () => {
  test("previews only closed synced Linear issues", async () => {
    const { repoDir } = createRepo();
    const setupSource = `
      import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const now = new Date().toISOString();
      cacheIssue({
        id: "LIN-100",
        local_id: "LOCAL-100",
        linear_id: "issue-100",
        linear_identifier: "LIN-100",
        title: "Already done",
        status: "closed",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
        closed_at: now,
      });
      cacheIssue({
        id: "LIN-101",
        local_id: "LOCAL-101",
        linear_id: "issue-101",
        linear_identifier: "LIN-101",
        title: "Still active",
        status: "open",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
      });
    `;

    const result = await runInlineCli(repoDir, ["linear", "prune", "--json"], setupSource);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      preview: boolean;
      apply_required: boolean;
      count: number;
      candidates: Array<{ id: string; title: string; status: string }>;
    };

    expect(payload.preview).toBe(true);
    expect(payload.apply_required).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0]).toMatchObject({
      id: "LIN-100",
      title: "Already done",
      status: "closed",
    });
  });

  test("filters automatic prune candidates by age", async () => {
    const { repoDir } = createRepo();
    const setupSource = `
      import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const now = Date.now();
      const oldEnough = new Date(now - 9 * 24 * 60 * 60 * 1000).toISOString();
      const tooFresh = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();

      cacheIssue({
        id: "LIN-110",
        local_id: "LOCAL-110",
        linear_id: "issue-110",
        linear_identifier: "LIN-110",
        title: "Old closed issue",
        status: "closed",
        priority: 2,
        sync_status: "synced",
        created_at: oldEnough,
        updated_at: oldEnough,
        closed_at: oldEnough,
      });
      cacheIssue({
        id: "LIN-111",
        local_id: "LOCAL-111",
        linear_id: "issue-111",
        linear_identifier: "LIN-111",
        title: "Freshly closed issue",
        status: "closed",
        priority: 2,
        sync_status: "synced",
        created_at: tooFresh,
        updated_at: tooFresh,
        closed_at: tooFresh,
      });
    `;

    const result = await runInlineCli(
      repoDir,
      ["linear", "prune", "--age", "7d", "--json"],
      setupSource
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      preview: boolean;
      age: string | null;
      count: number;
      candidates: Array<{ id: string; title: string }>;
    };

    expect(payload.preview).toBe(true);
    expect(payload.age).toBe("7d");
    expect(payload.count).toBe(1);
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0]).toMatchObject({
      id: "LIN-110",
      title: "Old closed issue",
    });
  });

  test("rejects malformed prune ages", async () => {
    const { repoDir } = createRepo();
    const result = await runInlineCli(repoDir, ["linear", "prune", "--age", "banana"], "");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid age 'banana'");
  });

  test("supports explicit dry-run output without archiving", async () => {
    const { repoDir, dbPath } = createRepo();
    const setupSource = `
      import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const now = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      cacheIssue({
        id: "LIN-120",
        local_id: "LOCAL-120",
        linear_id: "issue-120",
        linear_identifier: "LIN-120",
        title: "Dry-run candidate",
        status: "closed",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
        closed_at: now,
      });

      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        if (String(body.query || "").includes("issueArchive")) {
          throw new Error("dry-run should not call issueArchive");
        }

        throw new Error("Unexpected GraphQL request: " + JSON.stringify(body));
      };
    `;

    const result = await runInlineCli(
      repoDir,
      ["linear", "prune", "--age", "7d", "--dry-run", "--json"],
      setupSource,
      { LINEAR_API_KEY: "linear-test-key" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      preview: boolean;
      dry_run: boolean;
      age: string | null;
      count: number;
      candidates: Array<{ id: string; title: string }>;
    };

    expect(payload.preview).toBe(true);
    expect(payload.dry_run).toBe(true);
    expect(payload.age).toBe("7d");
    expect(payload.count).toBe(1);
    expect(payload.candidates[0]).toMatchObject({
      id: "LIN-120",
      title: "Dry-run candidate",
    });

    const archivedRow = readArchivedRow(dbPath, "LOCAL-120");
    expect(archivedRow?.remote_archived_at).toBeNull();
  });

  test("can opt into scanning the current Linear team for viewer-owned prune candidates", async () => {
    const { repoDir } = createRepo();
    const setupSource = `
      import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const now = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
      cacheIssue({
        id: "LIN-140",
        local_id: "LOCAL-140",
        linear_id: "issue-140",
        linear_identifier: "LIN-140",
        title: "Repo-scoped closed issue",
        status: "closed",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
        closed_at: now,
      });

      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        const query = String(body.query || "");

        if (query.includes("query GetTeam")) {
          return new Response(
            JSON.stringify({
              data: {
                teams: {
                  nodes: [{ id: "team-prn", key: "PRN", name: "Prune Team" }],
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (query.includes("query Viewer")) {
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  id: "viewer-1",
                  email: "me@example.com",
                  name: "Me",
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (query.includes("query GetAllTeamIssuesForPrune")) {
          return new Response(
            JSON.stringify({
              data: {
                team: {
                  issues: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "issue-140",
                        identifier: "LIN-140",
                        title: "Repo-scoped closed issue",
                        description: null,
                        priority: 2,
                        createdAt: now,
                        updatedAt: now,
                        completedAt: now,
                        canceledAt: null,
                        state: { id: "state-done", name: "Done", type: "completed" },
                        labels: { nodes: [] },
                        assignee: { id: "user-me", email: "me@example.com", name: "Me" },
                        parent: null,
                      },
                      {
                        id: "issue-141",
                        identifier: "LIN-141",
                        title: "Out-of-scope closed issue",
                        description: null,
                        priority: 2,
                        createdAt: now,
                        updatedAt: now,
                        completedAt: now,
                        canceledAt: null,
                        state: { id: "state-done", name: "Done", type: "completed" },
                        labels: { nodes: [] },
                        assignee: { id: "user-me", email: "me@example.com", name: "Me" },
                        parent: null,
                      },
                      {
                        id: "issue-142",
                        identifier: "LIN-142",
                        title: "Another user's closed issue",
                        description: null,
                        priority: 2,
                        createdAt: now,
                        updatedAt: now,
                        completedAt: now,
                        canceledAt: null,
                        state: { id: "state-done", name: "Done", type: "completed" },
                        labels: { nodes: [] },
                        assignee: { id: "user-other", email: "other@example.com", name: "Other" },
                        parent: null,
                      },
                    ],
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        throw new Error("Unexpected GraphQL request: " + JSON.stringify(body));
      };
    `;

    const defaultResult = await runInlineCli(repoDir, ["linear", "prune", "--json"], setupSource);
    expect(defaultResult.exitCode).toBe(0);
    expect(defaultResult.stderr).toBe("");

    const defaultPayload = JSON.parse(defaultResult.stdout) as {
      scan_scope: string | undefined;
      ownership_scope: string | null | undefined;
      count: number;
      candidates: Array<{ id: string }>;
    };
    expect(defaultPayload.scan_scope).toBe("repo_cache");
    expect(defaultPayload.ownership_scope).toBeNull();
    expect(defaultPayload.count).toBe(1);
    expect(defaultPayload.candidates.map((candidate) => candidate.id)).toEqual(["LIN-140"]);

    const allResult = await runInlineCli(
      repoDir,
      ["linear", "prune", "--all", "--json"],
      setupSource,
      { LB_TEAM_KEY: "PRN", LINEAR_API_KEY: "linear-test-key" }
    );
    expect(allResult.exitCode).toBe(0);
    expect(allResult.stderr).toBe("");

    const allPayload = JSON.parse(allResult.stdout) as {
      scan_scope: string;
      ownership_scope: string | null;
      count: number;
      candidates: Array<{ id: string; local_id: string | null }>;
    };
    expect(allPayload.scan_scope).toBe("team");
    expect(allPayload.ownership_scope).toBe("viewer");
    expect(allPayload.count).toBe(2);
    expect(allPayload.candidates.map((candidate) => candidate.id)).toEqual(["LIN-140", "LIN-141"]);
    expect(allPayload.candidates.find((candidate) => candidate.id === "LIN-141")?.local_id).toBe(
      null
    );

    const allUsersResult = await runInlineCli(
      repoDir,
      ["linear", "prune", "--all", "--all-users", "--json"],
      setupSource,
      { LB_TEAM_KEY: "PRN", LINEAR_API_KEY: "linear-test-key" }
    );
    expect(allUsersResult.exitCode).toBe(0);
    expect(allUsersResult.stderr).toBe("");

    const allUsersPayload = JSON.parse(allUsersResult.stdout) as {
      scan_scope: string;
      ownership_scope: string | null;
      count: number;
      candidates: Array<{ id: string; local_id: string | null }>;
    };
    expect(allUsersPayload.scan_scope).toBe("team");
    expect(allUsersPayload.ownership_scope).toBe("all_users");
    expect(allUsersPayload.count).toBe(3);
    expect(allUsersPayload.candidates.map((candidate) => candidate.id)).toEqual([
      "LIN-140",
      "LIN-141",
      "LIN-142",
    ]);
  });

  test("rejects --all when explicit issue IDs are provided", async () => {
    const { repoDir } = createRepo();
    const result = await runInlineCli(repoDir, ["linear", "prune", "LIN-140", "--all"], "");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--all can only be used when no explicit issue IDs are provided");
  });

  test("rejects --all-users without --all", async () => {
    const { repoDir } = createRepo();
    const result = await runInlineCli(repoDir, ["linear", "prune", "--all-users"], "");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--all-users can only be used with --all");
  });

  test("exits before archiving when a blocking remote pause is already active", async () => {
    const { repoDir, dbPath } = createRepo();
    const setupSource = `
      import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};
      import { getLinearApiErrorInfoFromResponse } from ${JSON.stringify(GRAPHQL_UTILS_PATH)};
      import { recordRemoteSyncPause } from ${JSON.stringify(REMOTE_SYNC_STATE_PATH)};

      const now = new Date().toISOString();
      cacheIssue({
        id: "LIN-130",
        local_id: "LOCAL-130",
        linear_id: "issue-130",
        linear_identifier: "LIN-130",
        title: "Paused candidate",
        status: "closed",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
        closed_at: now,
      });

      recordRemoteSyncPause(
        getLinearApiErrorInfoFromResponse({
          status: 429,
          headers: {
            "retry-after": "60",
            "x-ratelimit-endpoint-name": "issueArchive",
            "x-ratelimit-endpoint-requests-reset": String(Date.now() + 60_000),
          },
          body: JSON.stringify({
            errors: [
              {
                message: "rate limit exceeded",
                path: ["issueArchive"],
                extensions: {
                  code: "RATELIMITED",
                },
              },
            ],
          }),
        })
      );

      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        if (String(body.query || "").includes("issueArchive")) {
          throw new Error("preflight pause should prevent issueArchive");
        }

        throw new Error("Unexpected GraphQL request: " + JSON.stringify(body));
      };
    `;

    const result = await runInlineCli(
      repoDir,
      ["linear", "prune", "LIN-130", "--yes"],
      setupSource,
      { LINEAR_API_KEY: "linear-test-key" }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Warning:");
    expect(result.stderr).toContain("issueArchive requests");

    const archivedRow = readArchivedRow(dbPath, "LOCAL-130");
    expect(archivedRow?.remote_archived_at).toBeNull();
  });

  test("archives the selected issue remotely and preserves it across stale pruning", async () => {
    const { repoDir, dbPath } = createRepo();
    const setupSource = `
      import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const now = new Date().toISOString();
      cacheIssue({
        id: "LIN-200",
        local_id: "LOCAL-200",
        linear_id: "issue-200",
        linear_identifier: "LIN-200",
        title: "Archive me",
        status: "closed",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
        closed_at: now,
      });

      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        if (String(body.query || "").includes("issueArchive")) {
          return new Response(
            JSON.stringify({
              data: {
                issueArchive: {
                  success: true,
                },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          );
        }

        throw new Error("Unexpected GraphQL request: " + JSON.stringify(body));
      };
    `;

    const result = await runInlineCli(
      repoDir,
      ["linear", "prune", "LIN-200", "--yes", "--json"],
      setupSource,
      { LINEAR_API_KEY: "linear-test-key" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      preview: boolean;
      count: number;
      cleared_remote_pause: boolean;
      archived: Array<{ id: string; title: string }>;
    };

    expect(payload.preview).toBe(false);
    expect(payload.count).toBe(1);
    expect(payload.cleared_remote_pause).toBe(true);
    expect(payload.archived).toHaveLength(1);
    expect(payload.archived[0]).toMatchObject({ id: "LIN-200", title: "Archive me" });

    const archivedRow = readArchivedRow(dbPath, "LOCAL-200");
    expect(archivedRow?.title).toBe("Archive me");
    expect(archivedRow?.remote_archived_at).toBeTruthy();

    const stalePrune = await runPruneStale(repoDir);
    expect(stalePrune.pruned).toBe(0);

    const preservedRow = readArchivedRow(dbPath, "LOCAL-200");
    expect(preservedRow?.local_id).toBe("LOCAL-200");
    expect(preservedRow?.remote_archived_at).toBeTruthy();
  });
});
