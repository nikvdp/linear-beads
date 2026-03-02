import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURE_DIR = join(import.meta.dir, "fixtures", "pre-localid");
const FIXTURE_ARCHIVE = join(FIXTURE_DIR, "pre-localid-pending-outbox.tar.gz");
const FIXTURE_NAME = "pre-localid-pending-outbox";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function extractFixture(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lb-schema-race-"));
  tempDirs.push(tempDir);

  const untar = Bun.spawnSync(["tar", "-xzf", FIXTURE_ARCHIVE, "-C", tempDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (untar.exitCode !== 0) {
    const stderr = untar.stderr ? Buffer.from(untar.stderr).toString("utf8") : "";
    throw new Error(`Failed to extract fixture: ${stderr}`);
  }

  return join(tempDir, FIXTURE_NAME);
}

function createLegacyV1Repo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "lb-schema-v1-race-"));
  tempDirs.push(repoDir);

  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    const stderr = init.stderr ? Buffer.from(init.stderr).toString("utf8") : "";
    throw new Error(`Failed to initialize repo: ${stderr}`);
  }

  mkdirSync(join(repoDir, ".lb"), { recursive: true });
  writeFileSync(join(repoDir, ".lb", "config.jsonc"), `${JSON.stringify({ local_only: true })}\n`);

  const dbPath = join(repoDir, ".lb", "cache.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE issues (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      issue_type TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      assignee TEXT,
      linear_state_id TEXT,
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    PRAGMA user_version = 1;
  `);
  db.close();

  return repoDir;
}

async function runLb(cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, "list", "--all", "--json"], {
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

describe("schema migration concurrency", () => {
  test("parallel startup calls do not race during legacy schema migration", async () => {
    const repoDir = extractFixture();

    const [a, b] = await Promise.all([runLb(repoDir), runLb(repoDir)]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stderr).toBe("");
    expect(b.stderr).toBe("");

    const dbPath = join(repoDir, ".lb", "cache.db");
    const db = new Database(dbPath, { readonly: true });
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    const outboxColumns = db.query("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
    db.close();

    expect(version.user_version).toBe(7);
    expect(outboxColumns.some((column) => column.name === "remote_issue_identifier")).toBe(true);

    // Ensure the command output is valid JSON (no half-migrated crash output).
    expect(Array.isArray(JSON.parse(a.stdout))).toBe(true);
    expect(Array.isArray(JSON.parse(b.stdout))).toBe(true);
  });

  test("parallel startup calls safely apply legacy add-column migrations", async () => {
    const repoDir = createLegacyV1Repo();

    const [a, b] = await Promise.all([runLb(repoDir), runLb(repoDir)]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stderr).toBe("");
    expect(b.stderr).toBe("");

    const dbPath = join(repoDir, ".lb", "cache.db");
    const db = new Database(dbPath, { readonly: true });
    const version = db.query("PRAGMA user_version").get() as { user_version: number };
    const outboxColumns = db.query("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
    db.close();

    expect(version.user_version).toBe(7);
    const columnNames = outboxColumns.map((column) => column.name);
    expect(columnNames).toContain("local_id");
    expect(columnNames).toContain("processing");
    expect(columnNames).toContain("processing_started_at");
    expect(columnNames).toContain("next_attempt_at");
    expect(columnNames).toContain("remote_issue_identifier");
  });
});
