import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { toLinearRichDescription } from "../src/utils/linear.js";

const LINEAR_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "linear.ts");
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-local-ref-upgrade-"));
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
  mode:
    | "local_alias_immediate_resolution"
    | "local_alias_deferred_upgrade"
    | "local_alias_update_flow"
    | "local_alias_status_only_auto_heal"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { toLinearRichDescription, updateIssue } from ${JSON.stringify(LINEAR_UTILS_PATH)};
    import { cacheIssue, replaceIssueId, generateIssueSyncKey } from ${JSON.stringify(DATABASE_UTILS_PATH)};

    const mode = process.argv[1];
    const now = "2026-03-06T00:00:00.000Z";

    cacheIssue({
      id: "LOCAL-035",
      title: "Alias target",
      description: "target",
      status: "open",
      priority: 2,
      created_at: now,
      updated_at: now,
      sync_key: generateIssueSyncKey(),
      sync_status: "pending",
    });

    const payload = {};

    if (mode === "local_alias_immediate_resolution") {
      replaceIssueId("LOCAL-035", "LIN-4465", "uuid-4465");
      payload.output = await toLinearRichDescription("blocks LOCAL-035", {
        workspaceUrlKey: "linear-beads",
      });
      console.log(JSON.stringify(payload));
      process.exit(0);
    }

    if (mode === "local_alias_deferred_upgrade") {
      payload.before = await toLinearRichDescription("blocks LOCAL-035", {
        workspaceUrlKey: "linear-beads",
      });
      replaceIssueId("LOCAL-035", "LIN-4465", "uuid-4465");
      payload.after = await toLinearRichDescription("blocks LOCAL-035", {
        workspaceUrlKey: "linear-beads",
      });
      console.log(JSON.stringify(payload));
      process.exit(0);
    }

    if (mode === "local_alias_update_flow") {
      replaceIssueId("LOCAL-035", "LIN-4465", "uuid-4465");

      const openState = { id: "state-open", name: "Todo", type: "unstarted" };
      const capturedInputs = [];
      const fakeClient = {
        async request(query, variables = {}) {
          if (query.includes("GetWorkflowStates")) {
            return {
              team: {
                states: {
                  nodes: [openState],
                },
              },
            };
          }

          if (query.includes("GetWorkspaceUrlKey")) {
            return {
              viewer: {
                url: "https://linear.app/linear-beads",
                organization: {
                  urlKey: "linear-beads",
                },
              },
            };
          }

          if (query.includes("mutation UpdateIssue")) {
            capturedInputs.push(variables.input || {});
            return {
              issueUpdate: {
                success: true,
                issue: {
                  id: "uuid-parent",
                  identifier: "LIN-5000",
                  title: "Parent issue",
                  description: variables.input?.description || null,
                  priority: 2,
                  createdAt: now,
                  updatedAt: now,
                  completedAt: null,
                  canceledAt: null,
                  state: openState,
                  labels: { nodes: [] },
                  assignee: null,
                  parent: null,
                },
              },
            };
          }

          throw new Error("Unexpected query: " + query.slice(0, 80));
        },
      };

      await updateIssue(
        "LIN-5000",
        { description: "test reference to LOCAL-035" },
        "team-1",
        { client: fakeClient }
      );

      payload.capturedDescription = capturedInputs[0]?.description;
      console.log(JSON.stringify(payload));
      process.exit(0);
    }

    if (mode === "local_alias_status_only_auto_heal") {
      const unresolvedDescription = await toLinearRichDescription("test reference to LOCAL-035", {
        workspaceUrlKey: "linear-beads",
      });

      replaceIssueId("LOCAL-035", "LIN-4465", "uuid-4465");

      const openState = { id: "state-open", name: "Todo", type: "unstarted" };
      const startedState = { id: "state-started", name: "In Progress", type: "started" };
      const capturedInputs = [];
      const fakeClient = {
        async request(query, variables = {}) {
          if (query.includes("GetWorkflowStates")) {
            return {
              team: {
                states: {
                  nodes: [openState, startedState],
                },
              },
            };
          }

          if (query.includes("GetIssueDescriptionForHeal")) {
            return {
              issue: {
                description: unresolvedDescription,
              },
            };
          }

          if (query.includes("GetWorkspaceUrlKey")) {
            return {
              viewer: {
                url: "https://linear.app/linear-beads",
                organization: {
                  urlKey: "linear-beads",
                },
              },
            };
          }

          if (query.includes("mutation UpdateIssue")) {
            capturedInputs.push(variables.input || {});
            return {
              issueUpdate: {
                success: true,
                issue: {
                  id: "uuid-parent",
                  identifier: "LIN-5000",
                  title: "Parent issue",
                  description: (variables.input?.description as string | undefined) || unresolvedDescription,
                  priority: 2,
                  createdAt: now,
                  updatedAt: now,
                  completedAt: null,
                  canceledAt: null,
                  state: startedState,
                  labels: { nodes: [] },
                  assignee: null,
                  parent: null,
                },
              },
            };
          }

          throw new Error("Unexpected query: " + query.slice(0, 80));
        },
      };

      await updateIssue("LIN-5000", { status: "in_progress" }, "team-1", { client: fakeClient });

      payload.unresolvedDescription = unresolvedDescription;
      payload.capturedDescription = capturedInputs[0]?.description;
      payload.capturedStateId = capturedInputs[0]?.stateId;
      console.log(JSON.stringify(payload));
      process.exit(0);
    }
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

describe("toLinearRichDescription", () => {
  test("rewrites literal team issue IDs to workspace-scoped Linear URLs", async () => {
    const output = await toLinearRichDescription("Discuss LIN-4274 and ABC-99", {
      workspaceUrlKey: "linear-beads",
    });
    expect(output).toBe(
      "Discuss https://linear.app/linear-beads/issue/LIN-4274 and https://linear.app/linear-beads/issue/ABC-99"
    );
  });

  test("does not rewrite unresolved LOCAL IDs", async () => {
    const output = await toLinearRichDescription("Depends on LOCAL-001 before LIN-4274", {
      workspaceUrlKey: "linear-beads",
    });
    expect(output).toBe(
      "Depends on LOCAL-001 before https://linear.app/linear-beads/issue/LIN-4274"
    );
  });

  test("does not rewrite IDs already inside markdown links", async () => {
    const input =
      "Already linked [LIN-4274](https://linear.app/linear-beads/issue/LIN-4274/some-slug) and raw LIN-4387";
    const output = await toLinearRichDescription(input, {
      workspaceUrlKey: "linear-beads",
    });
    expect(output).toBe(
      "Already linked [LIN-4274](https://linear.app/linear-beads/issue/LIN-4274/some-slug) and raw https://linear.app/linear-beads/issue/LIN-4387"
    );
  });

  test("keeps existing angle-bracket Linear links unchanged while encoding raw literals", async () => {
    const input =
      "Already [LIN-4274](<https://linear.app/linear-beads/issue/LIN-4274/some-slug>) plus raw LIN-4387";
    const output = await toLinearRichDescription(input, {
      workspaceUrlKey: "linear-beads",
    });
    expect(output).toBe(
      "Already [LIN-4274](<https://linear.app/linear-beads/issue/LIN-4274/some-slug>) plus raw https://linear.app/linear-beads/issue/LIN-4387"
    );
  });

  test("does not rewrite canonical IDs that appear inside plain URLs", async () => {
    const input = "Direct URL https://linear.app/issue/LIN-4454 should stay untouched";
    const output = await toLinearRichDescription(input, {
      workspaceUrlKey: "linear-beads",
    });
    expect(output).toBe(input);
  });

  test("keeps undefined descriptions unchanged", async () => {
    expect(
      await toLinearRichDescription(undefined, { workspaceUrlKey: "linear-beads" })
    ).toBeUndefined();
  });

  test("immediately upgrades LOCAL aliases when a LIN mapping is already known", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "local_alias_immediate_resolution");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { output: string };
    expect(payload.output).toBe("blocks https://linear.app/linear-beads/issue/LIN-4465");
  });

  test("preserves unresolved LOCAL refs first, then upgrades them after alias reconciliation", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "local_alias_deferred_upgrade");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { before: string; after: string };
    expect(payload.before).toContain("https://lb-ref.invalid/issue?");
    expect(payload.before).toContain("hint=LOCAL-035");
    expect(payload.after).toBe("blocks https://linear.app/linear-beads/issue/LIN-4465");
  });

  test("end-to-end update flow sends resolved remote target when LOCAL alias is already known", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "local_alias_update_flow");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { capturedDescription: string };
    expect(payload.capturedDescription).toBe(
      "test reference to https://linear.app/linear-beads/issue/LIN-4465"
    );
  });

  test("status-only updates auto-heal previously unresolved LOCAL refs after alias reconciliation", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "local_alias_status_only_auto_heal");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      unresolvedDescription: string;
      capturedDescription: string;
      capturedStateId: string;
    };
    expect(payload.unresolvedDescription).toContain("https://lb-ref.invalid/issue?");
    expect(payload.capturedDescription).toBe(
      "test reference to https://linear.app/linear-beads/issue/LIN-4465"
    );
    expect(payload.capturedStateId).toBe("state-started");
  });
});
