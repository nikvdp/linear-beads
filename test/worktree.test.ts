import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRunWorktree, ensureWorktreeExclude } from "../src/utils/worktree.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "lb test",
      GIT_AUTHOR_EMAIL: "lb@example.com",
      GIT_COMMITTER_NAME: "lb test",
      GIT_COMMITTER_EMAIL: "lb@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

describe("run worktrees", () => {
  test("creates a detached worktree and excludes its parent directory once", () => {
    const repo = mkdtempSync(join(tmpdir(), "lb-worktree-"));
    tempDirs.push(repo);
    git(repo, "init", "-q");
    writeFileSync(join(repo, "README.md"), "fixture\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-qm", "fixture");

    const worktree = createRunWorktree(repo, "run-test");
    ensureWorktreeExclude(repo);

    expect(existsSync(worktree)).toBe(true);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    const excludeLines = readFileSync(join(repo, ".git", "info", "exclude"), "utf-8")
      .split(/\r?\n/)
      .filter((line) => line === ".worktrees/");
    expect(excludeLines).toEqual([".worktrees/"]);
  });
});
