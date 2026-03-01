import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { parse as parseJsonc } from "jsonc-parser";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURE_DIR = join(import.meta.dir, "fixtures", "pre-localid");
const MANIFEST_PATH = join(FIXTURE_DIR, "manifest.json");

type FixtureEntry = {
  name: string;
  archive: string;
  schema_user_version: number;
  description: string;
};

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
  captured_at: string;
  fixtures: FixtureEntry[];
};

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function extractFixture(entry: FixtureEntry): string {
  const tempDir = mkdtempSync(join(tmpdir(), `lb-pre-localid-${entry.name}-`));
  tempDirs.push(tempDir);

  const archivePath = join(FIXTURE_DIR, entry.archive);
  if (!existsSync(archivePath)) {
    throw new Error(`Missing fixture archive: ${archivePath}`);
  }

  const untar = Bun.spawnSync(["tar", "-xzf", archivePath, "-C", tempDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (untar.exitCode !== 0) {
    const stderr = untar.stderr ? Buffer.from(untar.stderr).toString("utf8") : "";
    throw new Error(`Failed to extract fixture ${entry.name}: ${stderr}`);
  }

  return join(tempDir, entry.name);
}

async function lb(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, LB_TEAM_KEY: process.env.LB_TEAM_KEY || "LIN" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function lbJson<T>(cwd: string, ...args: string[]): Promise<T> {
  const result = await lb(cwd, ...args, "--json");
  if (result.exitCode !== 0) {
    throw new Error(
      `lb ${args.join(" ")} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return JSON.parse(result.stdout) as T;
}

function getUserVersion(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  db.close();
  return row.user_version;
}

describe("pre-localid fixture migrations", () => {
  for (const entry of manifest.fixtures) {
    test(`migrates ${entry.name} to schema v6`, async () => {
      const repoDir = extractFixture(entry);
      const dbPath = join(repoDir, ".lb", "cache.db");

      expect(getUserVersion(dbPath)).toBe(entry.schema_user_version);

      const list = await lbJson<Array<{ id: string; title: string }>>(repoDir, "list", "--all");
      expect(Array.isArray(list)).toBe(true);

      const migratedDb = new Database(dbPath);
      const version = migratedDb.query("PRAGMA user_version").get() as { user_version: number };
      expect(version.user_version).toBe(6);

      const columns = migratedDb.query("PRAGMA table_info(issues)").all() as Array<{
        name: string;
      }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("local_id");
      expect(names).toContain("linear_id");
      expect(names).toContain("linear_identifier");
      expect(names).not.toContain("identifier");

      const backupRow = migratedDb
        .query("SELECT value FROM metadata WHERE key = 'migration_backup_v6'")
        .get() as {
        value: string;
      } | null;
      expect(backupRow).not.toBeNull();
      expect(backupRow?.value).toContain("/.lb/backups/cache-pre-v6-");
      expect(backupRow?.value ? existsSync(backupRow.value) : false).toBe(true);
      migratedDb.close();

      const repoConfigPath = join(repoDir, ".lb", "config.jsonc");
      const repoConfigRaw = readFileSync(repoConfigPath, "utf8");
      const repoConfig = parseJsonc(repoConfigRaw) as { min_cli_version?: string };
      expect(repoConfig.min_cli_version).toBe("v16");
    });
  }

  test("resolves legacy LOCAL alias via issue_id_map after migration", async () => {
    const entry = manifest.fixtures.find(
      (fixture) => fixture.name === "pre-localid-mapped-local-alias"
    );
    if (!entry) {
      throw new Error("Missing fixture pre-localid-mapped-local-alias");
    }

    const repoDir = extractFixture(entry);
    const shown = await lbJson<Array<{ id: string; title: string }>>(repoDir, "show", "LOCAL-0999");
    expect(shown[0].id).toBe("LIN-9200");
    expect(shown[0].title).toContain("Fixture issue previously replaced");
  });

  test("keeps pending local issue/outbox linkage stable after migration", async () => {
    const entry = manifest.fixtures.find(
      (fixture) => fixture.name === "pre-localid-pending-outbox"
    );
    if (!entry) {
      throw new Error("Missing fixture pre-localid-pending-outbox");
    }

    const repoDir = extractFixture(entry);
    await lb(repoDir, "list", "--all");

    const db = new Database(join(repoDir, ".lb", "cache.db"));
    const pending = db
      .query(
        `
          SELECT local_id, linear_identifier, sync_status
          FROM issues
          WHERE local_id = 'LOCAL-0001'
        `
      )
      .get() as {
      local_id: string;
      linear_identifier: string | null;
      sync_status: string;
    } | null;

    expect(pending).not.toBeNull();
    expect(pending?.local_id).toBe("LOCAL-0001");
    expect(pending?.linear_identifier).toBeNull();
    expect(pending?.sync_status).toBe("pending");

    const outbox = db
      .query(
        `
          SELECT operation, local_id
          FROM outbox
          WHERE local_id = 'LOCAL-0001'
          LIMIT 1
        `
      )
      .get() as { operation: string; local_id: string } | null;
    db.close();

    expect(outbox).not.toBeNull();
    expect(outbox?.operation).toBe("create");
    expect(outbox?.local_id).toBe("LOCAL-0001");
  });
});
