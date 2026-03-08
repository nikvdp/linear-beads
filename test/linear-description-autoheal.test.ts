import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const LINEAR_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "linear.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-linkify-heal-"));
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
    | "update_auto_heals"
    | "update_skips_when_already_rich"
    | "update_skips_backticked_generic_link"
    | "update_heals_generic_link_fallback"
    | "update_heals_malformed_raw_url_link"
    | "close_auto_heals"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { updateIssue, closeIssue } from ${JSON.stringify(LINEAR_UTILS_PATH)};

    const mode = process.argv[1];
    const now = "2026-03-05T00:00:00.000Z";
    const openState = { id: "state-open", name: "Todo", type: "unstarted" };
    const closedState = { id: "state-closed", name: "Done", type: "completed" };
    const issueId = "LIN-9000";
    const capturedInputs = [];
    let healReadCalls = 0;

    const existingDescription =
      mode === "update_skips_when_already_rich"
        ? "Already rich [LIN-4274](https://linear.app/linear-beads/issue/LIN-4274)"
        : mode === "update_skips_backticked_generic_link"
          ? ${JSON.stringify("Keep `[LIN-4274](https://linear.app/issue/LIN-4274)` literal")}
        : mode === "update_heals_generic_link_fallback"
          ? "Already fallback [LIN-4274](https://linear.app/issue/LIN-4274)"
          : mode === "update_heals_malformed_raw_url_link"
            ? "Broken [https://linear.app/linear-beads/issue/LIN-4274:](<https://linear.app/linear-beads/issue/LIN-4274:>)"
          : "Legacy literal LIN-4274 reference";

    const fakeClient = {
      async request(query, variables = {}) {
        if (query.includes("GetWorkflowStates")) {
          return {
            team: {
              states: {
                nodes: [openState, closedState],
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

        if (query.includes("GetIssueDescriptionForHeal")) {
          healReadCalls += 1;
          return {
            issue: {
              description: existingDescription,
            },
          };
        }

        if (query.includes("mutation UpdateIssue")) {
          capturedInputs.push(variables.input || {});
          const state = variables.input?.stateId === "state-closed" ? closedState : openState;
          const responseDescription = variables.input?.description || existingDescription;

          return {
            issueUpdate: {
              success: true,
              issue: {
                id: "uuid-1",
                identifier: issueId,
                title: variables.input?.title || "Sample title",
                description: responseDescription,
                priority: variables.input?.priority ?? 2,
                createdAt: now,
                updatedAt: now,
                completedAt: state.type === "completed" ? now : null,
                canceledAt: null,
                state,
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

    if (mode === "close_auto_heals") {
      await closeIssue(issueId, "team-1", undefined, { client: fakeClient });
    } else {
      await updateIssue(issueId, { title: "Updated title" }, "team-1", { client: fakeClient });
    }

    console.log(JSON.stringify({ capturedInputs, healReadCalls }));
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

describe("Linear description auto-heal on update paths", () => {
  test("auto-heals legacy literal references on update when description not explicitly provided", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "update_auto_heals");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      capturedInputs: Array<{ description?: string }>;
      healReadCalls: number;
    };

    expect(payload.healReadCalls).toBe(1);
    expect(payload.capturedInputs[0]?.description).toBe(
      "Legacy literal <https://linear.app/linear-beads/issue/LIN-4274> reference"
    );
  });

  test("does not add redundant description writes when already rich", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "update_skips_when_already_rich");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      capturedInputs: Array<{ description?: string }>;
      healReadCalls: number;
    };

    expect(payload.healReadCalls).toBe(1);
    expect(payload.capturedInputs[0]?.description).toBeUndefined();
  });

  test("auto-heals generic Linear markdown fallback links once workspace slug is known", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "update_heals_generic_link_fallback");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      capturedInputs: Array<{ description?: string }>;
      healReadCalls: number;
    };

    expect(payload.healReadCalls).toBe(1);
    expect(payload.capturedInputs[0]?.description).toBe(
      "Already fallback <https://linear.app/linear-beads/issue/LIN-4274>"
    );
  });

  test("does not heal generic Linear markdown links inside backticks", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "update_skips_backticked_generic_link");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      capturedInputs: Array<{ description?: string }>;
      healReadCalls: number;
    };

    expect(payload.healReadCalls).toBe(1);
    expect(payload.capturedInputs[0]?.description).toBeUndefined();
  });

  test("auto-heals malformed raw-url labels into safe mention URLs", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "update_heals_malformed_raw_url_link");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      capturedInputs: Array<{ description?: string }>;
      healReadCalls: number;
    };

    expect(payload.healReadCalls).toBe(1);
    expect(payload.capturedInputs[0]?.description).toBe(
      "Broken <https://linear.app/linear-beads/issue/LIN-4274>:"
    );
  });

  test("auto-heals legacy literal references when closing an issue", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "close_auto_heals");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      capturedInputs: Array<{ description?: string; stateId?: string }>;
      healReadCalls: number;
    };

    expect(payload.healReadCalls).toBe(1);
    expect(payload.capturedInputs[0]?.stateId).toBe("state-closed");
    expect(payload.capturedInputs[0]?.description).toBe(
      "Legacy literal <https://linear.app/linear-beads/issue/LIN-4274> reference"
    );
  });
});
