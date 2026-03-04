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
  const repoDir = mkdtempSync(join(tmpdir(), "lb-sync-key-upsert-"));
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
  mode: "local_then_remote" | "two_remote_dupes"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const script = `
    import { Database } from "bun:sqlite";
    import { cacheIssue } from ${JSON.stringify(DATABASE_UTILS_PATH)};

    const mode = process.argv[1];
    const now = new Date().toISOString();
    const syncKey = "123e4567-e89b-12d3-a456-426614174000";

    if (mode === "local_then_remote") {
      cacheIssue({
        id: "LOCAL-001",
        title: "Local pending issue",
        status: "open",
        priority: 2,
        sync_status: "pending",
        created_at: now,
        updated_at: now,
        sync_key: syncKey,
      });

      cacheIssue({
        id: "LIN-5000",
        linear_id: "uuid-5000",
        linear_identifier: "LIN-5000",
        title: "Remote synced issue",
        status: "open",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
        sync_key: syncKey,
      });
    } else {
      cacheIssue({
        id: "LIN-5000",
        linear_id: "uuid-5000",
        linear_identifier: "LIN-5000",
        title: "Remote dup 1",
        status: "open",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
        sync_key: syncKey,
      });

      cacheIssue({
        id: "LIN-5001",
        linear_id: "uuid-5001",
        linear_identifier: "LIN-5001",
        title: "Remote dup 2",
        status: "open",
        priority: 2,
        sync_status: "synced",
        created_at: now,
        updated_at: now,
        sync_key: syncKey,
      });
    }

    const db = new Database(".lb/cache.db", { readonly: true });
    const rows = db.query(
      "SELECT local_id, linear_identifier, sync_key, title FROM issues WHERE sync_key = ? ORDER BY local_id ASC"
    ).all(syncKey) as Array<{
      local_id: string;
      linear_identifier: string | null;
      sync_key: string | null;
      title: string;
    }>;
    db.close();
    console.log(JSON.stringify({ rows }));
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

describe("sync_key upsert behavior", () => {
  test("merges remote cache writes onto existing local row by sync_key", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "local_then_remote");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      rows: Array<{
        local_id: string;
        linear_identifier: string | null;
        sync_key: string | null;
      }>;
    };

    expect(payload.rows.length).toBe(1);
    expect(payload.rows[0]?.local_id).toBe("LOCAL-001");
    expect(payload.rows[0]?.linear_identifier).toBe("LIN-5000");
    expect(payload.rows[0]?.sync_key).toBeTruthy();
  });

  test("does not crash when multiple remote issues share a sync_key", async () => {
    const repoDir = createRepo();
    const result = await runEval(repoDir, "two_remote_dupes");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      rows: Array<{
        local_id: string;
        linear_identifier: string | null;
        sync_key: string | null;
      }>;
    };

    expect(payload.rows.length).toBe(1);
    expect(payload.rows[0]?.sync_key).toBeTruthy();
  });
});
