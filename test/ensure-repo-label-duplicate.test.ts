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
  const repoDir = mkdtempSync(join(tmpdir(), "lb-label-dup-"));
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

async function runEval(cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { ensureRepoLabel } from ${JSON.stringify(LINEAR_UTILS_PATH)};

    let labelQueryCalls = 0;
    let createCalls = 0;

    const fakeClient = {
      async request(query, _variables) {
        if (query.includes("GetLabelsPage")) {
          labelQueryCalls += 1;
          if (labelQueryCalls === 1) {
            return {
              team: {
                labels: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            };
          }
          return {
            team: {
              labels: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "lbl-1", name: "repo:neomux" }],
              },
            },
          };
        }

        if (query.includes("CreateLabel")) {
          createCalls += 1;
          throw new Error(
            "duplicate label name: Label \\"repo:neomux\\" already exists in team Linear-beads."
          );
        }

        throw new Error("Unexpected query in fake client");
      },
    };

    const first = await ensureRepoLabel("team-1", {
      client: fakeClient,
      repoLabel: "repo:neomux",
    });
    const second = await ensureRepoLabel("team-1", {
      client: fakeClient,
      repoLabel: "repo:neomux",
    });

    console.log(JSON.stringify({ first, second, labelQueryCalls, createCalls }));
  `;

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

describe("ensureRepoLabel duplicate handling", () => {
  test("falls back to fetching existing label when create returns duplicate-name error", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      first: string;
      second: string;
      labelQueryCalls: number;
      createCalls: number;
    };

    expect(payload.first).toBe("lbl-1");
    expect(payload.second).toBe("lbl-1");
    expect(payload.createCalls).toBe(1);
    expect(payload.labelQueryCalls).toBe(2);
  });
});
