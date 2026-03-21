import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  shouldPreferRemoteIssueForShow,
  shouldUseCachedIssueImmediatelyForShow,
} from "../src/commands/show.js";

const tempDirs: string[] = [];
const CONFIG_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "config.ts");
const DATABASE_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "database.ts");
const SYNC_UTILS_PATH = join(import.meta.dir, "..", "src", "utils", "sync.ts");

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-sync-context-"));
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

async function runEnsureFresh(
  cwd: string,
  mode: "same_context" | "changed_context" | "best_effort_timeout" | "strict_timeout"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { setRuntimeOverrides } from ${JSON.stringify(CONFIG_UTILS_PATH)};
    import { updateLastSync, updateLastSyncContext } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    import {
      __setSmartSyncRunnerForTests,
      ensureFresh,
      ensureFreshBestEffort,
    } from ${JSON.stringify(SYNC_UTILS_PATH)};

    const mode = process.argv[1];
    const baseContext = JSON.stringify({
      teamKey: "__auto__",
      repoScope: "label",
      repoName: "base-repo",
    });

    setRuntimeOverrides({ repo_name: "base-repo", repo_scope: "label" });
    updateLastSync();
    updateLastSyncContext(baseContext);

    if (mode !== "same_context") {
      setRuntimeOverrides({ repo_name: "other-repo", repo_scope: "label" });
    }

    if (mode === "best_effort_timeout" || mode === "strict_timeout") {
      __setSmartSyncRunnerForTests(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          pushed: { success: 0, failed: 0 },
          pulled: 0,
          type: "incremental",
        };
      });
    }

    try {
      if (mode === "best_effort_timeout") {
        const result = await ensureFreshBestEffort(undefined);
        console.log(
          JSON.stringify({
            synced: result.synced,
            timedOut: result.timedOut,
            error: result.error ? result.error.message : null,
          })
        );
      } else {
        const synced = await ensureFresh(undefined, false);
        console.log(JSON.stringify({ synced, timedOut: false, error: null }));
      }
    } catch (error) {
      console.log(
        JSON.stringify({
          synced: null,
          timedOut: false,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  `;

  const proc = Bun.spawn(["bun", "--eval", script, mode], {
    cwd,
    env: {
      ...process.env,
      LINEAR_API_KEY: "",
      LB_TEAM_KEY: "",
      ...(mode === "best_effort_timeout" ? { LB_SYNC_BEST_EFFORT_TIMEOUT_MS: "10" } : {}),
      ...(mode === "strict_timeout" ? { LB_SYNC_STRICT_TIMEOUT_MS: "10" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

describe("sync context freshness", () => {
  test("show defaults to cache-first for synced cached issues", () => {
    expect(
      shouldUseCachedIssueImmediatelyForShow({
        forceSync: false,
        resolvedId: "LIN-5491",
        hasCachedIssue: true,
      })
    ).toBe(true);

    expect(
      shouldPreferRemoteIssueForShow({
        forceSync: false,
        skipRemote: false,
        resolvedId: "LIN-5491",
        hasCachedIssue: true,
      })
    ).toBe(false);
  });

  test("show still prefers remote when explicitly synced or cache is missing", () => {
    expect(
      shouldUseCachedIssueImmediatelyForShow({
        forceSync: true,
        resolvedId: "LIN-5491",
        hasCachedIssue: true,
      })
    ).toBe(false);

    expect(
      shouldPreferRemoteIssueForShow({
        forceSync: true,
        skipRemote: false,
        resolvedId: "LIN-5491",
        hasCachedIssue: true,
      })
    ).toBe(true);

    expect(
      shouldPreferRemoteIssueForShow({
        forceSync: false,
        skipRemote: false,
        resolvedId: "LIN-5491",
        hasCachedIssue: false,
      })
    ).toBe(true);
  });

  test("does not sync when cache is fresh and context is unchanged", async () => {
    const repoDir = createRepo();
    const result = await runEnsureFresh(repoDir, "same_context");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      synced: boolean | null;
      timedOut: boolean;
      error: string | null;
    };
    expect(payload.error).toBeNull();
    expect(payload.synced).toBe(false);
  });

  test("forces a sync attempt when context changes even if cache is fresh", async () => {
    const repoDir = createRepo();
    const result = await runEnsureFresh(repoDir, "changed_context");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      synced: boolean | null;
      timedOut: boolean;
      error: string | null;
    };
    expect(payload.error).toBeNull();
    expect(payload.synced).toBe(true);
  });

  test("best-effort mode falls back when sync exceeds timeout", async () => {
    const repoDir = createRepo();
    const result = await runEnsureFresh(repoDir, "best_effort_timeout");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      synced: boolean | null;
      timedOut: boolean;
      error: string | null;
    };
    expect(payload.synced).toBe(false);
    expect(payload.timedOut).toBe(true);
    expect(payload.error).toContain("timed out");
  });

  test("strict mode surfaces timeout error", async () => {
    const repoDir = createRepo();
    const result = await runEnsureFresh(repoDir, "strict_timeout");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      synced: boolean | null;
      timedOut: boolean;
      error: string | null;
    };
    expect(payload.synced).toBeNull();
    expect(payload.error).toContain("timed out");
  });
});
