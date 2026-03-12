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
  const repoDir = mkdtempSync(join(tmpdir(), "lb-sync-watermark-"));
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
    | "prefers_metadata"
    | "falls_back_to_cached_remote"
    | "ignores_pending_local"
    | "advances_only_forward"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import {
      cacheIssue,
      getDatabase,
      getIncrementalSyncTimestamp,
      getIssueUpdateWatermark,
      updateIssueUpdateWatermarkFromIssues,
    } from ${JSON.stringify(DATABASE_UTILS_PATH)};

    const mode = process.argv[1];
    const db = getDatabase();
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [
      "last_sync",
      "2026-03-12T09:42:00.000Z",
    ]);

    if (mode === "prefers_metadata") {
      db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [
        "last_issue_update_watermark",
        "2026-03-12T09:40:00.000Z",
      ]);
    } else if (mode === "falls_back_to_cached_remote") {
      cacheIssue({
        id: "LIN-100",
        title: "Older remote",
        status: "open",
        priority: 2,
        sync_status: "synced",
        created_at: "2026-03-12T09:00:00.000Z",
        updated_at: "2026-03-12T09:35:00.000Z",
      });
      cacheIssue({
        id: "LIN-101",
        title: "Newer remote",
        status: "open",
        priority: 2,
        sync_status: "synced",
        created_at: "2026-03-12T09:10:00.000Z",
        updated_at: "2026-03-12T09:39:00.000Z",
      });
    } else if (mode === "ignores_pending_local") {
      cacheIssue({
        id: "LIN-100",
        title: "Remote issue",
        status: "open",
        priority: 2,
        sync_status: "synced",
        created_at: "2026-03-12T09:00:00.000Z",
        updated_at: "2026-03-12T09:39:00.000Z",
      });
      cacheIssue({
        id: "LOCAL-001",
        title: "Pending local issue",
        status: "open",
        priority: 2,
        sync_status: "pending",
        created_at: "2026-03-12T09:00:00.000Z",
        updated_at: "2026-03-12T09:50:00.000Z",
      });
    } else if (mode === "advances_only_forward") {
      db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [
        "last_issue_update_watermark",
        "2026-03-12T09:40:00.000Z",
      ]);
      updateIssueUpdateWatermarkFromIssues([
        { updated_at: "2026-03-12T09:38:00.000Z" },
        { updated_at: "2026-03-12T09:41:30.000Z" },
      ]);
    }

    console.log(
      JSON.stringify({
        since: getIncrementalSyncTimestamp(),
        watermark: getIssueUpdateWatermark(),
      })
    );
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

describe("incremental sync watermark", () => {
  test("prefers the stored remote issue watermark over last_sync", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "prefers_metadata");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { since: string | null; watermark: string | null };
    expect(payload.since).toBe("2026-03-12T09:40:00.000Z");
    expect(payload.watermark).toBe("2026-03-12T09:40:00.000Z");
  });

  test("falls back to the latest cached remote issue update when watermark metadata is missing", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "falls_back_to_cached_remote");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { since: string | null; watermark: string | null };
    expect(payload.since).toBe("2026-03-12T09:39:00.000Z");
    expect(payload.watermark).toBe("2026-03-12T09:39:00.000Z");
  });

  test("ignores pending local issues when deriving the remote watermark from cache", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "ignores_pending_local");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { since: string | null; watermark: string | null };
    expect(payload.since).toBe("2026-03-12T09:39:00.000Z");
    expect(payload.watermark).toBe("2026-03-12T09:39:00.000Z");
  });

  test("only advances the remote issue watermark when newer updates arrive", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "advances_only_forward");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as { since: string | null; watermark: string | null };
    expect(payload.since).toBe("2026-03-12T09:41:30.000Z");
    expect(payload.watermark).toBe("2026-03-12T09:41:30.000Z");
  });
});
