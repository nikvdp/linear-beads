import { execFileSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { findGitRootDir } from "./config.js";

const WORKTREE_EXCLUDE = ".worktrees/";

export function ensureWorktreeExclude(repoRoot: string): void {
  const infoDir = join(repoRoot, ".git", "info");
  const excludePath = join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });

  const content = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  if (content.split(/\r?\n/).includes(WORKTREE_EXCLUDE)) return;

  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  appendFileSync(excludePath, `${separator}${WORKTREE_EXCLUDE}\n`);
}

export function createRunWorktree(repoRoot: string, runId: string): string {
  const worktreePath = resolve(repoRoot, ".worktrees", runId);
  ensureWorktreeExclude(repoRoot);
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktreePath], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr =
      typeof error === "object" && error && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
  return worktreePath;
}

export function getRepoRoot(): string {
  // This deliberately resolves the main repository from inside a worktree so
  // every lb process shares the main checkout's .lb config and cache.
  const root = findGitRootDir();
  if (!root) throw new Error("Current directory is not inside a git repository.");
  return root;
}
