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
    import { clearRemoteSyncPause } from ${JSON.stringify(REMOTE_SYNC_STATE_PATH)};
    clearRemoteSyncPause();
    ${setupSource}
    process.argv = ["bun", ${args.map((arg) => JSON.stringify(arg)).join(", ")}];
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

function readArchivedRow(
  dbPath: string,
  localId: string
): {
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

  test("previews close-before-archive for active explicit issues", async () => {
    const { repoDir, dbPath } = createRepo();
    const setupSource = `
      import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const now = new Date().toISOString();
      cacheIssue({
        id: "LIN-121",
        local_id: "LOCAL-121",
        linear_id: "issue-121",
        linear_identifier: "LIN-121",
        title: "Active explicit issue",
        status: "open",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
      });

      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        throw new Error("preview should not call Linear: " + JSON.stringify(body));
      };
    `;

    const result = await runInlineCli(
      repoDir,
      ["linear", "prune", "LIN-121", "--dry-run", "--json"],
      setupSource,
      { LINEAR_API_KEY: "linear-test-key" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      preview: boolean;
      count: number;
      candidates: Array<{ id: string; status: string; pre_archive_action: string | null }>;
    };

    expect(payload.preview).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.candidates[0]).toMatchObject({
      id: "LIN-121",
      status: "open",
      pre_archive_action: "close",
    });

    const archivedRow = readArchivedRow(dbPath, "LOCAL-121");
    expect(archivedRow?.remote_archived_at).toBeNull();
  });

  test("fetches uncached explicit issues before previewing prune", async () => {
    const { repoDir, dbPath } = createRepo();
    const setupSource = `
      const now = new Date().toISOString();

      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body || "{}"));
        const query = String(body.query || "");

        if (query.includes("query GetIssue")) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  id: "issue-122",
                  identifier: "LIN-122",
                  title: "Uncached explicit issue",
                  description: null,
                  priority: 2,
                  createdAt: now,
                  updatedAt: now,
                  completedAt: now,
                  canceledAt: null,
                  state: { id: "state-done", name: "Done", type: "completed" },
                  labels: { nodes: [] },
                  assignee: null,
                  creator: { id: "user-me", email: "me@example.com", name: "Me" },
                  parent: null,
                  children: { nodes: [] },
                  relations: { nodes: [] },
                  inverseRelations: { nodes: [] },
                  attachments: { nodes: [] },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (query.includes("issueArchive")) {
          throw new Error("preview should not call issueArchive");
        }

        throw new Error("Unexpected GraphQL request: " + JSON.stringify(body));
      };
    `;

    const result = await runInlineCli(
      repoDir,
      ["linear", "prune", "LIN-122", "--json"],
      setupSource,
      { LINEAR_API_KEY: "linear-test-key" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      preview: boolean;
      count: number;
      candidates: Array<{ id: string; title: string; pre_archive_action: string | null }>;
    };

    expect(payload.preview).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.candidates[0]).toMatchObject({
      id: "LIN-122",
      title: "Uncached explicit issue",
      pre_archive_action: null,
    });

    const cachedRow = readArchivedRow(dbPath, "LIN-122");
    expect(cachedRow?.title).toBe("Uncached explicit issue");
    expect(cachedRow?.remote_archived_at).toBeNull();
  });

  test("can opt into scanning the current Linear team by issue creator with --mine or --all", async () => {
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
                        assignee: { id: "assignee-me", email: "someone@example.com", name: "Someone" },
                        creator: { id: "user-me", email: "me@example.com", name: "Me" },
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
                        assignee: { id: "assignee-other", email: "else@example.com", name: "Else" },
                        creator: { id: "user-me", email: "me@example.com", name: "Me" },
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
                        assignee: { id: "assignee-me", email: "me@example.com", name: "Me" },
                        creator: { id: "user-other", email: "other@example.com", name: "Other" },
                        parent: null,
                      },
                      {
                        id: "issue-143",
                        identifier: "LIN-143",
                        title: "Active team issue",
                        description: null,
                        priority: 2,
                        createdAt: now,
                        updatedAt: now,
                        completedAt: null,
                        canceledAt: null,
                        state: { id: "state-open", name: "Todo", type: "unstarted" },
                        labels: { nodes: [] },
                        assignee: { id: "assignee-me", email: "me@example.com", name: "Me" },
                        creator: { id: "user-me", email: "me@example.com", name: "Me" },
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

    const mineResult = await runInlineCli(
      repoDir,
      ["linear", "prune", "--mine", "--json"],
      setupSource,
      { LB_TEAM_KEY: "PRN", LINEAR_API_KEY: "linear-test-key" }
    );
    expect(mineResult.exitCode).toBe(0);
    expect(mineResult.stderr).toBe("");

    const minePayload = JSON.parse(mineResult.stdout) as {
      scan_scope: string;
      ownership_scope: string | null;
      count: number;
      candidates: Array<{ id: string; local_id: string | null }>;
    };
    expect(minePayload.scan_scope).toBe("team");
    expect(minePayload.ownership_scope).toBe("viewer");
    expect(minePayload.count).toBe(2);
    expect(minePayload.candidates.map((candidate) => candidate.id)).toEqual(["LIN-140", "LIN-141"]);
    expect(minePayload.candidates.find((candidate) => candidate.id === "LIN-141")?.local_id).toBe(
      null
    );

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
    expect(allPayload.ownership_scope).toBe("all_users");
    expect(allPayload.count).toBe(3);
    expect(allPayload.candidates.map((candidate) => candidate.id)).toEqual([
      "LIN-140",
      "LIN-141",
      "LIN-142",
    ]);
  });

  test("rejects --mine and --all when explicit issue IDs are provided", async () => {
    const { repoDir } = createRepo();
    const mineResult = await runInlineCli(repoDir, ["linear", "prune", "LIN-140", "--mine"], "");
    const allResult = await runInlineCli(repoDir, ["linear", "prune", "LIN-140", "--all"], "");

    expect(mineResult.exitCode).toBe(1);
    expect(mineResult.stdout).toBe("");
    expect(mineResult.stderr).toContain(
      "--mine and --all can only be used when no explicit issue IDs are provided"
    );

    expect(allResult.exitCode).toBe(1);
    expect(allResult.stdout).toBe("");
    expect(allResult.stderr).toContain(
      "--mine and --all can only be used when no explicit issue IDs are provided"
    );
  });

  test("rejects --mine together with --all", async () => {
    const { repoDir } = createRepo();
    const result = await runInlineCli(repoDir, ["linear", "prune", "--mine", "--all"], "");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--mine and --all cannot be used together");
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
          },
          body: JSON.stringify({
            errors: [
              {
                message: "rate limit exceeded",
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
    expect(result.stderr).toContain("all Linear requests are paused");

    const archivedRow = readArchivedRow(dbPath, "LOCAL-130");
    expect(archivedRow?.remote_archived_at).toBeNull();
  });

  test("closes an active explicit issue before archiving with yes", async () => {
    const { repoDir, dbPath } = createRepo();
    const setupSource = `
      import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const now = new Date().toISOString();
      let closedBeforeArchive = false;

      cacheIssue({
        id: "LIN-150",
        local_id: "LOCAL-150",
        linear_id: "issue-150",
        linear_identifier: "LIN-150",
        title: "Close then archive",
        status: "open",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
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

        if (query.includes("query GetWorkflowStates")) {
          return new Response(
            JSON.stringify({
              data: {
                team: {
                  states: {
                    nodes: [{ id: "state-closed", name: "Done", type: "completed" }],
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (query.includes("mutation UpdateIssue")) {
          closedBeforeArchive = true;
          return new Response(
            JSON.stringify({
              data: {
                issueUpdate: {
                  success: true,
                  issue: {
                    id: "issue-150",
                    identifier: "LIN-150",
                    title: "Close then archive",
                    description: null,
                    priority: 2,
                    createdAt: now,
                    updatedAt: now,
                    completedAt: now,
                    canceledAt: null,
                    state: { id: "state-closed", name: "Done", type: "completed" },
                    labels: { nodes: [] },
                    assignee: null,
                    creator: { id: "user-me", email: "me@example.com", name: "Me" },
                    parent: null,
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (query.includes("mutation CreateComment")) {
          return new Response(
            JSON.stringify({ data: { commentCreate: { success: true } } }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (query.includes("issueArchive")) {
          if (!closedBeforeArchive) {
            throw new Error("issueArchive called before issueUpdate");
          }
          return new Response(
            JSON.stringify({
              data: {
                issueArchive: {
                  success: true,
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        throw new Error("Unexpected GraphQL request: " + JSON.stringify(body));
      };
    `;

    const result = await runInlineCli(
      repoDir,
      ["linear", "prune", "LIN-150", "--yes", "--json"],
      setupSource,
      { LB_TEAM_KEY: "PRN", LINEAR_API_KEY: "linear-test-key" }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      preview: boolean;
      count: number;
      archived: Array<{ id: string; status: string; pre_archive_action: string | null }>;
    };

    expect(payload.preview).toBe(false);
    expect(payload.count).toBe(1);
    expect(payload.archived[0]).toMatchObject({
      id: "LIN-150",
      status: "closed",
      pre_archive_action: "close",
    });

    const archivedRow = readArchivedRow(dbPath, "LOCAL-150");
    expect(archivedRow?.remote_archived_at).toBeTruthy();
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
