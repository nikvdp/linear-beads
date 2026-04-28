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
  const repoDir = mkdtempSync(join(tmpdir(), "lb-issue-comments-cache-"));
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
    import {
      cacheIssue,
      cacheIssueComment,
      createLocalIssueComment,
      getIssueComments,
    } from ${JSON.stringify(DATABASE_UTILS_PATH)};

    cacheIssue({
      id: "LIN-101",
      local_id: "LOCAL-1",
      linear_id: "11111111-1111-4111-8111-111111111111",
      linear_identifier: "LIN-101",
      title: "Comment cache seed",
      status: "open",
      priority: 2,
      sync_status: "synced",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const pending = createLocalIssueComment({
      issueId: "LIN-101",
      body: "Closed: pending reason",
      syncStatus: "pending",
    });

    cacheIssueComment({
      id: "remote-comment-1",
      issue_id: "LIN-101",
      body: "Closed: pending reason",
      author: "nik@example.com",
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      sync_status: "synced",
    });

    cacheIssueComment({
      id: "remote-comment-2",
      issue_id: "LIN-101",
      parent_id: "remote-comment-1",
      body: "Follow-up",
      created_at: "2026-01-03T00:00:00.000Z",
      updated_at: "2026-01-03T00:00:00.000Z",
      sync_status: "synced",
    });

    console.log(JSON.stringify({
      pendingId: pending.id,
      comments: getIssueComments("LIN-101"),
    }));
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

describe("issue comments cache", () => {
  test("stores comments by issue and replaces matching pending local comments", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      pendingId: string;
      comments: Array<{
        id: string;
        issue_id: string;
        issue_local_id?: string;
        parent_id?: string;
        body: string;
        author?: string;
        sync_status?: string;
      }>;
    };

    expect(payload.pendingId.startsWith("LOCAL-COMMENT-")).toBe(true);
    expect(payload.comments.map((comment) => comment.id)).toEqual([
      "remote-comment-1",
      "remote-comment-2",
    ]);
    expect(payload.comments[0].issue_local_id).toBe("LOCAL-1");
    expect(payload.comments[0].author).toBe("nik@example.com");
    expect(payload.comments[1].parent_id).toBe("remote-comment-1");
  });
});
