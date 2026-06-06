import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createLocalOnlyRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-issue-comment-command-"));
  tempDirs.push(repoDir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    throw new Error("Failed to initialize git repo");
  }

  const lbDir = join(repoDir, ".lb");
  mkdirSync(lbDir, { recursive: true });
  writeFileSync(
    join(lbDir, "config.jsonc"),
    `${JSON.stringify({ local_only: true, repo_name: "comment-command" }, null, 2)}\n`
  );
  return repoDir;
}

async function lb(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      LINEAR_API_KEY: "",
      LB_TEAM_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function lbJson<T>(cwd: string, args: string[]): Promise<T> {
  const result = await lb(cwd, [...args, "--json"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `lb ${args.join(" ")} failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return JSON.parse(result.stdout) as T;
}

describe("issue comment commands", () => {
  test("adds, lists, replies, and shows local comments", async () => {
    const repoDir = createLocalOnlyRepo();
    const created = await lbJson<Array<{ id: string }>>(repoDir, ["create", "Comment target"]);
    const issueId = created[0].id;

    const added = await lbJson<Array<{ id: string; body: string }>>(repoDir, [
      "comment",
      "add",
      issueId,
      "First comment",
    ]);
    expect(added[0].body).toBe("First comment");

    const replied = await lbJson<Array<{ parent_id?: string; body: string }>>(repoDir, [
      "comment",
      "reply",
      issueId,
      added[0].id,
      "Reply body",
    ]);
    expect(replied[0].parent_id).toBe(added[0].id);

    const listed = await lbJson<Array<{ body: string }>>(repoDir, ["comment", "list", issueId]);
    expect(listed.map((comment) => comment.body)).toEqual(["First comment", "Reply body"]);

    const shown = await lbJson<Array<{ comments: Array<{ body: string }> }>>(repoDir, [
      "show",
      issueId,
    ]);
    expect(shown[0].comments.map((comment) => comment.body)).toEqual([
      "First comment",
      "Reply body",
    ]);
  });
});
