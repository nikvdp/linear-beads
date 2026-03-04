import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo(userVersion?: number): { repoDir: string; dbPath: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-migrate-status-"));
  tempDirs.push(repoDir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    const stderr = init.stderr ? Buffer.from(init.stderr).toString("utf8") : "";
    throw new Error(`Failed to init git repo: ${stderr}`);
  }

  const dbPath = join(repoDir, ".lb", "cache.db");
  if (userVersion !== undefined) {
    mkdirSync(join(repoDir, ".lb"), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`PRAGMA user_version = ${userVersion}`);
    db.close();
  }

  return { repoDir, dbPath };
}

function readUserVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null;
    return row?.user_version ?? 0;
  } finally {
    db.close();
  }
}

async function runLb(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, LB_TEAM_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("migrate status command", () => {
  test("reports uninitialized repo when cache.db does not exist", async () => {
    const { repoDir } = createRepo();
    const result = await runLb(repoDir, "migrate", "status", "--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      db_exists: boolean;
      schema_version: number;
      latest_schema_version: number;
      migrated_to_local_ids: boolean;
      needs_migration: boolean;
    };

    expect(payload.db_exists).toBe(false);
    expect(payload.schema_version).toBe(0);
    expect(payload.latest_schema_version).toBe(8);
    expect(payload.migrated_to_local_ids).toBe(false);
    expect(payload.needs_migration).toBe(false);
  });

  test("reports legacy schema and does not mutate DB while checking status", async () => {
    const { repoDir, dbPath } = createRepo(5);
    const before = readUserVersion(dbPath);

    const result = await runLb(repoDir, "migrate", "status", "--json");
    const after = readUserVersion(dbPath);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(before).toBe(5);
    expect(after).toBe(5);

    const payload = JSON.parse(result.stdout) as {
      db_exists: boolean;
      schema_version: number;
      migrated_to_local_ids: boolean;
      up_to_date: boolean;
      needs_migration: boolean;
    };

    expect(payload.db_exists).toBe(true);
    expect(payload.schema_version).toBe(5);
    expect(payload.migrated_to_local_ids).toBe(false);
    expect(payload.up_to_date).toBe(false);
    expect(payload.needs_migration).toBe(true);
  });

  test("reports up-to-date schema", async () => {
    const { repoDir } = createRepo(8);
    const result = await runLb(repoDir, "migrate", "status", "--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout) as {
      db_exists: boolean;
      schema_version: number;
      migrated_to_local_ids: boolean;
      up_to_date: boolean;
      needs_migration: boolean;
    };

    expect(payload.db_exists).toBe(true);
    expect(payload.schema_version).toBe(8);
    expect(payload.migrated_to_local_ids).toBe(true);
    expect(payload.up_to_date).toBe(true);
    expect(payload.needs_migration).toBe(false);
  });
});
