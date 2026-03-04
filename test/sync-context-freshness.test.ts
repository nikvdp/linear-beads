import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
  mode: "same_context" | "changed_context"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { setRuntimeOverrides } from ${JSON.stringify(CONFIG_UTILS_PATH)};
    import { updateLastSync, updateLastSyncContext } from ${JSON.stringify(DATABASE_UTILS_PATH)};
    import { ensureFresh } from ${JSON.stringify(SYNC_UTILS_PATH)};

    const mode = process.argv[1];
    const baseContext = JSON.stringify({
      teamKey: "__auto__",
      repoScope: "label",
      repoName: "base-repo",
    });

    setRuntimeOverrides({ repo_name: "base-repo", repo_scope: "label" });
    updateLastSync();
    updateLastSyncContext(baseContext);

    if (mode === "changed_context") {
      setRuntimeOverrides({ repo_name: "other-repo", repo_scope: "label" });
    }

    try {
      const synced = await ensureFresh(undefined, false);
      console.log(JSON.stringify({ synced, error: null }));
    } catch (error) {
      console.log(
        JSON.stringify({
          synced: null,
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
  test("does not sync when cache is fresh and context is unchanged", async () => {
    const repoDir = createRepo();
    const result = await runEnsureFresh(repoDir, "same_context");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { synced: boolean | null; error: string | null };
    expect(payload.error).toBeNull();
    expect(payload.synced).toBe(false);
  });

  test("forces a sync attempt when context changes even if cache is fresh", async () => {
    const repoDir = createRepo();
    const result = await runEnsureFresh(repoDir, "changed_context");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { synced: boolean | null; error: string | null };
    expect(payload.error).toBeNull();
    expect(payload.synced).toBe(true);
  });
});
