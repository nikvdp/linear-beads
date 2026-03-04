import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

const LINEAR_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "linear.ts");
const CONFIG_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "config.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-sync-key-hidden-"));
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
  return repoDir;
}

async function runEval(
  cwd: string,
  mode: "create_uses_hidden_uuid" | "find_by_uuid_fast_path" | "legacy_marker_fallback"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { createIssue, findIssueBySyncKey } from ${JSON.stringify(LINEAR_UTILS_PATH)};
    import { getRepoLabel } from ${JSON.stringify(CONFIG_UTILS_PATH)};

    const mode = process.argv[1];
    const repoLabel = getRepoLabel();
    const syncKey = "123e4567-e89b-12d3-a456-426614174000";
    const now = "2026-03-04T00:00:00.000Z";
    let markerScanCalls = 0;
    let capturedCreateInput = null;

    const fakeClient = {
      async request(query, variables = {}) {
        if (query.includes("GetWorkflowStates")) {
          return {
            team: {
              states: {
                nodes: [
                  { id: "state-open", name: "Todo", type: "unstarted" },
                  { id: "state-progress", name: "In Progress", type: "started" },
                ],
              },
            },
          };
        }

        if (query.includes("GetLabelsPage")) {
          return {
            team: {
              labels: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "lbl-repo", name: repoLabel }],
              },
            },
          };
        }

        if (query.includes("mutation CreateIssue")) {
          capturedCreateInput = variables.input || null;
          return {
            issueCreate: {
              success: true,
              issue: {
                id: variables.input.id || "auto-generated-id",
                identifier: "LIN-9001",
                title: variables.input.title,
                description: variables.input.description,
                priority: variables.input.priority,
                createdAt: now,
                updatedAt: now,
                completedAt: null,
                canceledAt: null,
                state: { id: "state-open", name: "Todo", type: "unstarted" },
                labels: { nodes: [{ id: "lbl-repo", name: repoLabel }] },
                assignee: null,
                parent: null,
              },
            },
          };
        }

        if (query.includes("GetIssueBySyncKeyId")) {
          if (mode === "legacy_marker_fallback") {
            return { issue: null };
          }

          return {
            issue: {
              id: syncKey,
              identifier: "LIN-9002",
              title: "UUID sync key match",
              description: "Body without marker",
              priority: 2,
              createdAt: now,
              updatedAt: now,
              completedAt: null,
              canceledAt: null,
              state: { id: "state-open", name: "Todo", type: "unstarted" },
              labels: { nodes: [{ id: "lbl-repo", name: repoLabel }] },
              assignee: null,
              parent: null,
            },
          };
        }

        if (query.includes("FindIssueBySyncKey")) {
          markerScanCalls += 1;
          if (mode !== "legacy_marker_fallback") {
            return {
              team: {
                issues: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            };
          }

          return {
            team: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "legacy-uuid",
                    identifier: "LIN-9003",
                    title: "Legacy marker match",
                    description: "Legacy body\\n\\n<!-- lb:sync_key=" + syncKey + " -->",
                    priority: 2,
                    createdAt: now,
                    updatedAt: now,
                    completedAt: null,
                    canceledAt: null,
                    state: { id: "state-open", name: "Todo", type: "unstarted" },
                    labels: { nodes: [{ id: "lbl-repo", name: repoLabel }] },
                    assignee: null,
                    parent: null,
                  },
                ],
              },
            },
          };
        }

        throw new Error("Unexpected query in fake client: " + query.slice(0, 80));
      },
    };

    if (mode === "create_uses_hidden_uuid") {
      const created = await createIssue({
        title: "Create test",
        description: "Body line",
        priority: 2,
        teamId: "team-1",
        syncKey,
        client: fakeClient,
      });

      console.log(
        JSON.stringify({
          repoName: ${JSON.stringify(basename(cwd))},
          created,
          capturedCreateInput,
        })
      );
      process.exit(0);
    }

    const found = await findIssueBySyncKey("team-1", syncKey, { client: fakeClient });
    console.log(JSON.stringify({ found, markerScanCalls }));
  `;

  const proc = Bun.spawn(["bun", "--eval", script, mode], {
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

describe("hidden sync key metadata path", () => {
  test("creates issues with sync key in UUID field and no description marker", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "create_uses_hidden_uuid");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      created: { linear_id?: string; description?: string };
      capturedCreateInput: { id?: string; description?: string };
    };

    expect(payload.capturedCreateInput?.id).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(payload.capturedCreateInput?.description).toBe("Body line");
    expect(payload.capturedCreateInput?.description).not.toContain("lb:sync_key=");
    expect(payload.created?.linear_id).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(payload.created?.description).toBe("Body line");
  });

  test("resolves UUID-path sync keys without marker scan and backfills sync_key in-memory", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "find_by_uuid_fast_path");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      found: { id: string; linear_id: string; sync_key?: string } | null;
      markerScanCalls: number;
    };

    expect(payload.found).not.toBeNull();
    expect(payload.found?.id).toBe("LIN-9002");
    expect(payload.found?.linear_id).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(payload.found?.sync_key).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(payload.markerScanCalls).toBe(0);
  });

  test("falls back to legacy marker scan for older issues", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "legacy_marker_fallback");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      found: { id: string; sync_key?: string; description?: string } | null;
      markerScanCalls: number;
    };

    expect(payload.found).not.toBeNull();
    expect(payload.found?.id).toBe("LIN-9003");
    expect(payload.found?.sync_key).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(payload.found?.description).toBe("Legacy body");
    expect(payload.markerScanCalls).toBe(1);
  });
});
