import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tempDirs: string[] = [];
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-agent-runs-"));
  tempDirs.push(repoDir);
  Bun.spawnSync(["git", "init", "-q"], { cwd: repoDir });
  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  return repoDir;
}

async function runEval(cwd: string, script: string) {
  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd,
    env: { ...process.env, LB_TEAM_KEY: "", LINEAR_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    exitCode: await proc.exited,
  };
}

describe("agent run persistence", () => {
  test("creates, updates, gets, and filters runs", async () => {
    const repoDir = createRepo();
    const script = `
      import {
        createAgentRun,
        generateAgentRunId,
        getAgentRun,
        getRunningAgentRuns,
        listAgentRuns,
        updateAgentRun,
      } from ${JSON.stringify(DATABASE_UTILS_PATH)};

      const firstId = generateAgentRunId();
      const secondId = generateAgentRunId();
      createAgentRun({ id: firstId, issue_id: "LOCAL-1", agent_name: "codex" });
      createAgentRun({ id: secondId, issue_id: "LOCAL-2", agent_name: "claude" });
      updateAgentRun(firstId, {
        pid: 1234,
        status: "done",
        ended_at: "2026-07-12T00:00:00.000Z",
        log_path: "/tmp/first.log",
        workdir: "/tmp/first",
      });

      console.log(JSON.stringify({
        first: getAgentRun(firstId),
        all: listAgentRuns(),
        done: listAgentRuns({ status: "done" }),
        running: getRunningAgentRuns(),
      }));
    `;
    const result = await runEval(repoDir, script);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout);
    expect(payload.first).toMatchObject({
      issue_id: "LOCAL-1",
      pid: 1234,
      status: "done",
      log_path: "/tmp/first.log",
      workdir: "/tmp/first",
    });
    expect(payload.all).toHaveLength(2);
    expect(payload.done.map((run: { issue_id: string }) => run.issue_id)).toEqual(["LOCAL-1"]);
    expect(payload.running.map((run: { issue_id: string }) => run.issue_id)).toEqual([
      "LOCAL-2",
    ]);
  });

  test("accepts concurrent writers", async () => {
    const repoDir = createRepo();
    const script = (id: string) => `
      import { createAgentRun } from ${JSON.stringify(DATABASE_UTILS_PATH)};
      createAgentRun({ id: ${JSON.stringify(id)}, issue_id: ${JSON.stringify(
        `LOCAL-${id}`
      )}, agent_name: "codex" });
    `;

    const [first, second] = await Promise.all([
      runEval(repoDir, script("run-one")),
      runEval(repoDir, script("run-two")),
    ]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(second.stderr).toBe("");
  });
});
